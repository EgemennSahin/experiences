/**
 * Dev server entry point.
 * Starts the local runtime server with hot reload.
 */

import { startServer } from "../runtime/server.js";

startServer().catch((err) => {
  console.error("Failed to start dev server:", err);
  process.exit(1);
});
