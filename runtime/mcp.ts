/**
 * Local MCP server for vibe-vibe experiences.
 * Stdio transport — talks to the local Express server at http://localhost:4321.
 *
 * 4 tools: room, watch, act, memory
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_URL = process.env.VIBEVIBES_SERVER_URL || "http://localhost:4321";

// ── State ──────────────────────────────────────────────────

let currentRoomId: string | null = null;
let currentActorId: string | null = null;
let lastEventTs = 0;

// ── Helpers ────────────────────────────────────────────────

async function fetchJSON(path: string, opts?: RequestInit): Promise<any> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts?.headers },
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Server returned non-JSON: ${text.slice(0, 200)}`);
  }
}

function formatToolList(tools: any[]): string {
  if (!tools?.length) return "No tools available.";
  return tools
    .map((t: any) => {
      const schema = t.input_schema?.properties
        ? Object.entries(t.input_schema.properties)
            .map(([k, v]: [string, any]) => `${k}: ${v.type || "any"}`)
            .join(", ")
        : "{}";
      return `  ${t.name} (${t.risk || "low"}) — ${t.description}\n    input: { ${schema} }`;
    })
    .join("\n");
}

// ── MCP Server ─────────────────────────────────────────────

const server = new McpServer({
  name: "vibevibes-local",
  version: "1.0.0",
});

// ── Tool: room ─────────────────────────────────────────────

server.tool(
  "room",
  `Enter a room, inspect its state, or re-sync the experience.

Actions:
  open  — Create a room and join it. Returns tools, state, and browser URL.
  state — Get current shared state + participants for a room.
  sync  — Re-bundle src/index.tsx and hot-reload all rooms.`,
  {
    action: z.enum(["open", "state", "sync"]).describe("What to do"),
    roomId: z.string().optional().describe("Room ID (for state action)"),
  },
  async ({ action, roomId }) => {
    if (action === "open") {
      // Create room
      const room = await fetchJSON("/rooms", { method: "POST" });
      if (room.error) {
        return { content: [{ type: "text" as const, text: `Error: ${room.error}` }] };
      }

      // Join room
      const join = await fetchJSON(`/rooms/${room.roomId}/join`, {
        method: "POST",
        body: JSON.stringify({ username: "claude", actorType: "ai" }),
      });

      currentRoomId = room.roomId;
      currentActorId = join.actorId;
      lastEventTs = Date.now();

      const output = [
        `Joined room ${room.roomId} as ${join.actorId}`,
        `Experience: ${join.experienceId}`,
        `Browser: ${join.browserUrl}`,
        ``,
        `State: ${JSON.stringify(join.sharedState, null, 2)}`,
        `Participants: ${join.participants?.join(", ")}`,
        ``,
        `Tools:`,
        formatToolList(join.tools),
      ].join("\n");

      return { content: [{ type: "text" as const, text: output }] };
    }

    if (action === "state") {
      const rid = roomId || currentRoomId;
      if (!rid) {
        return { content: [{ type: "text" as const, text: "No room ID. Use `room open` first or provide roomId." }] };
      }
      const data = await fetchJSON(`/rooms/${rid}`);
      if (data.error) {
        return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };
      }
      const output = [
        `Room: ${data.roomId}`,
        `State: ${JSON.stringify(data.sharedState, null, 2)}`,
        `Participants: ${data.participants?.join(", ")}`,
        `Events: ${data.events?.length ?? 0}`,
      ].join("\n");
      return { content: [{ type: "text" as const, text: output }] };
    }

    if (action === "sync") {
      const data = await fetchJSON("/sync", { method: "POST" });
      if (data.error) {
        return { content: [{ type: "text" as const, text: `Sync failed: ${data.error}` }] };
      }
      return { content: [{ type: "text" as const, text: `Synced: ${data.title}` }] };
    }

    return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }] };
  },
);

// ── Tool: watch ────────────────────────────────────────────

server.tool(
  "watch",
  `Long-poll for activity in a joined room. Blocks until events arrive, predicate matches, or timeout.

Use predicate to wait for specific conditions, e.g. "state.count > 5".
Use filterTools/filterActors to only wake for specific events.`,
  {
    roomId: z.string().optional().describe("Room ID (defaults to current room)"),
    timeout: z.number().optional().describe("Max wait ms (default 30000, max 55000)"),
    predicate: z.string().optional().describe("JS expression evaluated against { state, actorId }"),
    filterTools: z.array(z.string()).optional().describe("Only wake for events from these tools"),
    filterActors: z.array(z.string()).optional().describe("Only wake for events from these actors"),
  },
  async ({ roomId, timeout, predicate, filterTools, filterActors }) => {
    const rid = roomId || currentRoomId;
    if (!rid) {
      return { content: [{ type: "text" as const, text: "No room ID. Use `room open` first." }] };
    }

    const t = Math.min(timeout || 30000, 55000);

    // Check if predicate already matches
    if (predicate) {
      try {
        const current = await fetchJSON(`/rooms/${rid}`);
        const fn = new Function("state", "actorId", `return ${predicate}`);
        if (fn(current.sharedState, currentActorId)) {
          return {
            content: [{
              type: "text" as const,
              text: [
                `Predicate already true: ${predicate}`,
                `State: ${JSON.stringify(current.sharedState, null, 2)}`,
                `Participants: ${current.participants?.join(", ")}`,
              ].join("\n"),
            }],
          };
        }
      } catch {
        // Predicate eval failed, continue to long-poll
      }
    }

    // Long-poll for events
    const data = await fetchJSON(
      `/rooms/${rid}/events?since=${lastEventTs}&timeout=${t}`
    );

    let events = data.events || [];

    // Filter by tools
    if (filterTools?.length) {
      events = events.filter((e: any) => filterTools.includes(e.tool));
    }

    // Filter by actors
    if (filterActors?.length) {
      events = events.filter((e: any) => filterActors.includes(e.actorId));
    }

    // Update last event timestamp
    if (events.length > 0) {
      lastEventTs = Math.max(...events.map((e: any) => e.ts));
    }

    // Evaluate predicate
    let predicateMatched = false;
    if (predicate) {
      try {
        const fn = new Function("state", "actorId", `return ${predicate}`);
        predicateMatched = !!fn(data.sharedState, currentActorId);
      } catch {
        // ignore
      }
    }

    const parts: string[] = [];
    if (events.length > 0) {
      parts.push(`${events.length} event(s):`);
      for (const e of events) {
        parts.push(`  [${e.actorId}] ${e.tool}(${JSON.stringify(e.input)}) → ${e.error ? `ERROR: ${e.error}` : JSON.stringify(e.output)}`);
      }
    } else {
      parts.push("No new events (timeout).");
    }

    parts.push(`State: ${JSON.stringify(data.sharedState, null, 2)}`);
    parts.push(`Participants: ${data.participants?.join(", ")}`);

    if (predicate) {
      parts.push(`Predicate "${predicate}": ${predicateMatched}`);
    }

    return { content: [{ type: "text" as const, text: parts.join("\n") }] };
  },
);

// ── Tool: act ──────────────────────────────────────────────

server.tool(
  "act",
  `Execute a tool in a room to mutate shared state. All state changes go through the tool gate.`,
  {
    roomId: z.string().optional().describe("Room ID (defaults to current room)"),
    toolName: z.string().describe("Tool to call, e.g. 'counter.increment'"),
    input: z.record(z.any()).optional().describe("Tool input parameters"),
  },
  async ({ roomId, toolName, input }) => {
    const rid = roomId || currentRoomId;
    if (!rid) {
      return { content: [{ type: "text" as const, text: "No room ID. Use `room open` first." }] };
    }

    const result = await fetchJSON(`/rooms/${rid}/tools/${toolName}`, {
      method: "POST",
      body: JSON.stringify({
        actorId: currentActorId || "mcp-client",
        input: input || {},
      }),
    });

    if (result.error) {
      return { content: [{ type: "text" as const, text: `Tool error: ${result.error}` }] };
    }

    // Get updated state
    const state = await fetchJSON(`/rooms/${rid}`);

    const output = [
      `${toolName} → ${JSON.stringify(result.output)}`,
      `State: ${JSON.stringify(state.sharedState, null, 2)}`,
    ].join("\n");

    return { content: [{ type: "text" as const, text: output }] };
  },
);

// ── Tool: memory ───────────────────────────────────────────

server.tool(
  "memory",
  `Persistent agent memory (per-session). Survives across tool calls within a session.

Actions:
  get — Retrieve current memory
  set — Merge updates into memory`,
  {
    action: z.enum(["get", "set"]).describe("What to do"),
    updates: z.record(z.any()).optional().describe("Memory updates to merge (for set)"),
  },
  async ({ action, updates }) => {
    const key = currentRoomId && currentActorId
      ? `${currentRoomId}:${currentActorId}`
      : "default";

    if (action === "get") {
      const data = await fetchJSON(`/memory?key=${encodeURIComponent(key)}`);
      return {
        content: [{
          type: "text" as const,
          text: `Memory: ${JSON.stringify(data, null, 2)}`,
        }],
      };
    }

    if (action === "set") {
      if (!updates || Object.keys(updates).length === 0) {
        return { content: [{ type: "text" as const, text: "No updates provided." }] };
      }
      await fetchJSON("/memory", {
        method: "POST",
        body: JSON.stringify({ key, updates }),
      });
      return { content: [{ type: "text" as const, text: `Memory updated: ${JSON.stringify(updates)}` }] };
    }

    return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }] };
  },
);

// ── Start ──────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server failed:", err);
  process.exit(1);
});
