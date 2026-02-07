# create-experience — LLM Reference

> You are building a **vibe-vibe experience**: a shared interactive app where humans (in the browser) and AI agents (via MCP tools) collaborate in real-time through a shared state managed by tools.

## IMPORTANT: Use the LOCAL MCP tools

This project registers a **local** MCP server (`vibevibes-local` in `.mcp.json`). It exposes 4 tools: `connect`, `watch`, `act`, `memory`. These talk to the **local dev server** at http://localhost:4321.

**DO NOT** use the hosted platform MCP tools (`vibevibes_list_experiences`, `vibevibes_create_room`, `vibevibes_execute_tool`, etc.) — those talk to the cloud. You want the local ones.

---

## Project Structure

```
src/index.tsx          <- YOUR EXPERIENCE. This is the only file you edit.
runtime/               <- Local dev runtime. Don't modify.
  server.ts            <- Express + WebSocket server
  mcp.ts               <- Local MCP server (4 tools)
  bundler.ts            <- esbuild bundler
  viewer/index.html     <- Browser viewer
vibevibes.json         <- Experience ID + platform URL
.mcp.json              <- Auto-registers local MCP with Claude Code
```

---

## Commands

```bash
npm run dev                  # Start local server on http://localhost:4321
npm run build                # Bundle (check for errors)
npm run publish:experience   # Upload to hosted platform
```

---

## Agent Loop (interacting with a running experience)

```
1. connect          -> Auto-joins the active room (or creates one). Returns tools, state, browser URL.
                      No room IDs to manage — it finds the right room automatically.

2. watch            -> Long-poll for events. Blocks until activity or timeout.
                      Use predicate: "state.count > 5"
                      Use filterTools: ["pixel.place"]
                      Use filterActors: ["alice-human-1"]

3. act              -> Execute a tool: act(toolName="counter.increment", input={amount: 2})
                      All state mutations go through tools. Never set state directly.

4. memory get/set   -> Persistent per-session agent memory.
```

`watch` and `act` auto-connect if you haven't called `connect` yet.

---

## Building an Experience (src/index.tsx)

An experience exports three things via `defineExperience`:

```tsx
import { defineExperience, defineTool } from "@vibevibes/sdk";
import { z } from "zod";
import React from "react";

export default defineExperience({
  manifest: {
    id: "my-experience",
    version: "0.0.1",
    title: "My Experience",
    description: "What this does",
    requested_capabilities: [],
  },
  Canvas,   // React component — renders the UI
  tools,    // Array of ToolDef — mutate shared state
});
```

### Canvas Component

The Canvas is a React component that receives these props:

```tsx
type CanvasProps = {
  roomId: string;
  actorId: string;                              // Your actor ID (e.g. "alice-human-1")
  sharedState: Record<string, any>;             // Current shared state (read-only, mutate via callTool)
  callTool: (name: string, input: any) => Promise<any>;  // Call a tool to mutate state
  participants: string[];                       // List of actor IDs in the room
  ephemeralState: Record<string, Record<string, any>>;   // Per-actor ephemeral data
  setEphemeral: (data: Record<string, any>) => void;     // Set your ephemeral data
};
```

**Example:**

```tsx
const Canvas: React.FC<CanvasProps> = ({ sharedState, callTool, participants }) => {
  const count = sharedState.count || 0;

  return (
    <div style={{ padding: 32, textAlign: "center" }}>
      <h1>Count: {count}</h1>
      <button onClick={() => callTool("counter.increment", { amount: 1 })}>
        +1
      </button>
      <p>{participants.length} participant(s)</p>
    </div>
  );
};
```

### Tools

Tools are the **only** way to mutate shared state. Define them with `defineTool`:

```tsx
const tools = [
  defineTool({
    name: "counter.increment",
    description: "Add to the counter",
    input_schema: z.object({
      amount: z.number().default(1).describe("Amount to add"),
    }),
    handler: async (ctx, input) => {
      const newCount = (ctx.state.count || 0) + input.amount;
      ctx.setState({ ...ctx.state, count: newCount });
      return { count: newCount };
    },
  }),
];
```

**Tool handler context (`ctx`):**

```tsx
type ToolCtx = {
  roomId: string;
  actorId: string;                    // Who called this tool
  owner?: string;                     // Owner extracted from actorId
  state: Record<string, any>;        // Current shared state (READ)
  setState: (s: Record<string, any>) => void;  // Set new state (WRITE)
  timestamp: number;                  // Current time
  memory: Record<string, any>;       // Agent's persistent memory
  setMemory: (updates: Record<string, any>) => void;
};
```

**Shorthand with `quickTool`:**

```tsx
quickTool("counter.reset", "Reset counter to zero", z.object({}), async (ctx) => {
  ctx.setState({ ...ctx.state, count: 0 });
  return { count: 0 };
});
```

### Available Hooks

Import from `@vibevibes/sdk`:

| Hook | Signature | Purpose |
|------|-----------|---------|
| `useToolCall` | `(callTool) => { call, loading, error }` | Wraps callTool with loading/error tracking |
| `useSharedState` | `(sharedState, key, default?) => value` | Typed accessor for a state key |
| `useOptimisticTool` | `(callTool, sharedState) => { call, state, pending }` | Optimistic updates with rollback |
| `useParticipants` | `(participants) => ParsedParticipant[]` | Parse participant IDs into `{ id, username, type, index }` |
| `useAnimationFrame` | `(sharedState, interpolate?) => displayState` | Buffer state updates to animation frames |
| `useFollow` | `(actorId, participants, ephemeral, setEphemeral) => { follow, unfollow, following, followers }` | Follow-mode protocol |
| `useTypingIndicator` | `(actorId, ephemeral, setEphemeral) => { setTyping, typingUsers }` | Typing indicators |

### Available Components

Import from `@vibevibes/sdk` (inline-styled, no Tailwind needed):

| Component | Props |
|-----------|-------|
| `Button` | `{ onClick, disabled, variant: 'primary'\|'secondary'\|'danger'\|'ghost', size: 'sm'\|'md'\|'lg', style }` |
| `Card` | `{ title, style }` |
| `Input` | `{ value, onChange: (value) => void, placeholder, type, disabled, style }` |
| `Badge` | `{ color: 'gray'\|'blue'\|'green'\|'red'\|'yellow'\|'purple', style }` |
| `Stack` | `{ direction: 'row'\|'column', gap, align, justify, style }` |
| `Grid` | `{ columns, gap, style }` |

---

## Advanced Features

### Agent Slots (multi-agent rooms)

```tsx
manifest: {
  agentSlots: [
    {
      role: "assistant",
      systemPrompt: "You help users with...",
      allowedTools: ["tool.a", "tool.b"],
      autoSpawn: true,
      maxInstances: 1,
    }
  ]
}
```

### Agent Hints (guide agent behavior)

```tsx
agentHints: [
  {
    trigger: "when a new pixel is placed",
    condition: "state.pixels?.length > 0",
    suggestedTools: ["pixel.place"],
    priority: "medium",
    cooldownMs: 1000,
  }
]
```

### Tests (inline tool handler tests)

```tsx
import { defineTest } from "@vibevibes/sdk";

tests: [
  defineTest({
    name: "increment adds to count",
    run: async ({ tool, ctx, expect }) => {
      const inc = tool("counter.increment");
      const c = ctx({ state: { count: 5 } });
      await inc.handler(c, { amount: 3 });
      expect(c.getState().count).toBe(8);
    },
  }),
]
```

### Manifest Fields

```tsx
type ExperienceManifest = {
  id: string;                          // Unique ID
  version: string;                     // Semver
  title: string;                       // Display name
  description: string;                 // What it does
  requested_capabilities: string[];    // e.g. ["room.spawn"]
  agentSlots?: AgentSlot[];            // Agent role definitions
  category?: string;                   // "game", "tool", etc.
  tags?: string[];                     // Searchable tags
  netcode?: "default" | "tick" | "p2p-ephemeral";  // Sync strategy
  tickRateMs?: number;                 // For tick netcode
  hotKeys?: string[];                  // Keys routed through ephemeral channel
};
```

---

## Rules

1. **All mutations go through tools.** `ctx.setState()` inside a tool handler is the only way to change shared state.
2. **Tools have Zod schemas.** The server validates all inputs. Invalid input = error.
3. **`ctx.setState()` does a shallow merge.** Always spread existing state: `ctx.setState({ ...ctx.state, myKey: newValue })`.
4. **Canvas re-renders on every state change.** Keep renders efficient.
5. **The dev server hot-reloads on save.** Edit `src/index.tsx`, save, see changes instantly in the browser.
6. **You are an actor.** Your actions show up in the event log. Other participants see everything you do.

## Architecture

```
Browser (Canvas)  <--WebSocket-->  Express Server  <--HTTP-->  MCP (Agent)
      |                              |
  callTool(name, input)     validates input (Zod)
                            runs handler(ctx, input)
                            ctx.setState(newState)
                            broadcasts to all clients
```

All state lives on the server. The browser renders it. Tools are the only mutation path. Both humans and agents use the same tools.
