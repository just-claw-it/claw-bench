/**
 * Optional network smoke: `data sync-clawhub-metadata --dry-run` against live Convex.
 * Skip offline: CLAWHUB_SKIP_NETWORK_SMOKE=1
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

async function runCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const skipNetwork = process.env.CLAWHUB_SKIP_NETWORK_SMOKE === "1";
const runDescribe = skipNetwork ? describe.skip : describe;

runDescribe("data sync-clawhub-metadata CLI smoke (network)", () => {
  it("dry-run returns SkillMetadata JSON for a public slug", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawhub-sync-meta-"));
    const dbFile = path.join(tempRoot, "bench.db");

    const cliPath = path.join(process.cwd(), "dist", "cli.js");
    const run = await runCli(
      [cliPath, "data", "sync-clawhub-metadata", "slack", "--dry-run", "-q"],
      tempRoot,
      {
        ...process.env,
        CLAW_BENCH_DB: dbFile,
      }
    );

    try {
      assert.equal(run.status, 0, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
      const start = run.stdout.indexOf("[");
      const end = run.stdout.lastIndexOf("]");
      assert.ok(start >= 0 && end > start, "expected JSON array in stdout after log lines");
      const parsed = JSON.parse(run.stdout.slice(start, end + 1)) as unknown;
      assert.ok(Array.isArray(parsed), "stdout should be a JSON array");
      assert.ok(parsed.length >= 1, "expected at least one skill");
      const first = parsed[0] as Record<string, unknown>;
      assert.equal(first.skillName, "slack");
      assert.equal(typeof first.author, "string");
      assert.ok(Array.isArray(first.versionHistory));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
