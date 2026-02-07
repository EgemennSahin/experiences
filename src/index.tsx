import React from "react";
import { z } from "zod";
import { defineExperience, defineTool, type CanvasProps } from "@vibevibes/sdk";

// ─── Constants ───────────────────────────────────────────────────────────────

const GRID = 64;
const PX = 8;
const DIM = GRID * PX; // 512

const PALETTE = [
  "#000000", "#ffffff", "#ff0000", "#00ff00",
  "#0000ff", "#ffff00", "#ff00ff", "#00ffff",
  "#ff8800", "#8800ff", "#0088ff", "#ff0088",
  "#88ff00", "#884400", "#888888", "#448844",
];

// ─── Styles ──────────────────────────────────────────────────────────────────

const rootStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  background: "#0a0a0a",
  color: "#fff",
  fontFamily: "system-ui, -apple-system, sans-serif",
  padding: "24px",
  gap: "16px",
};

const headerStyle: React.CSSProperties = {
  textAlign: "center",
};

const titleStyle: React.CSSProperties = {
  fontSize: "1.8rem",
  fontWeight: 200,
  letterSpacing: "-0.02em",
  margin: 0,
};

const statsStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "#64748b",
  marginTop: "4px",
};

const mainStyle: React.CSSProperties = {
  display: "flex",
  gap: "24px",
  alignItems: "flex-start",
};

const canvasWrapperStyle: React.CSSProperties = {
  position: "relative",
};

const canvasBaseStyle: React.CSSProperties = {
  display: "block",
  borderRadius: "4px",
  border: "1px solid #334155",
};

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  borderRadius: "4px",
  cursor: "crosshair",
};

const coordStyle: React.CSSProperties = {
  position: "absolute",
  bottom: "-22px",
  left: "50%",
  transform: "translateX(-50%)",
  fontSize: "0.75rem",
  color: "#64748b",
  whiteSpace: "nowrap",
};

const sidebarStyle: React.CSSProperties = {
  width: "200px",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "#94a3b8",
  margin: "0 0 8px 0",
};

const paletteGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: "4px",
};

const clearBtnStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: "0.8rem",
  background: "#1e293b",
  color: "#ef4444",
  border: "1px solid #334155",
  borderRadius: "6px",
  cursor: "pointer",
  marginTop: "8px",
};

// ─── Canvas Painting ─────────────────────────────────────────────────────────

function paintPixels(
  canvas: HTMLCanvasElement,
  pixels: Record<string, string>,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Background
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, DIM, DIM);

  // Grid lines
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= GRID; i++) {
    ctx.beginPath();
    ctx.moveTo(i * PX, 0);
    ctx.lineTo(i * PX, DIM);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * PX);
    ctx.lineTo(DIM, i * PX);
    ctx.stroke();
  }

  // Pixels
  for (const [key, color] of Object.entries(pixels)) {
    const [xs, ys] = key.split(",");
    const x = parseInt(xs, 10);
    const y = parseInt(ys, 10);
    if (isNaN(x) || isNaN(y)) continue;
    ctx.fillStyle = color;
    ctx.fillRect(x * PX, y * PX, PX, PX);
  }
}

function paintHover(
  canvas: HTMLCanvasElement,
  hoverX: number,
  hoverY: number,
  color: string,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, DIM, DIM);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.4;
  ctx.fillRect(hoverX * PX, hoverY * PX, PX, PX);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.strokeRect(hoverX * PX + 0.5, hoverY * PX + 0.5, PX - 1, PX - 1);
}

function clearOverlay(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.clearRect(0, 0, DIM, DIM);
}

// ─── Canvas Component ────────────────────────────────────────────────────────

const Canvas: React.FC<CanvasProps> = ({
  sharedState,
  callTool,
  participants,
  actorId,
}) => {
  const [selectedColor, setSelectedColor] = React.useState(PALETTE[2]);
  const [hover, setHover] = React.useState<{ x: number; y: number } | null>(null);

  const pixelCanvasRef = React.useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = React.useRef<HTMLCanvasElement>(null);

  const pixels: Record<string, string> = sharedState.pixels || {};
  const recentPlacements: Array<{
    x: number; y: number; color: string; actor: string; ts: number;
  }> = sharedState.recentPlacements || [];
  const pixelCount: number = sharedState.pixelCount || 0;

  // Repaint pixels when state changes
  React.useEffect(() => {
    if (pixelCanvasRef.current) paintPixels(pixelCanvasRef.current, pixels);
  }, [sharedState.pixels]);

  // Repaint hover overlay
  React.useEffect(() => {
    if (!overlayCanvasRef.current) return;
    if (hover) {
      paintHover(overlayCanvasRef.current, hover.x, hover.y, selectedColor);
    } else {
      clearOverlay(overlayCanvasRef.current);
    }
  }, [hover, selectedColor]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / PX);
    const y = Math.floor((e.clientY - rect.top) / PX);
    if (x >= 0 && x < GRID && y >= 0 && y < GRID) {
      callTool("pixel.place", { x, y, color: selectedColor });
    }
  };

  const handleMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / PX);
    const y = Math.floor((e.clientY - rect.top) / PX);
    if (x >= 0 && x < GRID && y >= 0 && y < GRID) {
      setHover({ x, y });
    } else {
      setHover(null);
    }
  };

  // ── Render ──

  return React.createElement("div", { style: rootStyle },
    // Header
    React.createElement("div", { style: headerStyle },
      React.createElement("h1", { style: titleStyle }, "Pixel Canvas"),
      React.createElement("div", { style: statsStyle },
        pixelCount + " / 4096 pixels \u00B7 " + participants.length + " connected",
      ),
    ),

    // Main area
    React.createElement("div", { style: mainStyle },

      // Canvas stack
      React.createElement("div", { style: canvasWrapperStyle },
        // Pixel layer
        React.createElement("canvas", {
          ref: pixelCanvasRef,
          width: DIM,
          height: DIM,
          style: canvasBaseStyle,
        }),
        // Hover overlay layer
        React.createElement("canvas", {
          ref: overlayCanvasRef,
          width: DIM,
          height: DIM,
          style: { ...overlayStyle, width: DIM, height: DIM },
          onClick: handleClick,
          onMouseMove: handleMove,
          onMouseLeave: () => setHover(null),
        }),
        // Coordinate tooltip
        hover && React.createElement("div", { style: coordStyle },
          "(" + hover.x + ", " + hover.y + ")" +
          (pixels[hover.x + "," + hover.y]
            ? " \u00B7 " + pixels[hover.x + "," + hover.y]
            : ""),
        ),
      ),

      // Sidebar
      React.createElement("div", { style: sidebarStyle },

        // Color palette
        React.createElement("div", null,
          React.createElement("h3", { style: sectionTitleStyle }, "Colors"),
          React.createElement("div", { style: paletteGridStyle },
            ...PALETTE.map((color) =>
              React.createElement("div", {
                key: color,
                onClick: () => setSelectedColor(color),
                style: {
                  width: 28,
                  height: 28,
                  backgroundColor: color,
                  border: color === selectedColor
                    ? "3px solid #fff"
                    : "1px solid #333",
                  borderRadius: 4,
                  cursor: "pointer",
                  boxSizing: "border-box" as const,
                },
              }),
            ),
          ),
          React.createElement("div", {
            style: {
              marginTop: "8px",
              fontSize: "0.75rem",
              color: "#64748b",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            },
          },
            React.createElement("div", {
              style: {
                width: 14,
                height: 14,
                backgroundColor: selectedColor,
                border: "1px solid #555",
                borderRadius: 2,
              },
            }),
            "Selected",
          ),
        ),

        // Participants
        React.createElement("div", null,
          React.createElement("h3", { style: sectionTitleStyle },
            "Participants (" + participants.length + ")",
          ),
          ...participants.map((p) =>
            React.createElement("div", {
              key: p,
              style: {
                fontSize: "0.75rem",
                color: p === actorId ? "#6366f1" : "#94a3b8",
                padding: "2px 0",
                fontWeight: p === actorId ? 600 : 400,
              },
            },
              (p.includes("ai") ? "\uD83E\uDD16 " : "\uD83D\uDC64 ") +
              p + (p === actorId ? " (you)" : ""),
            ),
          ),
        ),

        // Recent activity
        React.createElement("div", null,
          React.createElement("h3", { style: sectionTitleStyle }, "Recent Activity"),
          recentPlacements.length === 0
            ? React.createElement("div", {
                style: { fontSize: "0.75rem", color: "#475569", fontStyle: "italic" },
              }, "No activity yet")
            : recentPlacements.slice(0, 10).map((p, i) =>
                React.createElement("div", {
                  key: i,
                  style: {
                    fontSize: "0.7rem",
                    color: "#64748b",
                    padding: "2px 0",
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                  },
                },
                  React.createElement("div", {
                    style: {
                      width: 8,
                      height: 8,
                      backgroundColor: p.color,
                      borderRadius: 1,
                      flexShrink: 0,
                    },
                  }),
                  p.actor.split("-")[0] + " (" + p.x + "," + p.y + ")",
                ),
              ),
        ),

        // Clear button
        React.createElement("button", {
          onClick: () => {
            if (confirm("Clear the entire canvas?")) {
              callTool("pixel.clear", {});
            }
          },
          style: clearBtnStyle,
        }, "Clear Canvas"),
      ),
    ),

    // Footer
    React.createElement("div", {
      style: { fontSize: "0.7rem", color: "#334155", marginTop: "8px" },
    }, "you: " + actorId),
  );
};

// ─── Tools ───────────────────────────────────────────────────────────────────

const tools = [
  defineTool({
    name: "pixel.place",
    description:
      "Place a colored pixel on the 64x64 canvas. x and y range from 0 to 63. Color is a hex string like '#ff0000'.",
    input_schema: z.object({
      x: z.number().int().min(0).max(63).describe("X coordinate (0-63, left to right)"),
      y: z.number().int().min(0).max(63).describe("Y coordinate (0-63, top to bottom)"),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .describe("Hex color e.g. '#ff0000'"),
    }),
    handler: async (ctx, input) => {
      const pixels = { ...(ctx.state.pixels || {}) };
      const key = input.x + "," + input.y;
      pixels[key] = input.color;

      const placement = {
        x: input.x,
        y: input.y,
        color: input.color,
        actor: ctx.actorId,
        ts: ctx.timestamp,
      };
      const recent = [placement, ...(ctx.state.recentPlacements || [])].slice(0, 20);

      ctx.setState({
        ...ctx.state,
        pixels,
        recentPlacements: recent,
        pixelCount: Object.keys(pixels).length,
      });

      return { placed: key, color: input.color, totalPixels: Object.keys(pixels).length };
    },
  }),

  defineTool({
    name: "pixel.place_batch",
    description:
      "Place multiple pixels at once (up to 50). More efficient than calling pixel.place repeatedly.",
    input_schema: z.object({
      placements: z
        .array(
          z.object({
            x: z.number().int().min(0).max(63),
            y: z.number().int().min(0).max(63),
            color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
          }),
        )
        .min(1)
        .max(50)
        .describe("Array of {x, y, color} pixel placements"),
    }),
    handler: async (ctx, input) => {
      const pixels = { ...(ctx.state.pixels || {}) };
      const newRecent: Array<{
        x: number; y: number; color: string; actor: string; ts: number;
      }> = [];

      for (const p of input.placements) {
        const key = p.x + "," + p.y;
        pixels[key] = p.color;
        newRecent.push({
          x: p.x,
          y: p.y,
          color: p.color,
          actor: ctx.actorId,
          ts: ctx.timestamp,
        });
      }

      const recent = [...newRecent, ...(ctx.state.recentPlacements || [])].slice(0, 20);

      ctx.setState({
        ...ctx.state,
        pixels,
        recentPlacements: recent,
        pixelCount: Object.keys(pixels).length,
      });

      return { placed: input.placements.length, totalPixels: Object.keys(pixels).length };
    },
  }),

  defineTool({
    name: "pixel.get_region",
    description:
      "Read all pixels in a rectangular region. Useful for inspecting what has been drawn before placing new pixels.",
    input_schema: z.object({
      x1: z.number().int().min(0).max(63).describe("Left edge"),
      y1: z.number().int().min(0).max(63).describe("Top edge"),
      x2: z.number().int().min(0).max(63).describe("Right edge"),
      y2: z.number().int().min(0).max(63).describe("Bottom edge"),
    }),
    handler: async (ctx, input) => {
      const pixels: Record<string, string> = ctx.state.pixels || {};
      const region: Record<string, string> = {};
      for (let x = input.x1; x <= input.x2; x++) {
        for (let y = input.y1; y <= input.y2; y++) {
          const key = x + "," + y;
          if (pixels[key]) region[key] = pixels[key];
        }
      }
      return {
        region,
        filledCount: Object.keys(region).length,
        totalInRegion: (input.x2 - input.x1 + 1) * (input.y2 - input.y1 + 1),
      };
    },
  }),

  defineTool({
    name: "pixel.clear",
    description: "Clear the entire canvas, removing all pixels.",
    input_schema: z.object({}),
    handler: async (ctx) => {
      ctx.setState({ ...ctx.state, pixels: {}, recentPlacements: [], pixelCount: 0 });
      return { cleared: true };
    },
  }),
];

// ─── Export ──────────────────────────────────────────────────────────────────

export default defineExperience({
  manifest: {
    id: "pixel-canvas",
    version: "0.0.1",
    title: "Pixel Canvas",
    description:
      "A shared 64x64 pixel canvas where humans and AI agents collaborate to create pixel art in real-time.",
    requested_capabilities: ["state.write"],
    category: "art",
    tags: ["pixel-art", "collaborative", "creative", "multi-agent"],

    agentSlots: [
      {
        role: "pattern-artist",
        systemPrompt:
          "You are a pixel art pattern artist on a shared 64x64 canvas. Draw geometric patterns, symmetrical designs, and repeating motifs. Use pixel.place_batch for efficiency. Strategies: mirror patterns along center axes, create checkerboards/stripes/diamonds, use complementary colors. Check existing pixels with pixel.get_region before drawing to avoid overwriting human art. Leave space for others.",
        allowedTools: ["pixel.place", "pixel.place_batch", "pixel.get_region"],
        autoSpawn: true,
        maxInstances: 1,
      },
      {
        role: "collaborative-artist",
        systemPrompt:
          "You are a collaborative pixel artist on a shared 64x64 canvas. Watch for human pixel placements and extend, complement, or enhance their drawings. Extend lines and shapes humans start, add complementary colors nearby, mirror or symmetrize human art. Use pixel.get_region to understand context. Be responsive but not overwhelming — place a few pixels at a time.",
        allowedTools: ["pixel.place", "pixel.place_batch", "pixel.get_region"],
        autoSpawn: true,
        maxInstances: 1,
      },
      {
        role: "border-artist",
        systemPrompt:
          "You are a border and frame artist on a shared 64x64 canvas. Create decorative borders along edges (rows 0/63, columns 0/63), corner pieces, and dividing lines. Use pixel.place_batch for efficiency. Use warm colors (red, orange, yellow) for borders. Inspect edges with pixel.get_region first.",
        allowedTools: ["pixel.place", "pixel.place_batch", "pixel.get_region"],
        autoSpawn: false,
        maxInstances: 1,
      },
      {
        role: "fill-artist",
        systemPrompt:
          "You are a background fill artist on a shared 64x64 canvas. Scan for large empty areas with pixel.get_region, then fill them with subtle dark background colors or gradients. Never overwrite existing pixels. Use pixel.place_batch for efficiency. Stick to darker muted colors so foreground art stands out.",
        allowedTools: ["pixel.place", "pixel.place_batch", "pixel.get_region"],
        autoSpawn: false,
        maxInstances: 1,
      },
    ],

    agentHints: [
      {
        trigger: "when the canvas is mostly empty",
        condition: "!state.pixelCount || state.pixelCount < 100",
        suggestedTools: ["pixel.place_batch"],
        priority: "high" as const,
        cooldownMs: 5000,
      },
      {
        trigger: "when a human places pixels",
        condition:
          "state.recentPlacements?.length > 0 && state.recentPlacements[0]?.actor?.includes('human')",
        suggestedTools: ["pixel.get_region", "pixel.place"],
        priority: "medium" as const,
        cooldownMs: 3000,
      },
      {
        trigger: "when the canvas is getting full",
        condition: "state.pixelCount > 3000",
        suggestedTools: ["pixel.get_region"],
        priority: "low" as const,
        cooldownMs: 10000,
      },
      {
        trigger: "when borders are empty",
        condition:
          "state.pixelCount > 50 && (!state.pixels?.['0,0'] || !state.pixels?.['63,0'])",
        suggestedTools: ["pixel.place_batch"],
        priority: "medium" as const,
        cooldownMs: 8000,
      },
    ],
  },
  Canvas,
  tools,
});
