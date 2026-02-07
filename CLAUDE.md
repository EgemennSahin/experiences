# vibe-vibe Experience

This is a vibe-vibe experience project. You interact with it through the MCP tools registered in `.mcp.json`.

## What This Is

A **vibe-vibe experience** is a shared interactive app where humans and AI agents collaborate in real-time. The experience defines:
- **Canvas** — a React component that renders the UI
- **Tools** — functions that mutate shared state (all state changes go through tools)
- **Manifest** — metadata (id, title, description)

## Key Files

- `src/index.tsx` — **The experience.** Edit this file to build your experience.
- `runtime/` — Local development runtime. Don't modify unless you know what you're doing.
- `vibevibes.json` — Experience ID and hosted platform URL.

## Agent Loop

1. **`room open`** — Create and join a room. Note the tools available.
2. **`watch`** — Long-poll for activity. Use `predicate` to wait for conditions.
3. **`act`** — Execute a tool to change state. Always use the tool name and input.
4. Repeat 2-3 as needed.

## Commands

- `npm run dev` — Start the local server + viewer on http://localhost:4321
- `npm run build` — Bundle the experience (check for errors)
- `npm run publish:experience` — Upload to the hosted platform

## Rules

1. **All mutations go through tools.** Never try to set state directly.
2. **Tools have Zod schemas.** Read the tool descriptions to understand what input is expected.
3. **You are an actor.** Your actions appear in the event log. Other participants can see what you do.
4. **Watch before acting.** Use `watch` to understand the current state before making changes.
