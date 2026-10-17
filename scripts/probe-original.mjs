import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// The original executable provides the native Bun APIs used by the extracted UI.
delete process.env.BUN_OPTIONS;
const root = new URL("../vendor/claude-full/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
if (manifest.generator !== "scripts/extract-full.py") throw Error("Unexpected full CLI manifest");
for (const file of manifest.files.filter(file => file.selected)) {
  const contents = readFileSync(new URL(file.relative_path, root));
  if (createHash("sha256").update(contents).digest("hex") !== file.derived_sha256) {
    throw Error(`Extracted source was changed: ${file.relative_path}`);
  }
}
if (typeof Bun.ant?.CellSegmenter !== "function") throw Error("The original Claude Code Bun runtime is required");
process.argv = [process.execPath, fileURLToPath(new URL("cli", root)), ...process.argv.slice(2)];
try {
  await import(new URL("cli", root).href);
} finally {
  if (manifest.engine === "sdk") {
    const { closeSdkRuns } = await import(new URL("../src/sdk-run.ts", import.meta.url).href);
    await closeSdkRuns();
  }
}
process.exit(process.exitCode ?? 0);
