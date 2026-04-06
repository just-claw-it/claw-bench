/**
 * Sandbox: in-process vs subprocess vs Docker parity for skill execution.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { loadManifest, runSkill } from "../harness.js";
import { invokeSkillEntrypoint } from "../skill-invoke.js";
import { runSkillDocker } from "../sandbox.js";

function tmpLinearSkillDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-bench-sandbox-test-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ type: "module" })
  );
  fs.writeFileSync(
    path.join(dir, "index.js"),
    `export default async function run(input) {
  return { echo: input?.input ?? null };
}
`
  );
  fs.writeFileSync(
    path.join(dir, "skill.json"),
    JSON.stringify({
      name: "sandbox-test-skill",
      description: "test",
      type: "linear",
      entrypoint: "index.js",
    })
  );
  return dir;
}

describe("invokeSkillEntrypoint", () => {
  it("returns deterministic output for a minimal linear skill", async () => {
    const dir = tmpLinearSkillDir();
    try {
      const manifest = loadManifest(dir);
      const r = await invokeSkillEntrypoint(dir, manifest, { input: "hi" });
      assert.equal(r.crashed, false);
      assert.deepEqual(r.output, { echo: "hi" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runSkill sandbox parity", () => {
  it("subprocess matches in-process output for the same input", async () => {
    const dir = tmpLinearSkillDir();
    try {
      const manifest = loadManifest(dir);
      const input = { input: "probe" };
      const a = await runSkill(dir, manifest, input, "none");
      const b = await runSkill(dir, manifest, input, "subprocess");
      assert.equal(a.crashed, b.crashed, "crash parity");
      assert.deepEqual(a.output, b.output, "output parity");
      assert.equal(typeof a.durationMs, "number");
      assert.equal(typeof b.durationMs, "number");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const dockerAvailable =
  spawnSync("docker", ["version"], { encoding: "utf8" }).status === 0;

describe("runSkill docker sandbox", () => {
  const dockerIt = dockerAvailable ? it : it.skip;

  dockerIt(
    "matches in-process when Docker is available",
    { timeout: 180_000 },
    async () => {
      const dir = tmpLinearSkillDir();
      try {
        const manifest = loadManifest(dir);
        const input = { input: "probe" };
        const a = await runSkill(dir, manifest, input, "none");
        const c = await runSkillDocker(dir, manifest, input);
        assert.equal(a.crashed, c.crashed, "crash parity");
        assert.deepEqual(a.output, c.output, "output parity");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
