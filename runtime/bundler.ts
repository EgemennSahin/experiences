/**
 * Experience bundler — produces server and client bundles from src/index.tsx.
 *
 * Server bundle: CJS, eval'd via new Function() to extract tools + manifest.
 * Client bundle: ESM, loaded in browser via blob URL + dynamic import().
 */

import * as esbuild from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

const EXTERNALS = ["react", "react-dom", "yjs", "zod", "@vibevibes/sdk"];

/**
 * Strip import/export statements for external packages.
 * The runtime provides these via globalThis (browser) or function args (server).
 */
function stripExternalImports(code: string): string {
  let result = code;
  for (const ext of EXTERNALS) {
    const escaped = ext.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
    // ESM: import X from "pkg"; or import { X } from "pkg";
    result = result.replace(
      new RegExp(`import\\s+[^;]*?from\\s+["']${escaped}["'];?`, "g"),
      ""
    );
    // Type-only imports
    result = result.replace(
      new RegExp(`import\\s+type\\s+[^;]*?from\\s+["']${escaped}["'];?`, "g"),
      ""
    );
    // CJS: var import_X = __toESM(require("pkg"), N); or var import_X = require("pkg");
    // Match the entire line including optional __toESM wrapper and trailing args
    result = result.replace(
      new RegExp(`var\\s+\\w+\\s*=\\s*(?:__toESM\\()?require\\(["']${escaped}["']\\)[^;]*;`, "g"),
      ""
    );
  }
  return result;
}

/**
 * Inject CJS shim variables so that esbuild's generated references (e.g. import_zod.z)
 * resolve correctly when externals are provided as function arguments.
 *
 * esbuild uses the last path segment for variable names:
 *   "react" → import_react, "zod" → import_zod, "@vibevibes/sdk" → import_sdk
 */
function injectCjsShims(): string {
  return [
    "var import_react = { default: React, __esModule: true };",
    "var import_zod = { z: z, default: z };",
    "var import_yjs = { default: Y };",
    "var import_sdk = { defineExperience: defineExperience, defineTool: defineTool, defineTest: defineTest, default: { defineExperience: defineExperience, defineTool: defineTool, defineTest: defineTest } };",
    "var import_vibevibes_sdk = import_sdk;",
  ].join("\n");
}

/**
 * Bundle for server-side tool execution (Node.js eval).
 * Returns the raw ExperienceModule extracted via new Function().
 */
export async function bundleForServer(entryPath: string) {
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "es2022",
    write: false,
    external: EXTERNALS,
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    logLevel: "silent",
  });

  let code = result.outputFiles[0].text;
  code = stripExternalImports(code);

  // Inject CJS shims for esbuild-generated variable references
  code = injectCjsShims() + "\n" + code;

  // Replace module.exports/export default with variable assignment
  code = code.replace(
    /module\.exports\s*=\s*/g,
    "var __experience_export__ = "
  );
  code = code.replace(
    /exports\.default\s*=\s*/g,
    "var __experience_export__ = "
  );

  return code;
}

/**
 * Evaluate a server bundle and extract the ExperienceModule.
 */
export async function evalServerBundle(serverCode: string): Promise<any> {
  const { defineExperience, defineTool, defineTest } = await import("@vibevibes/sdk");
  // Stub React for server-side (tools don't render)
  const stubReact = { createElement: () => null, Fragment: "Fragment" };
  const zodModule = await import("zod");
  const z = zodModule.z ?? zodModule.default ?? zodModule;

  const fn = new Function(
    "React", "Y", "z",
    "defineExperience", "defineTool", "defineTest",
    "require", "exports", "module", "console",
    `"use strict";\n${serverCode}\nreturn typeof __experience_export__ !== 'undefined' ? __experience_export__ : (typeof module !== 'undefined' ? module.exports : undefined);`
  );

  const fakeModule = { exports: {} };
  const result = fn(
    stubReact, {}, z,
    defineExperience, defineTool, defineTest,
    () => ({}), fakeModule.exports, fakeModule, console,
  );

  return result?.default ?? result ?? fakeModule.exports?.default ?? fakeModule.exports;
}

/**
 * Bundle for client-side Canvas rendering (browser eval).
 * Returns ESM source string that can be loaded via blob URL + dynamic import().
 */
export async function bundleForClient(entryPath: string): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    write: false,
    external: EXTERNALS,
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    logLevel: "silent",
  });

  let code = result.outputFiles[0].text;
  code = stripExternalImports(code);

  // Inject globalThis accessors at the top
  const globals = `
const React = globalThis.React;
const Y = globalThis.Y || {};
const z = globalThis.z;
const defineExperience = globalThis.defineExperience || ((m) => m);
const defineTool = globalThis.defineTool || ((c) => ({ risk: "low", capabilities_required: [], ...c }));
const defineTest = globalThis.defineTest || ((c) => c);
const quickTool = globalThis.quickTool;
const { useToolCall, useSharedState, useOptimisticTool, useParticipants, useAnimationFrame, useFollow, useTypingIndicator } = globalThis.vibevibesHooks || {};
const { Button, Card, Input, Badge, Stack, Grid } = globalThis.vibevibesComponents || {};
`;

  return globals + "\n" + code;
}

/**
 * Build both bundles from the project's src/index.tsx.
 */
export async function buildExperience() {
  const entryPath = path.join(PROJECT_ROOT, "src", "index.tsx");
  const [serverCode, clientCode] = await Promise.all([
    bundleForServer(entryPath),
    bundleForClient(entryPath),
  ]);
  return { serverCode, clientCode };
}

// Run directly: tsx runtime/bundler.ts
if (process.argv[1] && process.argv[1].includes("bundler")) {
  buildExperience()
    .then(({ serverCode, clientCode }) => {
      console.log(`Server bundle: ${serverCode.length} bytes`);
      console.log(`Client bundle: ${clientCode.length} bytes`);
    })
    .catch((err) => {
      console.error("Build failed:", err);
      process.exit(1);
    });
}
