/**
 * Optional per-invocation isolation for skill runs (subprocess or Docker).
 */
import { spawn } from "node:child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SkillManifest } from "./types.js";
import type { RunResult } from "./skill-invoke.js";

/** Resolve dist/sandbox-runner.js next to dist/cli.js, or cwd/dist, or CLAW_BENCH_SANDBOX_RUNNER. */
function sandboxRunnerPath(): string {
  const fromEnv = process.env.CLAW_BENCH_SANDBOX_RUNNER?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const mainScript = process.argv[1];
  if (mainScript) {
    const dir = path.dirname(path.resolve(mainScript));
    const candidate = path.join(dir, "sandbox-runner.js");
    if (fs.existsSync(candidate)) return candidate;
  }
  const cwdFallback = path.join(process.cwd(), "dist", "sandbox-runner.js");
  if (fs.existsSync(cwdFallback)) return cwdFallback;
  throw new Error(
    "Could not locate sandbox-runner.js. Set CLAW_BENCH_SANDBOX_RUNNER to its absolute path."
  );
}

function readJsonStdout(buf: string): RunResult {
  const line = buf.trim();
  const parsed = JSON.parse(line) as RunResult;
  if (
    typeof parsed.durationMs !== "number" ||
    typeof parsed.crashed !== "boolean" ||
    (parsed.output !== null && typeof parsed.output !== "object")
  ) {
    throw new Error(`Invalid sandbox runner output: ${line.slice(0, 200)}`);
  }
  return parsed;
}

export async function runSkillSubprocess(
  skillDir: string,
  manifest: SkillManifest,
  input: Record<string, unknown>
): Promise<RunResult> {
  const payloadPath = path.join(
    os.tmpdir(),
    `claw-bench-sandbox-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  const payload = {
    skillDir: path.resolve(skillDir),
    manifest,
    input,
  };
  fs.writeFileSync(payloadPath, JSON.stringify(payload), "utf8");
  try {
    const runnerPath = sandboxRunnerPath();
    const child = spawn(process.execPath, [runnerPath, payloadPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      err += c.toString();
    });
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (c) => resolve(c ?? 1));
    });
    if (code !== 0) {
      throw new Error(
        `sandbox subprocess exited ${code}${err ? `: ${err}` : ""}${out ? ` — ${out}` : ""}`
      );
    }
    return readJsonStdout(out);
  } finally {
    try {
      fs.unlinkSync(payloadPath);
    } catch {
      /* ignore */
    }
  }
}

export async function runSkillDocker(
  skillDir: string,
  manifest: SkillManifest,
  input: Record<string, unknown>
): Promise<RunResult> {
  const payloadPath = path.join(
    os.tmpdir(),
    `claw-bench-docker-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  const payload = {
    skillDir: "/skill",
    manifest,
    input,
  };
  fs.writeFileSync(payloadPath, JSON.stringify(payload), "utf8");
  const skillHost = path.resolve(skillDir);
  const runnerPath = sandboxRunnerPath();
  const image =
    process.env.CLAW_BENCH_SANDBOX_IMAGE?.trim() || "node:20-bookworm-slim";
  const extra =
    process.env.CLAW_BENCH_SANDBOX_DOCKER_ARGS?.trim() ?? "";

  const args = [
    "run",
    "--rm",
    "-v",
    `${skillHost}:/skill:ro`,
    "-v",
    `${payloadPath}:/payload.json:ro`,
    "-v",
    `${runnerPath}:/runner.cjs:ro`,
    "-w",
    "/skill",
  ];
  if (extra) {
    args.push(...extra.split(/\s+/).filter(Boolean));
  }
  args.push(image, "node", "/runner.cjs", "/payload.json");

  try {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      err += c.toString();
    });
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (c) => resolve(c ?? 1));
    });
    if (code !== 0) {
      throw new Error(
        `docker sandbox exited ${code}${err ? `: ${err}` : ""}${out ? ` — ${out}` : ""}`
      );
    }
    return readJsonStdout(out);
  } finally {
    try {
      fs.unlinkSync(payloadPath);
    } catch {
      /* ignore */
    }
  }
}
