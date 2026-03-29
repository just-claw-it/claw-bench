/**
 * ClawHub SQLite: analysis rows, timing columns, LLM skip helper.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { ClawHubAnalysis, ClawHubSkillEntry } from "../types.js";

const entry: ClawHubSkillEntry = {
  slug: "store-test-skill",
  name: "Store Test",
  author: "t",
  version: "2.0.0",
  summary: "s",
  downloads: "10k",
  stars: "2",
  versionCount: 2,
};

function baseAnalysis(overrides: Partial<ClawHubAnalysis> = {}): ClawHubAnalysis {
  const staticAnalysis = {
    docQuality: 0.8,
    completeness: 0.7,
    security: 0.9,
    codeQuality: null as number | null,
    maintainability: 0.6,
    staticComposite: 0.75,
  };
  return {
    slug: entry.slug,
    analyzedAt: new Date().toISOString(),
    staticAnalysis,
    llmEval: null,
    overallComposite: 0.75,
    fileStats: {
      fileCount: 2,
      totalSizeBytes: 200,
      hasScripts: false,
      skillMdLength: 80,
      languages: ["markdown"],
    },
    insights: {
      complexity: "simple",
      scriptFiles: 1,
      totalLoc: 42,
      maxFileLoc: 20,
      primaryLanguage: "javascript",
      languageBreakdown: [{ language: "javascript", files: 1 }],
      describedLanguages: ["javascript"],
      undocumentedLanguages: [],
      missingFromCode: [],
      credentialHygiene: {
        declaredCredentialVars: ["OPENAI_API_KEY"],
        observedCredentialVars: ["OPENAI_API_KEY"],
        undeclaredCredentialVars: [],
        declaredButUnusedCredentialVars: [],
        hasEnvExample: true,
        envExampleCoverage: 1,
        hygieneScore: 1,
        hygieneLevel: "good",
      },
      securityFindings: {
        filesScanned: 1,
        dangerousMatches: 0,
        secretMatches: 0,
        exfiltrationMatches: 0,
        flaggedFiles: [],
        potentialDataLeakage: false,
      },
      llmAssistedAudit: {
        alignment: 0.9,
        security: 0.9,
        privacy: 0.9,
        leakageRisk: 0.1,
        notes: "looks good",
      },
    },
    timing: {
      extractMs: 42,
      staticMs: 15,
      llmMs: null,
      fileStatsMs: 2,
      pipelineMs: 20,
    },
    ...overrides,
  };
}

describe("store ClawHub analysis", () => {
  const dbFile = path.join(os.tmpdir(), `claw-bench-store-test-${process.pid}.db`);
  let prevDb: string | undefined;

  before(() => {
    prevDb = process.env.CLAW_BENCH_DB;
    process.env.CLAW_BENCH_DB = dbFile;
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  });

  after(() => {
    if (prevDb === undefined) delete process.env.CLAW_BENCH_DB;
    else process.env.CLAW_BENCH_DB = prevDb;
    try {
      if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
    } catch {
      /* ignore */
    }
  });

  it("persists timing columns and LLM columns; hasClawHubLlmAnalysisForModel", async () => {
    const { upsertClawHubSkill, storeClawHubAnalysis, hasClawHubLlmAnalysisForModel, query } =
      await import("../store.js");

    await upsertClawHubSkill(entry, {});

    const model = "test-model-xyz";
    assert.equal(await hasClawHubLlmAnalysisForModel(entry.slug, model), false);

    await storeClawHubAnalysis(baseAnalysis());

    const rows0 = await query<Record<string, unknown>>(
      "SELECT extract_ms, static_analysis_ms, llm_ms, file_stats_ms, pipeline_ms, llm_model, analysis_insights FROM clawhub_analysis WHERE slug = ?",
      [entry.slug]
    );
    assert.equal(rows0.length, 1);
    assert.equal(rows0[0].extract_ms, 42);
    assert.equal(rows0[0].static_analysis_ms, 15);
    assert.equal(rows0[0].llm_ms, null);
    assert.equal(rows0[0].file_stats_ms, 2);
    assert.equal(rows0[0].pipeline_ms, 20);
    assert.equal(typeof rows0[0].analysis_insights, "string");
    const parsed0 = JSON.parse(String(rows0[0].analysis_insights)) as {
      credentialHygiene?: { hygieneLevel?: string };
    };
    assert.equal(parsed0.credentialHygiene?.hygieneLevel, "good");
    assert.equal(await hasClawHubLlmAnalysisForModel(entry.slug, model), false);

    await storeClawHubAnalysis(
      baseAnalysis({
        analyzedAt: new Date().toISOString(),
        llmEval: {
          clarity: 0.8,
          usefulness: 0.7,
          safety: 0.9,
          completeness: 0.85,
          llmComposite: 0.8125,
          model,
          reasoning: "ok",
        },
        timing: {
          extractMs: 0,
          staticMs: 10,
          llmMs: 500,
          fileStatsMs: 1,
          pipelineMs: 520,
        },
        overallComposite: 0.8,
      })
    );

    assert.equal(await hasClawHubLlmAnalysisForModel(entry.slug, model), true);
    assert.equal(await hasClawHubLlmAnalysisForModel(entry.slug, "other-model"), false);

    const rows1 = await query<{ llm_ms: number | null }>(
      "SELECT llm_ms FROM clawhub_analysis WHERE slug = ? ORDER BY id DESC LIMIT 1",
      [entry.slug]
    );
    assert.equal(rows1[0]?.llm_ms, 500);
  });
});

describe("deleteClawHubAnalysis helpers", () => {
  const dbFile = path.join(os.tmpdir(), `claw-bench-store-del-${process.pid}.db`);
  let prevDb: string | undefined;

  before(() => {
    prevDb = process.env.CLAW_BENCH_DB;
    process.env.CLAW_BENCH_DB = dbFile;
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  });

  after(() => {
    if (prevDb === undefined) delete process.env.CLAW_BENCH_DB;
    else process.env.CLAW_BENCH_DB = prevDb;
    try {
      if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
    } catch {
      /* ignore */
    }
  });

  it("deleteClawHubAnalysisForSlugs removes matching rows only", async () => {
    const {
      upsertClawHubSkill,
      storeClawHubAnalysis,
      deleteClawHubAnalysisForSlugs,
      query,
    } = await import("../store.js");

    await upsertClawHubSkill(entry, {});
    await storeClawHubAnalysis(baseAnalysis());

    const other: ClawHubSkillEntry = { ...entry, slug: "other-skill" };
    await upsertClawHubSkill(other, {});
    await storeClawHubAnalysis(baseAnalysis({ slug: "other-skill" }));

    let n = await query<{ c: number }>("SELECT COUNT(*) AS c FROM clawhub_analysis", []);
    assert.equal(n[0]?.c, 2);

    await deleteClawHubAnalysisForSlugs([entry.slug]);

    n = await query<{ c: number }>("SELECT COUNT(*) AS c FROM clawhub_analysis", []);
    assert.equal(n[0]?.c, 1);
    const left = await query<{ slug: string }>("SELECT slug FROM clawhub_analysis", []);
    assert.equal(left[0]?.slug, "other-skill");
  });

  it("deleteAllClawHubAnalysis clears the table", async () => {
    const { upsertClawHubSkill, storeClawHubAnalysis, deleteAllClawHubAnalysis, query } =
      await import("../store.js");

    await upsertClawHubSkill(entry, {});
    await storeClawHubAnalysis(baseAnalysis());
    await deleteAllClawHubAnalysis();

    const n = await query<{ c: number }>("SELECT COUNT(*) AS c FROM clawhub_analysis", []);
    assert.equal(n[0]?.c, 0);
  });

  it("deleteAllClawHubAnalysisForModel removes only matching llm_model rows", async () => {
    const {
      upsertClawHubSkill,
      storeClawHubAnalysis,
      deleteAllClawHubAnalysisForModel,
      query,
    } = await import("../store.js");

    await upsertClawHubSkill(entry, {});
    await storeClawHubAnalysis(baseAnalysis({
      llmEval: {
        clarity: 0.7, usefulness: 0.7, safety: 0.7, completeness: 0.7,
        llmComposite: 0.7, model: "m1", reasoning: "m1",
      },
    }));
    await storeClawHubAnalysis(baseAnalysis({
      llmEval: {
        clarity: 0.8, usefulness: 0.8, safety: 0.8, completeness: 0.8,
        llmComposite: 0.8, model: "m2", reasoning: "m2",
      },
    }));

    await deleteAllClawHubAnalysisForModel("m1");
    const rows = await query<{ llm_model: string | null }>(
      "SELECT llm_model FROM clawhub_analysis",
      []
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.llm_model, "m2");
  });

  it("deleteClawHubAnalysisForSlugsAndModel scopes by slug and model", async () => {
    const {
      upsertClawHubSkill,
      storeClawHubAnalysis,
      deleteClawHubAnalysisForSlugsAndModel,
      query,
    } = await import("../store.js");

    const s1 = { ...entry, slug: "s1" };
    const s2 = { ...entry, slug: "s2" };
    await upsertClawHubSkill(s1, {});
    await upsertClawHubSkill(s2, {});
    await storeClawHubAnalysis(baseAnalysis({
      slug: "s1",
      llmEval: { clarity: 0.7, usefulness: 0.7, safety: 0.7, completeness: 0.7, llmComposite: 0.7, model: "m1", reasoning: "x" },
    }));
    await storeClawHubAnalysis(baseAnalysis({
      slug: "s1",
      llmEval: { clarity: 0.8, usefulness: 0.8, safety: 0.8, completeness: 0.8, llmComposite: 0.8, model: "m2", reasoning: "x" },
    }));
    await storeClawHubAnalysis(baseAnalysis({
      slug: "s2",
      llmEval: { clarity: 0.8, usefulness: 0.8, safety: 0.8, completeness: 0.8, llmComposite: 0.8, model: "m1", reasoning: "x" },
    }));

    await deleteClawHubAnalysisForSlugsAndModel(["s1"], "m1");
    const rows = await query<{ slug: string; llm_model: string | null }>(
      "SELECT slug, llm_model FROM clawhub_analysis WHERE slug IN (?, ?) ORDER BY slug, llm_model",
      ["s1", "s2"]
    );
    assert.deepEqual(rows, [
      { slug: "s1", llm_model: "m2" },
      { slug: "s2", llm_model: "m1" },
    ]);
  });
});

describe("cross-process DB lock behavior", () => {
  const dbFile = path.join(os.tmpdir(), `claw-bench-store-lock-${process.pid}.db`);
  const lockFile = `${dbFile}.lock`;
  let prevDb: string | undefined;
  let prevRetry: string | undefined;
  let prevStale: string | undefined;
  let prevTimeout: string | undefined;

  before(() => {
    prevDb = process.env.CLAW_BENCH_DB;
    prevRetry = process.env.CLAW_BENCH_DB_LOCK_RETRY_MS;
    prevStale = process.env.CLAW_BENCH_DB_LOCK_STALE_MS;
    prevTimeout = process.env.CLAW_BENCH_DB_LOCK_TIMEOUT_MS;
    process.env.CLAW_BENCH_DB = dbFile;
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  });

  after(() => {
    if (prevDb === undefined) delete process.env.CLAW_BENCH_DB;
    else process.env.CLAW_BENCH_DB = prevDb;
    if (prevRetry === undefined) delete process.env.CLAW_BENCH_DB_LOCK_RETRY_MS;
    else process.env.CLAW_BENCH_DB_LOCK_RETRY_MS = prevRetry;
    if (prevStale === undefined) delete process.env.CLAW_BENCH_DB_LOCK_STALE_MS;
    else process.env.CLAW_BENCH_DB_LOCK_STALE_MS = prevStale;
    if (prevTimeout === undefined) delete process.env.CLAW_BENCH_DB_LOCK_TIMEOUT_MS;
    else process.env.CLAW_BENCH_DB_LOCK_TIMEOUT_MS = prevTimeout;
    try {
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
      if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
    } catch {
      /* ignore */
    }
  });

  it("waits for lock release and then proceeds", async () => {
    const { query } = await import("../store.js");
    process.env.CLAW_BENCH_DB_LOCK_RETRY_MS = "20";
    process.env.CLAW_BENCH_DB_LOCK_TIMEOUT_MS = "1000";
    process.env.CLAW_BENCH_DB_LOCK_STALE_MS = "3600000";

    fs.writeFileSync(lockFile, JSON.stringify({ pid: 9999, started_at: new Date().toISOString() }));
    const started = Date.now();
    setTimeout(() => {
      try {
        if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
      } catch {
        /* ignore */
      }
    }, 120);

    const rows = await query("SELECT 1 AS n");
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 80, `expected wait >= 80ms, got ${elapsed}ms`);
    assert.deepEqual(rows, []);
  });

  it("times out when lock is held too long", async () => {
    const { query } = await import("../store.js");
    process.env.CLAW_BENCH_DB_LOCK_RETRY_MS = "20";
    process.env.CLAW_BENCH_DB_LOCK_TIMEOUT_MS = "150";
    process.env.CLAW_BENCH_DB_LOCK_STALE_MS = "3600000";

    fs.writeFileSync(lockFile, JSON.stringify({ pid: 9999, started_at: new Date().toISOString() }));
    await assert.rejects(
      async () => query("SELECT 1 AS n"),
      /Timed out waiting for DB lock/
    );
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  });

  it("removes stale lock and proceeds", async () => {
    const { query } = await import("../store.js");
    process.env.CLAW_BENCH_DB_LOCK_RETRY_MS = "20";
    process.env.CLAW_BENCH_DB_LOCK_TIMEOUT_MS = "3000";
    process.env.CLAW_BENCH_DB_LOCK_STALE_MS = "10000";

    fs.writeFileSync(lockFile, JSON.stringify({ pid: 9999, started_at: new Date().toISOString() }));
    const old = new Date(Date.now() - 30000);
    fs.utimesSync(lockFile, old, old);

    const rows = await query("SELECT 1 AS n");
    assert.deepEqual(rows, []);
    assert.equal(fs.existsSync(lockFile), false);
  });
});
