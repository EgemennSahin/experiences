import React from "react";
import { z } from "zod";
import { defineExperience, defineTool, type CanvasProps } from "@vibevibes/sdk";

const Canvas: React.FC<CanvasProps> = ({ sharedState, callTool, participants, actorId }) => {
  const count = sharedState.count ?? 0;

  return React.createElement("div", {
    style: {
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column" as const,
      alignItems: "center",
      justifyContent: "center",
      background: "#0a0a0a",
      color: "#fff",
      fontFamily: "system-ui, -apple-system, sans-serif",
      gap: "24px",
    },
  },
    React.createElement("h1", {
      style: { fontSize: "2.5rem", fontWeight: 200, letterSpacing: "-0.02em" },
    }, "Counter"),

    React.createElement("div", {
      style: { fontSize: "5rem", fontWeight: 700, color: "#6366f1" },
    }, count),

    React.createElement("div", {
      style: { display: "flex", gap: "12px" },
    },
      React.createElement("button", {
        onClick: () => callTool("counter.decrement", {}),
        style: {
          padding: "12px 24px", fontSize: "1.25rem", background: "#1e293b",
          color: "#fff", border: "1px solid #334155", borderRadius: "8px", cursor: "pointer",
        },
      }, "-"),
      React.createElement("button", {
        onClick: () => callTool("counter.increment", {}),
        style: {
          padding: "12px 24px", fontSize: "1.25rem", background: "#6366f1",
          color: "#fff", border: "none", borderRadius: "8px", cursor: "pointer",
        },
      }, "+"),
      React.createElement("button", {
        onClick: () => callTool("counter.reset", {}),
        style: {
          padding: "12px 24px", fontSize: "1.25rem", background: "#1e293b",
          color: "#94a3b8", border: "1px solid #334155", borderRadius: "8px", cursor: "pointer",
        },
      }, "Reset"),
    ),

    React.createElement("div", {
      style: { fontSize: "0.8rem", color: "#475569", marginTop: "2rem" },
    },
      participants.length + " connected | you: " + actorId
    ),
  );
};

const tools = [
  defineTool({
    name: "counter.increment",
    description: "Increment the counter by 1",
    input_schema: z.object({}),
    handler: async (ctx) => {
      const next = (ctx.state.count ?? 0) + 1;
      ctx.setState({ ...ctx.state, count: next });
      return { count: next };
    },
  }),
  defineTool({
    name: "counter.decrement",
    description: "Decrement the counter by 1",
    input_schema: z.object({}),
    handler: async (ctx) => {
      const next = (ctx.state.count ?? 0) - 1;
      ctx.setState({ ...ctx.state, count: next });
      return { count: next };
    },
  }),
  defineTool({
    name: "counter.reset",
    description: "Reset the counter to zero",
    input_schema: z.object({}),
    handler: async (ctx) => {
      ctx.setState({ ...ctx.state, count: 0 });
      return { count: 0 };
    },
  }),
];

export default defineExperience({
  manifest: {
    id: "my-experience",
    version: "0.0.1",
    title: "My Experience",
    description: "A counter experience — replace this with your own!",
    requested_capabilities: ["state.write"],
  },
  Canvas,
  tools,
});
