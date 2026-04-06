/**
 * Load skill entrypoint and invoke default export — shared by in-process harness and sandbox subprocess.
 */
import * as path from "path";
import { performance } from "node:perf_hooks";
import type { SkillManifest } from "./types.js";
import { shapeInput } from "./harness-inputs.js";

export interface RunResult {
  output: Record<string, unknown> | null;
  durationMs: number;
  error: string | null;
  crashed: boolean;
}

export async function invokeSkillEntrypoint(
  skillDir: string,
  manifest: SkillManifest,
  input: Record<string, unknown>
): Promise<RunResult> {
  const entrypoint = path.resolve(skillDir, manifest.entrypoint);
  const start = performance.now();
  const runtimeInput = shapeInput(manifest.type, input);
  try {
    const mod = (await import(entrypoint)) as {
      default: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    if (typeof mod.default !== "function") {
      throw new Error("Skill entrypoint does not export a default function");
    }
    const output = await mod.default(runtimeInput);
    return { output, durationMs: performance.now() - start, error: null, crashed: false };
  } catch (err) {
    return {
      output: null,
      durationMs: performance.now() - start,
      error: err instanceof Error ? err.message : String(err),
      crashed: true,
    };
  }
}
