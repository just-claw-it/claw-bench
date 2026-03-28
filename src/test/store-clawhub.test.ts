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
      "SELECT extract_ms, static_analysis_ms, llm_ms, file_stats_ms, pipeline_ms, llm_model FROM clawhub_analysis WHERE slug = ?",
      [entry.slug]
    );
    assert.equal(rows0.length, 1);
    assert.equal(rows0[0].extract_ms, 42);
    assert.equal(rows0[0].static_analysis_ms, 15);
    assert.equal(rows0[0].llm_ms, null);
    assert.equal(rows0[0].file_stats_ms, 2);
    assert.equal(rows0[0].pipeline_ms, 20);
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
});
