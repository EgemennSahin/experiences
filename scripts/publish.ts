/**
 * Publish experience to the hosted vibe-vibes platform.
 * Reads src/index.tsx and uploads to the hosted API.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

async function main() {
  // Read config
  const configPath = path.join(PROJECT_ROOT, "vibevibes.json");
  if (!fs.existsSync(configPath)) {
    console.error("Missing vibevibes.json — create it with { experienceId, hostedUrl }");
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const { experienceId, hostedUrl } = config;

  if (!experienceId || !hostedUrl) {
    console.error("vibevibes.json must have experienceId and hostedUrl");
    process.exit(1);
  }

  // Read source
  const srcPath = path.join(PROJECT_ROOT, "src", "index.tsx");
  if (!fs.existsSync(srcPath)) {
    console.error("Missing src/index.tsx");
    process.exit(1);
  }

  const sourceCode = fs.readFileSync(srcPath, "utf-8");
  console.log(`Publishing ${experienceId} to ${hostedUrl}...`);
  console.log(`Source: ${sourceCode.length} bytes`);

  // Upload
  const res = await fetch(`${hostedUrl}/api/experiences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: experienceId,
      name: experienceId,
      source_code: sourceCode,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Publish failed (${res.status}): ${text}`);
    process.exit(1);
  }

  const data = await res.json();
  console.log(`Published! ${JSON.stringify(data)}`);
  console.log(`Open: ${hostedUrl}/experience/${experienceId}`);
}

main().catch((err) => {
  console.error("Publish failed:", err);
  process.exit(1);
});
