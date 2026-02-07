/**
 * Local MCP server for vibe-vibe experiences.
 * Stdio transport — talks to the local Express server at http://localhost:4321.
 *
 * 4 tools: connect, watch, act, memory
 *
 * No room management — the agent auto-joins whatever room is active locally.
 * If no room exists, one is created. If a room is already open in the browser,
 * the agent joins that one. The room concept is invisible to the agent.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_URL = process.env.VIBEVIBES_SERVER_URL || "http://localhost:4321";

// ── State ──────────────────────────────────────────────────

let currentRoomId: string | null = null;
let currentActorId: string | null = null;
let lastEventTs = 0;
let connected = false;

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

/**
 * Find or create a room, then join it.
 *
 * 1. GET /rooms — prefer a room with participants (browser is there).
 * 2. Fallback to the first room that exists.
 * 3. No rooms at all? Create one.
 */
async function autoJoin(): Promise<any> {
  const roomList = await fetchJSON("/rooms");

  let targetRoomId: string | null = null;

  if (Array.isArray(roomList) && roomList.length > 0) {
    const occupied = roomList.find((r: any) => r.participants?.length > 0);
    targetRoomId = occupied?.roomId ?? roomList[0].roomId;
  }

  if (!targetRoomId) {
    const created = await fetchJSON("/rooms", { method: "POST" });
    if (created.error) throw new Error(created.error);
    targetRoomId = created.roomId;
  }

  const join = await fetchJSON(`/rooms/${targetRoomId}/join`, {
    method: "POST",
    body: JSON.stringify({ username: "claude", actorType: "ai" }),
  });

  if (join.error) throw new Error(join.error);

  currentRoomId = targetRoomId;
  currentActorId = join.actorId;
  lastEventTs = Date.now();
  connected = true;

  return join;
}

/** Ensure we're connected. If not, auto-join. */
async function ensureConnected(): Promise<string> {
  if (currentRoomId && connected) return currentRoomId;
  await autoJoin();
  return currentRoomId!;
}

// ── MCP Server ─────────────────────────────────────────────

const server = new McpServer({
  name: "vibevibes-local",
  version: "2.0.0",
});

// ── Tool: connect ──────────────────────────────────────────

server.tool(
  "connect",
  `Connect to the running experience. Auto-joins whichever room is active locally.
If a browser tab is open, you'll join that room. If no rooms exist, one is created.

Returns: available tools, current state, participants, and the browser URL.

Call this first before using watch or act.`,
  {},
  async () => {
    try {
      const join = await autoJoin();

      const output = [
        `Connected as ${currentActorId}`,
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
    } catch (err: any) {
      return {
        content: [{
          type: "text" as const,
          text: `Failed to connect. Is the dev server running? (npm run dev)\n\nError: ${err.message}`,
        }],
      };
    }
  },
);

// ── Tool: watch ────────────────────────────────────────────

server.tool(
  "watch",
  `Wait for activity in the experience. Blocks until events arrive or timeout.

Use predicate to wait for a condition, e.g. "state.count > 5".
Use filterTools to only wake for specific tools, e.g. ["pixel.place"].
Use filterActors to only wake for specific actors.

Auto-connects if not already connected.`,
  {
    timeout: z.number().optional().describe("Max wait ms (default 30000, max 55000)"),
    predicate: z.string().optional().describe('JS expression, e.g. "state.count > 5"'),
    filterTools: z.array(z.string()).optional().describe("Only wake for these tools"),
    filterActors: z.array(z.string()).optional().describe("Only wake for these actors"),
  },
  async ({ timeout, predicate, filterTools, filterActors }) => {
    let rid: string;
    try {
      rid = await ensureConnected();
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Not connected: ${err.message}` }] };
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

    if (filterTools?.length) {
      events = events.filter((e: any) => filterTools.includes(e.tool));
    }
    if (filterActors?.length) {
      events = events.filter((e: any) => filterActors.includes(e.actorId));
    }

    if (events.length > 0) {
      lastEventTs = Math.max(...events.map((e: any) => e.ts));
    }

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
  `Execute a tool to mutate shared state. All state changes go through tools.

Example: act(toolName="counter.increment", input={amount: 2})

Auto-connects if not already connected.`,
  {
    toolName: z.string().describe("Tool to call, e.g. 'counter.increment'"),
    input: z.record(z.any()).optional().describe("Tool input parameters"),
  },
  async ({ toolName, input }) => {
    let rid: string;
    try {
      rid = await ensureConnected();
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Not connected: ${err.message}` }] };
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
  `Persistent agent memory (per-session). Survives across tool calls.

Actions:
  get — Retrieve current memory
  set — Merge updates into memory`,
  {
    action: z.enum(["get", "set"]).describe("What to do"),
    updates: z.record(z.any()).optional().describe("Key-value pairs to merge (for set)"),
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
