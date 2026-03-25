/**
 * claw-bench test suite
 * Uses Node's built-in test runner: `node --test dist/test/bench.test.js`
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cosineSimilarity } from "../embeddings.js";
import {
  computeAuthoredScore,
  computeAutomatedScore,
} from "../scoring.js";
import {
  requiresCredentials,
  syntheticMalformedInputs,
  mockWebhookPayload,
  mockCronTrigger,
} from "../harness.js";
import { DEFAULT_CONFIG } from "../types.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── Embeddings ─────────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("identical vectors → 1.0", () => {
    const v = [1, 0, 0, 1];
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-10);
  });

  it("orthogonal vectors → 0.0", () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });

  it("opposite vectors → -1.0", () => {
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  });

  it("zero vector → 0 (no divide-by-zero crash)", () => {
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  });

  it("throws on length mismatch", () => {
    assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]));
  });
});

// ── Authored score weights ─────────────────────────────────────────────────

describe("computeAuthoredScore", () => {
  it("weights sum to 1.0: 40+30+20+10", () => {
    // All dimensions = 1 → composite must be 1
    const s = computeAuthoredScore(1, 1, 1, 1);
    assert.equal(s.composite, 1);
    assert.equal(s.type, "authored");
  });

  it("all zeros → composite 0", () => {
    assert.equal(computeAuthoredScore(0, 0, 0, 0).composite, 0);
  });

  it("correctness only → 0.40 composite", () => {
    assert.equal(computeAuthoredScore(1, 0, 0, 0).composite, 0.4);
  });

  it("consistency only → 0.30 composite", () => {
    assert.equal(computeAuthoredScore(0, 1, 0, 0).composite, 0.3);
  });

  it("robustness only → 0.20 composite", () => {
    assert.equal(computeAuthoredScore(0, 0, 1, 0).composite, 0.2);
  });

  it("latency only → 0.10 composite", () => {
    assert.equal(computeAuthoredScore(0, 0, 0, 1).composite, 0.1);
  });
});

// ── Automated score weights ────────────────────────────────────────────────

describe("computeAutomatedScore", () => {
  it("weights sum to 1.0: 50+35+15", () => {
    const s = computeAutomatedScore(1, 1, 1);
    assert.equal(s.composite, 1);
    assert.equal(s.type, "automated");
  });

  it("all zeros → composite 0", () => {
    assert.equal(computeAutomatedScore(0, 0, 0).composite, 0);
  });

  it("consistency only → 0.50 composite", () => {
    assert.equal(computeAutomatedScore(1, 0, 0).composite, 0.5);
  });

  it("robustness only → 0.35 composite", () => {
    assert.equal(computeAutomatedScore(0, 1, 0).composite, 0.35);
  });

  it("latency only → 0.15 composite", () => {
    assert.equal(computeAutomatedScore(0, 0, 1).composite, 0.15);
  });
});

// ── Credential detection ───────────────────────────────────────────────────

function tmpSkillDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-bench-test-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe("requiresCredentials", () => {
  it("returns false for benign env vars", () => {
    const dir = tmpSkillDir({
      "index.js": `const level = process.env.LOG_LEVEL;\nconst env = process.env.NODE_ENV;`,
    });
    assert.equal(requiresCredentials(dir), false);
    fs.rmSync(dir, { recursive: true });
  });

  it("detects _API_KEY suffix", () => {
    const dir = tmpSkillDir({
      "index.js": `const key = process.env.OPENAI_API_KEY;`,
    });
    assert.equal(requiresCredentials(dir), true);
    fs.rmSync(dir, { recursive: true });
  });

  it("detects _SECRET suffix", () => {
    const dir = tmpSkillDir({
      "index.js": `const s = process.env.STRIPE_SECRET;`,
    });
    assert.equal(requiresCredentials(dir), true);
    fs.rmSync(dir, { recursive: true });
  });

  it("detects Authorization header pattern", () => {
    const dir = tmpSkillDir({
      "index.js": `headers["Authorization"] = "Bearer " + process.env.MY_TOKEN_VAR;`,
    });
    assert.equal(requiresCredentials(dir), true);
    fs.rmSync(dir, { recursive: true });
  });

  it("explicit credentialVars: [] overrides heuristic", () => {
    const dir = tmpSkillDir({
      "index.js": `const key = process.env.OPENAI_API_KEY;`,
    });
    const manifest = {
      name: "test", description: "", type: "linear" as const,
      entrypoint: "index.js", credentialVars: [],
    };
    assert.equal(requiresCredentials(dir, manifest), false);
    fs.rmSync(dir, { recursive: true });
  });

  it("explicit credentialVars non-empty → true", () => {
    const dir = tmpSkillDir({ "index.js": "" });
    const manifest = {
      name: "test", description: "", type: "linear" as const,
      entrypoint: "index.js", credentialVars: ["GITHUB_TOKEN"],
    };
    assert.equal(requiresCredentials(dir, manifest), true);
    fs.rmSync(dir, { recursive: true });
  });

  it("skips node_modules directory", () => {
    const dir = tmpSkillDir({ "index.js": "// clean" });
    const nmDir = path.join(dir, "node_modules", "some-pkg");
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, "index.js"), `const k = process.env.STRIPE_SECRET;`);
    assert.equal(requiresCredentials(dir), false);
    fs.rmSync(dir, { recursive: true });
  });
});

// ── Malformed inputs ───────────────────────────────────────────────────────

describe("syntheticMalformedInputs", () => {
  it("linear: returns at least 7 inputs", () => {
    const inputs = syntheticMalformedInputs(DEFAULT_CONFIG, "linear");
    assert.ok(inputs.length >= 7);
  });

  it("webhook: returns more inputs than linear", () => {
    const linear = syntheticMalformedInputs(DEFAULT_CONFIG, "linear");
    const webhook = syntheticMalformedInputs(DEFAULT_CONFIG, "webhook");
    assert.ok(webhook.length > linear.length);
  });

  it("cron: returns more inputs than linear", () => {
    const linear = syntheticMalformedInputs(DEFAULT_CONFIG, "linear");
    const cron = syntheticMalformedInputs(DEFAULT_CONFIG, "cron");
    assert.ok(cron.length > linear.length);
  });

  it("webhook inputs include one with missing method", () => {
    const inputs = syntheticMalformedInputs(DEFAULT_CONFIG, "webhook");
    const hasMissingMethod = inputs.some(
      (i) => "headers" in i && "body" in i && !("method" in i)
    );
    assert.ok(hasMissingMethod);
  });

  it("cron inputs include invalid cron expression", () => {
    const inputs = syntheticMalformedInputs(DEFAULT_CONFIG, "cron");
    const hasInvalidCron = inputs.some(
      (i) => "cronExpression" in i && i.cronExpression === "not-a-cron"
    );
    assert.ok(hasInvalidCron);
  });
});

// ── Mock payload factories ─────────────────────────────────────────────────

describe("mockWebhookPayload", () => {
  it("produces a valid default payload", () => {
    const p = mockWebhookPayload();
    assert.equal(p.method, "POST");
    assert.ok(p.headers["content-type"]);
    assert.ok(typeof p.body === "object");
  });

  it("overrides are applied", () => {
    const p = mockWebhookPayload({ method: "GET" });
    assert.equal(p.method, "GET");
  });
});

describe("mockCronTrigger", () => {
  it("produces a valid default trigger", () => {
    const t = mockCronTrigger();
    assert.equal(t.timezone, "UTC");
    assert.ok(t.scheduledTime);
    assert.ok(t.cronExpression);
  });

  it("overrides are applied", () => {
    const t = mockCronTrigger({ timezone: "America/New_York" });
    assert.equal(t.timezone, "America/New_York");
  });
});

// ── Scoring edge cases ────────────────────────────────────────────────────

describe("computeAuthoredScore edge cases", () => {
  it("handles boundary values without NaN", () => {
    const s = computeAuthoredScore(0.999, 0.999, 0.999, 0.999);
    assert.ok(!Number.isNaN(s.composite));
    assert.ok(s.composite > 0 && s.composite <= 1);
  });
});

describe("computeAutomatedScore edge cases", () => {
  it("handles boundary values without NaN", () => {
    const s = computeAutomatedScore(0.999, 0.999, 0.999);
    assert.ok(!Number.isNaN(s.composite));
    assert.ok(s.composite > 0 && s.composite <= 1);
  });
});

// ── Manifest validation ────────────────────────────────────────────────────

import { loadManifest, loadBenchJson } from "../harness.js";

describe("loadManifest validation", () => {
  it("rejects manifest missing required fields", () => {
    const dir = tmpSkillDir({
      "skill.json": JSON.stringify({ name: "test" }),
    });
    assert.throws(() => loadManifest(dir), /Invalid skill\.json/);
    fs.rmSync(dir, { recursive: true });
  });

  it("rejects manifest with invalid type", () => {
    const dir = tmpSkillDir({
      "skill.json": JSON.stringify({
        name: "test",
        description: "test",
        type: "invalid-type",
        entrypoint: "index.js",
      }),
    });
    assert.throws(() => loadManifest(dir), /Invalid skill\.json/);
    fs.rmSync(dir, { recursive: true });
  });

  it("accepts valid manifest", () => {
    const dir = tmpSkillDir({
      "skill.json": JSON.stringify({
        name: "test",
        description: "test skill",
        type: "linear",
        entrypoint: "index.js",
      }),
    });
    const manifest = loadManifest(dir);
    assert.equal(manifest.name, "test");
    assert.equal(manifest.type, "linear");
    fs.rmSync(dir, { recursive: true });
  });

  it("accepts manifest with credentialVars", () => {
    const dir = tmpSkillDir({
      "skill.json": JSON.stringify({
        name: "test",
        description: "test",
        type: "webhook",
        entrypoint: "index.js",
        credentialVars: ["GITHUB_TOKEN"],
      }),
    });
    const manifest = loadManifest(dir);
    assert.deepEqual(manifest.credentialVars, ["GITHUB_TOKEN"]);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("loadBenchJson validation", () => {
  it("returns null when bench.json does not exist", () => {
    const dir = tmpSkillDir({});
    assert.equal(loadBenchJson(dir), null);
    fs.rmSync(dir, { recursive: true });
  });

  it("rejects bench.json missing required fields", () => {
    const dir = tmpSkillDir({
      "bench.json": JSON.stringify({ pairs: "not-an-array" }),
    });
    assert.throws(() => loadBenchJson(dir), /Invalid bench\.json/);
    fs.rmSync(dir, { recursive: true });
  });

  it("accepts valid bench.json", () => {
    const dir = tmpSkillDir({
      "bench.json": JSON.stringify({
        skillName: "test",
        pairs: [{ description: "test", input: { a: 1 }, expectedOutput: { b: 2 } }],
      }),
    });
    const bench = loadBenchJson(dir);
    assert.ok(bench);
    assert.equal(bench.pairs.length, 1);
    fs.rmSync(dir, { recursive: true });
  });
});

// ── Symlink safety in credential scan ──────────────────────────────────────

describe("requiresCredentials symlink safety", () => {
  it("does not follow symlinks", () => {
    const dir = tmpSkillDir({ "index.js": "// clean" });
    const targetDir = tmpSkillDir({
      "secret.js": `const k = process.env.STRIPE_SECRET;`,
    });
    try {
      fs.symlinkSync(targetDir, path.join(dir, "linked"), "dir");
    } catch {
      // Symlink creation may fail on some platforms; skip test
      fs.rmSync(dir, { recursive: true });
      fs.rmSync(targetDir, { recursive: true });
      return;
    }
    assert.equal(requiresCredentials(dir), false);
    fs.rmSync(dir, { recursive: true });
    fs.rmSync(targetDir, { recursive: true });
  });
});
