#!/usr/bin/env node
/**
 * Child entry for --sandbox subprocess / Docker: one JSON payload per process.
 * Writes a single JSON line (RunResult) to stdout; exits 0 on success.
 */
import { readFileSync } from "fs";
import { invokeSkillEntrypoint } from "./skill-invoke.js";
import type { SkillManifest } from "./types.js";

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    process.stderr.write("usage: sandbox-runner <payload.json>\n");
    process.exit(2);
  }
  let raw: string;
  try {
    raw = readFileSync(payloadPath, "utf8");
  } catch (e) {
    process.stderr.write(
      e instanceof Error ? `${e.message}\n` : String(e) + "\n"
    );
    process.exit(1);
  }
  const payload = JSON.parse(raw) as {
    skillDir: string;
    manifest: SkillManifest;
    input: Record<string, unknown>;
  };
  const result = await invokeSkillEntrypoint(
    payload.skillDir,
    payload.manifest,
    payload.input
  );
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stderr.write(err instanceof Error ? err.message + "\n" : String(err) + "\n");
  process.exit(1);
});
