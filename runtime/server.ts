/**
 * Local vibe-vibe runtime server.
 * Single shared room, tool gate, WebSocket broadcasts — no Supabase needed.
 *
 * There is exactly one room. Opening localhost:4321 puts you in it.
 * Refreshing the page cleans up the old participant and creates a new one.
 * AI agents join the same room via MCP or HTTP.
 */

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { buildExperience, bundleForServer } from "./bundler.js";
import { zodToJsonSchema } from "zod-to-json-schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ── Types ──────────────────────────────────────────────────

interface ToolEvent {
  id: string;
  ts: number;
  actorId: string;
  owner?: string;
  tool: string;
  input: any;
  output?: any;
  error?: string;
}

// ── State (single room) ────────────────────────────────────

const ROOM_ID = "local";

let sharedState: Record<string, any> = {};
const participants = new Map<string, { type: "human" | "ai"; joinedAt: number }>();
let events: ToolEvent[] = [];
const actorCounters = new Map<string, number>();
const wsConnections = new Map<WebSocket, string>(); // ws → actorId

const agentMemory = new Map<string, Record<string, any>>();

let experience: any = null;
let clientBundle: string = "";
let serverCode: string = "";

// ── Helpers ────────────────────────────────────────────────

function assignActorId(username: string, type: "human" | "ai"): string {
  const prefix = `${username}-${type}`;
  const current = actorCounters.get(prefix) || 0;
  const next = current + 1;
  actorCounters.set(prefix, next);
  return `${prefix}-${next}`;
}

function getToolList(exp: any): any[] {
  if (!exp?.tools) return [];
  return exp.tools.map((t: any) => ({
    name: t.name,
    description: t.description,
    risk: t.risk || "low",
    input_schema: t.input_schema ? zodToJsonSchema(t.input_schema) : {},
  }));
}

function broadcastToAll(message: any) {
  const data = JSON.stringify(message);
  for (const ws of wsConnections.keys()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function participantList(): string[] {
  return Array.from(participants.keys());
}

// ── Load experience ────────────────────────────────────────

async function loadExperience() {
  try {
    const result = await buildExperience();
    clientBundle = result.clientCode;
    serverCode = result.serverCode;

    // Eval to extract tools + manifest
    const { defineExperience, defineTool, defineTest } = await import("@vibevibes/sdk");
    const stubReact = { createElement: () => null, Fragment: "Fragment" };
    const zodModule = await import("zod");
    const z = zodModule.z ?? zodModule.default ?? zodModule;

    const fn = new Function(
      "React", "Y", "z",
      "defineExperience", "defineTool", "defineTest",
      "require", "exports", "module", "console",
      `"use strict";\n${serverCode}\nreturn typeof __experience_export__ !== 'undefined' ? __experience_export__ : undefined;`
    );

    const fakeModule = { exports: {} as any };
    const result2 = fn(
      stubReact, {}, z,
      defineExperience, defineTool, defineTest,
      () => ({}), fakeModule.exports, fakeModule, console,
    );

    experience = result2?.default ?? result2 ?? fakeModule.exports?.default ?? fakeModule.exports;

    if (!experience?.manifest || !experience?.tools) {
      throw new Error("Experience module missing manifest or tools");
    }

    console.log(`Loaded: ${experience.manifest.title} (${experience.tools.length} tools)`);
    return experience;
  } catch (err: any) {
    console.error("Failed to load experience:", err.message);
    throw err;
  }
}

// ── Express app ────────────────────────────────────────────

const app = express();
app.use(express.json());

// CORS for local development
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (_req.method === "OPTIONS") { res.sendStatus(200); return; }
  next();
});

// Serve viewer
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "viewer", "index.html"));
});
app.use("/viewer", express.static(path.join(__dirname, "viewer")));

// ── Room state endpoint ────────────────────────────────────

app.get("/state", (_req, res) => {
  res.json({
    roomId: ROOM_ID,
    experienceId: experience?.manifest?.id ?? "unknown",
    sharedState,
    participants: participantList(),
    events: events.slice(-50),
  });
});

// ── Join ────────────────────────────────────────────────────

function handleJoin(req: express.Request, res: express.Response) {
  if (!experience) {
    res.status(500).json({ error: "Experience not loaded" });
    return;
  }

  const { username = "user", actorType = "human" } = req.body;
  const actorId = assignActorId(username, actorType as "human" | "ai");
  participants.set(actorId, { type: actorType, joinedAt: Date.now() });

  // Broadcast presence update
  broadcastToAll({
    type: "presence_update",
    participants: participantList(),
  });

  res.json({
    roomId: ROOM_ID,
    actorId,
    experienceId: experience.manifest.id,
    sharedState,
    participants: participantList(),
    events: events.slice(-20),
    tools: getToolList(experience),
    browserUrl: `http://localhost:${PORT}`,
  });
}

app.post("/join", handleJoin);

// ── Leave ───────────────────────────────────────────────────

function handleLeave(req: express.Request, res: express.Response) {
  const { actorId } = req.body;
  participants.delete(actorId);
  broadcastToAll({
    type: "presence_update",
    participants: participantList(),
  });
  res.json({ left: true, actorId });
}

app.post("/leave", handleLeave);

// ── Execute tool ────────────────────────────────────────────

async function handleTool(req: express.Request, res: express.Response) {
  if (!experience) { res.status(500).json({ error: "Experience not loaded" }); return; }

  const toolName = req.params.toolName;
  const { actorId, input = {}, owner } = req.body;

  // Find tool
  const tool = experience.tools.find((t: any) => t.name === toolName);
  if (!tool) {
    res.status(404).json({ error: `Tool '${toolName}' not found` });
    return;
  }

  try {
    // Validate input
    let validatedInput = input;
    if (tool.input_schema?.parse) {
      validatedInput = tool.input_schema.parse(input);
    }

    // Build ToolCtx
    const memoryKey = `${experience.manifest.id}:${actorId}`;
    const ctx = {
      roomId: ROOM_ID,
      actorId,
      owner: owner || actorId.split("-")[0],
      state: sharedState,
      setState: (newState: Record<string, any>) => {
        sharedState = newState;
      },
      timestamp: Date.now(),
      memory: agentMemory.get(memoryKey) || {},
      setMemory: (updates: Record<string, any>) => {
        const current = agentMemory.get(memoryKey) || {};
        agentMemory.set(memoryKey, { ...current, ...updates });
      },
    };

    // Execute handler
    const output = await tool.handler(ctx, validatedInput);

    // Create event
    const event: ToolEvent = {
      id: `${Date.now()}-${actorId}-${Math.random().toString(36).slice(2, 6)}`,
      ts: Date.now(),
      actorId,
      owner: ctx.owner,
      tool: toolName,
      input: validatedInput,
      output,
    };

    // Append event (cap at 200)
    events.push(event);
    if (events.length > 200) {
      events = events.slice(-200);
    }

    // Broadcast state update
    broadcastToAll({
      type: "shared_state_update",
      roomId: ROOM_ID,
      state: sharedState,
      event,
      changedBy: actorId,
      tool: toolName,
    });

    res.json({ output });
  } catch (err: any) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const event: ToolEvent = {
      id: `${Date.now()}-${actorId}-${Math.random().toString(36).slice(2, 6)}`,
      ts: Date.now(),
      actorId,
      tool: toolName,
      input,
      error: errorMsg,
    };
    events.push(event);
    res.status(400).json({ error: errorMsg });
  }
}

app.post("/tools/:toolName", handleTool);

// ── Get events (supports long-poll via ?timeout=N) ─────────

app.get("/events", async (req, res) => {
  const since = parseInt(req.query.since as string) || 0;
  const timeout = Math.min(parseInt(req.query.timeout as string) || 0, 55000);

  const getNewEvents = () => events.filter((e) => e.ts > since);

  let newEvents = getNewEvents();
  if (newEvents.length > 0 || timeout === 0) {
    res.json({
      events: newEvents,
      sharedState,
      participants: participantList(),
    });
    return;
  }

  // Long-poll: wait for events or timeout
  const start = Date.now();
  const interval = setInterval(() => {
    newEvents = getNewEvents();
    if (newEvents.length > 0 || Date.now() - start >= timeout) {
      clearInterval(interval);
      res.json({
        events: newEvents,
        sharedState,
        participants: participantList(),
      });
    }
  }, 200);

  // Cleanup on client disconnect
  req.on("close", () => clearInterval(interval));
});

// ── Serve client bundle ────────────────────────────────────

app.get("/bundle", (_req, res) => {
  res.setHeader("Content-Type", "text/javascript");
  res.send(clientBundle);
});

// ── Memory endpoints ───────────────────────────────────────

app.get("/memory", (req, res) => {
  const key = req.query.key as string;
  if (!key) { res.json({}); return; }
  res.json(agentMemory.get(key) || {});
});

app.post("/memory", (req, res) => {
  const { key, updates } = req.body;
  if (!key) { res.status(400).json({ error: "key required" }); return; }
  const current = agentMemory.get(key) || {};
  agentMemory.set(key, { ...current, ...updates });
  res.json({ saved: true });
});

// ── Sync (re-bundle) ──────────────────────────────────────

app.post("/sync", async (_req, res) => {
  try {
    await loadExperience();
    broadcastToAll({ type: "experience_updated" });
    res.json({ synced: true, title: experience?.manifest?.title });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Backwards-compat: room-based routes redirect to single room ──

app.get("/rooms", (_req, res) => {
  // Return the single room so MCP/agents that still call GET /rooms work
  res.json([{
    roomId: ROOM_ID,
    experienceId: experience?.manifest?.id ?? "unknown",
    participants: participantList(),
    eventCount: events.length,
  }]);
});

app.post("/rooms", (_req, res) => {
  // No-op: return the single room
  res.json({ roomId: ROOM_ID, experienceId: experience?.manifest?.id ?? "unknown" });
});

app.get("/rooms/:roomId", (_req, res) => {
  res.json({
    roomId: ROOM_ID,
    experienceId: experience?.manifest?.id ?? "unknown",
    sharedState,
    participants: participantList(),
    events: events.slice(-50),
  });
});

app.post("/rooms/:roomId/join", handleJoin);

app.post("/rooms/:roomId/leave", handleLeave);

app.post("/rooms/:roomId/tools/:toolName", handleTool);

app.get("/rooms/:roomId/events", (req, res) => {
  // Rewrite to use the same handler inline
  const since = parseInt(req.query.since as string) || 0;
  const timeout = Math.min(parseInt(req.query.timeout as string) || 0, 55000);

  const getNewEvents = () => events.filter((e) => e.ts > since);

  let newEvents = getNewEvents();
  if (newEvents.length > 0 || timeout === 0) {
    res.json({ events: newEvents, sharedState, participants: participantList() });
    return;
  }

  const start = Date.now();
  const interval = setInterval(() => {
    newEvents = getNewEvents();
    if (newEvents.length > 0 || Date.now() - start >= timeout) {
      clearInterval(interval);
      res.json({ events: newEvents, sharedState, participants: participantList() });
    }
  }, 200);
  req.on("close", () => clearInterval(interval));
});

app.get("/rooms/:roomId/bundle", (_req, res) => {
  res.setHeader("Content-Type", "text/javascript");
  res.send(clientBundle);
});

// ── Start server ───────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "4321");

export async function startServer() {
  await loadExperience();

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "join") {
          const username = msg.username || "viewer";
          const actorId = assignActorId(username, "human");
          participants.set(actorId, { type: "human", joinedAt: Date.now() });

          // Track this WS → actorId so we clean up on disconnect
          wsConnections.set(ws, actorId);

          // Send initial state
          ws.send(JSON.stringify({
            type: "joined",
            roomId: ROOM_ID,
            actorId,
            sharedState,
            participants: participantList(),
            events: events.slice(-20),
          }));

          // Broadcast presence update to others
          broadcastToAll({
            type: "presence_update",
            participants: participantList(),
          });
        }
      } catch {
        // Ignore invalid messages
      }
    });

    ws.on("close", () => {
      // Clean up participant when browser tab closes / refreshes
      const actorId = wsConnections.get(ws);
      if (actorId) {
        participants.delete(actorId);
        wsConnections.delete(ws);

        // Broadcast updated presence
        broadcastToAll({
          type: "presence_update",
          participants: participantList(),
        });
      }
    });
  });

  // Watch src/index.tsx for changes
  const srcPath = path.join(PROJECT_ROOT, "src", "index.tsx");
  let debounceTimer: NodeJS.Timeout | null = null;
  fs.watch(srcPath, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      console.log("\nFile changed, rebuilding...");
      try {
        await loadExperience();
        broadcastToAll({ type: "experience_updated" });
        console.log("Hot reload complete.");
      } catch (err: any) {
        console.error("Hot reload failed:", err.message);
      }
    }, 300);
  });

  server.listen(PORT, () => {
    console.log(`\n  vibe-vibe local runtime`);
    console.log(`  ───────────────────────`);
    console.log(`  Viewer:  http://localhost:${PORT}`);
    console.log(`  Watching src/index.tsx for changes\n`);
  });

  return server;
}

// Auto-start if run directly
if (process.argv[1]?.includes("server")) {
  startServer().catch((err) => {
    console.error("Server failed to start:", err);
    process.exit(1);
  });
}
