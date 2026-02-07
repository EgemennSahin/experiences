# create-experience

Build [vibe-vibe](https://vibevibes.app) experiences locally. One human + AI agents, zero cloud.

## Quick Start

```bash
git clone https://github.com/vibevibes/create-experience.git my-experience
cd my-experience
npm install
npm run dev
```

Open http://localhost:4321 in your browser — you're the human player. The dev server hot-reloads on save.

## Add an AI Agent

This project includes a local MCP server (`.mcp.json`) that auto-registers with Claude Code. Open the project in Claude Code and the agent gets 4 tools:

| Tool | Purpose |
|------|---------|
| `connect` | Auto-join the active room (or create one). Returns tools, state, browser URL |
| `watch` | Long-poll for activity from other participants |
| `act` | Execute a tool to change shared state |
| `memory` | Persist data across tool calls within a session |

No room IDs to manage — the agent automatically joins whichever room the browser has open.

**Typical agent loop:** `connect` -> `watch` -> `act` -> repeat.

## Build Your Experience

Edit `src/index.tsx`. That's the only file you need to touch. It exports three things:

```tsx
import { defineExperience, defineTool } from "@vibevibes/sdk";
import { z } from "zod";
import React from "react";

export default defineExperience({
  manifest: {
    id: "my-experience",
    version: "0.0.1",
    title: "My Experience",
    description: "What it does",
    requested_capabilities: [],
  },
  Canvas,   // React component — renders the UI
  tools,    // Array of tools — mutate shared state
});
```

### Canvas

A React component that receives:

| Prop | Type | Description |
|------|------|-------------|
| `roomId` | `string` | Current room ID |
| `actorId` | `string` | Your actor ID (e.g. `"alice-human-1"`) |
| `sharedState` | `Record<string, any>` | Current shared state (read-only from here) |
| `callTool` | `(name, input) => Promise<any>` | Call a tool to mutate state |
| `participants` | `string[]` | Actor IDs of everyone in the room |
| `ephemeralState` | `Record<string, Record<string, any>>` | Per-actor ephemeral data |
| `setEphemeral` | `(data) => void` | Set your ephemeral data |

Render your UI based on `sharedState`. Trigger changes with `callTool("toolName", input)`.

### Tools

Tools are the **only** way to mutate shared state. Each tool has a name, Zod input schema, and a handler:

```tsx
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
})
```

The handler receives `ctx` with:
- `ctx.state` — current shared state
- `ctx.setState(newState)` — set new state (shallow merge, always spread existing)
- `ctx.actorId` — who called the tool
- `ctx.roomId`, `ctx.timestamp`, `ctx.memory`, `ctx.setMemory()`

Shorthand: `quickTool(name, description, zodSchema, handler)`.

### Hooks

| Hook | Usage | Purpose |
|------|-------|---------|
| `useToolCall(callTool)` | `{ call, loading, error }` | Loading/error tracking |
| `useSharedState(sharedState, key, default?)` | `value` | Typed state accessor |
| `useOptimisticTool(callTool, sharedState)` | `{ call, state, pending }` | Optimistic updates |
| `useParticipants(participants)` | `ParsedParticipant[]` | Parse actor IDs |
| `useAnimationFrame(sharedState, interpolate?)` | `displayState` | Frame-rate buffering |

### Components

Inline-styled components (no Tailwind dependency):

`Button`, `Card`, `Input`, `Badge`, `Stack`, `Grid`

Import from `@vibevibes/sdk`.

## Publish

```bash
npm run publish:experience
```

Uploads `src/index.tsx` to the hosted platform. Same file runs identically in both environments.

## How It Works

All state lives on the server. All mutations go through tools — no direct state setting. When a tool is called (by a human clicking a button or an agent calling `act`), the server validates input against the Zod schema, runs the handler, updates state, and broadcasts to all connected clients via WebSocket.

```
Browser (Canvas)  <--WebSocket-->  Server  <--HTTP-->  MCP (Agent)
```

This is the same architecture as the hosted platform, just single-room and local.

## Project Structure

```
src/index.tsx          — Your experience (edit this)
runtime/server.ts      — Local Express + WebSocket server
runtime/bundler.ts     — esbuild bundler (server + client builds)
runtime/viewer/        — Browser UI
runtime/mcp.ts         — Local MCP server for AI agents
scripts/dev.ts         — Dev server entry
scripts/publish.ts     — Publish to hosted platform
vibevibes.json         — Experience ID + platform URL
.mcp.json              — Auto-registers MCP server with Claude Code
CLAUDE.md              — Full SDK reference for LLMs
```
