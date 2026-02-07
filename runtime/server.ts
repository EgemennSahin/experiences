/**
 * Local vibe-vibe runtime server.
 * In-memory rooms, tool gate, WebSocket broadcasts — no Supabase needed.
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

interface Room {
  roomId: string;
  experienceId: string;
  sharedState: Record<string, any>;
  participants: Map<string, { type: "human" | "ai"; joinedAt: number }>;
  events: ToolEvent[];
  actorCounters: Map<string, number>;
  wsConnections: Set<WebSocket>;
}

// ── State ──────────────────────────────────────────────────

const rooms = new Map<string, Room>();
const agentMemory = new Map<string, Record<string, any>>();

let experience: any = null;
let clientBundle: string = "";
let serverCode: string = "";

// ── Helpers ────────────────────────────────────────────────

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function assignActorId(room: Room, username: string, type: "human" | "ai"): string {
  const prefix = `${username}-${type}`;
  const current = room.actorCounters.get(prefix) || 0;
  const next = current + 1;
  room.actorCounters.set(prefix, next);
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

function broadcastToRoom(room: Room, message: any) {
  const data = JSON.stringify(message);
  for (const ws of room.wsConnections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
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

// ── Room endpoints ─────────────────────────────────────────

// Create room
app.post("/rooms", (_req, res) => {
  if (!experience) {
    res.status(500).json({ error: "Experience not loaded" });
    return;
  }
  const roomId = generateId();
  const room: Room = {
    roomId,
    experienceId: experience.manifest.id,
    sharedState: {},
    participants: new Map(),
    events: [],
    actorCounters: new Map(),
    wsConnections: new Set(),
  };
  rooms.set(roomId, room);
  res.json({ roomId, experienceId: experience.manifest.id });
});

// Get room state
app.get("/rooms/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) { res.status(404).json({ error: "Room not found" }); return; }
  res.json({
    roomId: room.roomId,
    experienceId: room.experienceId,
    sharedState: room.sharedState,
    participants: Array.from(room.participants.keys()),
    events: room.events.slice(-50),
  });
});

// Join room
app.post("/rooms/:roomId/join", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) { res.status(404).json({ error: "Room not found" }); return; }

  const { username = "user", actorType = "human" } = req.body;
  const actorId = assignActorId(room, username, actorType as "human" | "ai");
  room.participants.set(actorId, { type: actorType, joinedAt: Date.now() });

  // Broadcast presence update
  broadcastToRoom(room, {
    type: "presence_update",
    participants: Array.from(room.participants.keys()),
  });

  res.json({
    roomId: room.roomId,
    actorId,
    experienceId: room.experienceId,
    sharedState: room.sharedState,
    participants: Array.from(room.participants.keys()),
    events: room.events.slice(-20),
    tools: getToolList(experience),
    browserUrl: `http://localhost:${PORT}/#${room.roomId}`,
  });
});

// Leave room
app.post("/rooms/:roomId/leave", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) { res.status(404).json({ error: "Room not found" }); return; }
  const { actorId } = req.body;
  room.participants.delete(actorId);
  broadcastToRoom(room, {
    type: "presence_update",
    participants: Array.from(room.participants.keys()),
  });
  res.json({ left: true, actorId });
});

// Execute tool
app.post("/rooms/:roomId/tools/:toolName", async (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) { res.status(404).json({ error: "Room not found" }); return; }
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
    const memoryKey = `${room.experienceId}:${actorId}`;
    const ctx = {
      roomId: room.roomId,
      actorId,
      owner: owner || actorId.split("-")[0],
      state: room.sharedState,
      setState: (newState: Record<string, any>) => {
        room.sharedState = newState;
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
    room.events.push(event);
    if (room.events.length > 200) {
      room.events = room.events.slice(-200);
    }

    // Broadcast state update
    broadcastToRoom(room, {
      type: "shared_state_update",
      roomId: room.roomId,
      state: room.sharedState,
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
    room.events.push(event);
    res.status(400).json({ error: errorMsg });
  }
});

// Get events (supports long-poll via ?timeout=N)
app.get("/rooms/:roomId/events", async (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) { res.status(404).json({ error: "Room not found" }); return; }

  const since = parseInt(req.query.since as string) || 0;
  const timeout = Math.min(parseInt(req.query.timeout as string) || 0, 55000);

  const getNewEvents = () => room.events.filter((e) => e.ts > since);

  let events = getNewEvents();
  if (events.length > 0 || timeout === 0) {
    res.json({
      events,
      sharedState: room.sharedState,
      participants: Array.from(room.participants.keys()),
    });
    return;
  }

  // Long-poll: wait for events or timeout
  const start = Date.now();
  const interval = setInterval(() => {
    events = getNewEvents();
    if (events.length > 0 || Date.now() - start >= timeout) {
      clearInterval(interval);
      res.json({
        events,
        sharedState: room.sharedState,
        participants: Array.from(room.participants.keys()),
      });
    }
  }, 200);

  // Cleanup on client disconnect
  req.on("close", () => clearInterval(interval));
});

// Serve client bundle
app.get("/rooms/:roomId/bundle", (_req, res) => {
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
    // Notify all rooms
    for (const room of rooms.values()) {
      broadcastToRoom(room, { type: "experience_updated" });
    }
    res.json({ synced: true, title: experience?.manifest?.title });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── List rooms ─────────────────────────────────────────────

app.get("/rooms", (_req, res) => {
  const list = Array.from(rooms.values()).map((r) => ({
    roomId: r.roomId,
    experienceId: r.experienceId,
    participants: Array.from(r.participants.keys()),
    eventCount: r.events.length,
  }));
  res.json(list);
});

// ── Start server ───────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "4321");

export async function startServer() {
  await loadExperience();

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    let joinedRoom: Room | null = null;

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "join" && msg.roomId) {
          const room = rooms.get(msg.roomId);
          if (room) {
            joinedRoom = room;
            room.wsConnections.add(ws);

            // If this is a human viewer, assign actor ID and add to participants
            const username = msg.username || "viewer";
            const actorId = assignActorId(room, username, "human");
            room.participants.set(actorId, { type: "human", joinedAt: Date.now() });

            // Send initial state
            ws.send(JSON.stringify({
              type: "joined",
              roomId: room.roomId,
              actorId,
              sharedState: room.sharedState,
              participants: Array.from(room.participants.keys()),
              events: room.events.slice(-20),
            }));

            // Broadcast presence update to others
            broadcastToRoom(room, {
              type: "presence_update",
              participants: Array.from(room.participants.keys()),
            });
          }
        }
      } catch {
        // Ignore invalid messages
      }
    });

    ws.on("close", () => {
      if (joinedRoom) {
        joinedRoom.wsConnections.delete(ws);
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
        for (const room of rooms.values()) {
          broadcastToRoom(room, { type: "experience_updated" });
        }
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
    console.log(`  API:     http://localhost:${PORT}/rooms`);
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
