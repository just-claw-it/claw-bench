/**
 * Dashboard data contract: catalog detail query + HTTP GET /api/catalog/:slug
 * (timings, analysis_insights, import-metadata join).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

import type { ClawHubAnalysis, ClawHubSkillEntry, SkillMetadata } from "../types.js";

const slug = "dashboard-api-skill";

const entry: ClawHubSkillEntry = {
  slug,
  name: "Dashboard API Test",
  author: "t",
  version: "1.0.0",
  summary: "s",
  downloads: "1k",
  stars: "1",
  versionCount: 1,
};

function baseAnalysis(): ClawHubAnalysis {
  return {
    slug,
    analyzedAt: new Date().toISOString(),
    staticAnalysis: {
      docQuality: 0.8,
      completeness: 0.7,
      security: 0.9,
      codeQuality: null,
      maintainability: 0.6,
      staticComposite: 0.75,
    },
    llmEval: null,
    overallComposite: 0.75,
    fileStats: {
      fileCount: 1,
      totalSizeBytes: 100,
      hasScripts: false,
      skillMdLength: 50,
      languages: ["markdown"],
    },
    insights: {
      complexity: "simple",
      scriptFiles: 0,
      totalLoc: 10,
      maxFileLoc: 10,
      primaryLanguage: null,
      languageBreakdown: [],
      describedLanguages: [],
      undocumentedLanguages: [],
      missingFromCode: [],
      credentialHygiene: {
        declaredCredentialVars: [],
        observedCredentialVars: [],
        undeclaredCredentialVars: [],
        declaredButUnusedCredentialVars: [],
        hasEnvExample: false,
        envExampleCoverage: 0,
        hygieneScore: 1,
        hygieneLevel: "good",
      },
      securityFindings: {
        filesScanned: 0,
        dangerousMatches: 0,
        secretMatches: 0,
        exfiltrationMatches: 0,
        flaggedFiles: [],
        potentialDataLeakage: false,
      },
    },
    timing: {
      extractMs: 5,
      staticMs: 12,
      llmMs: null,
      fileStatsMs: 3,
      pipelineMs: 25,
    },
  };
}

function sampleMetadata(): SkillMetadata {
  const recordedAt = "2026-03-01T00:00:00.000Z";
  return {
    skillName: slug,
    author: "import-author",
    verifiedAuthor: true,
    tags: ["dash", "test"],
    starRating: 4.5,
    starCount: 3,
    latestVersion: "1.0.0",
    firstPublishedAt: "2026-01-01T00:00:00.000Z",
    lastUpdatedAt: "2026-03-01T00:00:00.000Z",
    dependencyNames: [],
    installHistory: [{ recordedAt, installCount: 50 }],
    versionHistory: [{ version: "1.0.0", publishedAt: "2026-01-01T00:00:00.000Z", isLatest: true }],
  };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("dashboard catalog API contract", () => {
  const dbFile = path.join(os.tmpdir(), `claw-bench-dashboard-api-${process.pid}.db`);
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

  it("getClawHubSkillDetail exposes timings, analysis_insights, import_meta_*", async () => {
    const { upsertClawHubSkill, storeClawHubAnalysis, importSkillMetadata, getClawHubSkillDetail } =
      await import("../store.js");

    await upsertClawHubSkill(entry, {});
    await storeClawHubAnalysis(baseAnalysis());
    await importSkillMetadata([sampleMetadata()]);

    const detail = await getClawHubSkillDetail(slug);
    assert.ok(detail);
    assert.equal(detail.slug, slug);
    assert.equal(detail.extract_ms, 5);
    assert.equal(detail.static_analysis_ms, 12);
    assert.equal(detail.llm_ms, null);
    assert.equal(detail.file_stats_ms, 3);
    assert.equal(detail.pipeline_ms, 25);
    assert.equal(detail.llm_outcome, null);
    assert.equal(typeof detail.analysis_insights, "string");
    const ins = JSON.parse(String(detail.analysis_insights)) as { complexity?: string };
    assert.equal(ins.complexity, "simple");

    assert.ok(detail.import_meta_recorded_at);
    assert.equal(detail.import_meta_author, "import-author");
    assert.equal(detail.import_meta_verified_author, 1);
    assert.ok(String(detail.import_meta_tags).includes("dash"));
    assert.equal(detail.import_meta_star_count, 3);
  });

  it("getClawHubSkillsPaged includes pipeline_ms per row", async () => {
    const { getClawHubSkillsPaged } = await import("../store.js");
    const { rows } = await getClawHubSkillsPaged({
      page: 1,
      limit: 50,
      sort: "name",
    });
    const row = rows.find((r) => (r as { slug?: string }).slug === slug) as Record<string, unknown> | undefined;
    assert.ok(row);
    assert.equal(row.pipeline_ms, 25);
  });

  it("GET /api/catalog/:slug returns JSON with timings and insights", async () => {
    const { createDashboardApp } = await import("../server.js");
    const app = createDashboardApp();
    const server = http.createServer(app);

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });

    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/catalog/${encodeURIComponent(slug)}`
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.pipeline_ms, 25);
      assert.equal(body.extract_ms, 5);
      assert.equal(typeof body.analysis_insights, "string");
      assert.ok(body.import_meta_recorded_at);
      assert.ok(Array.isArray(body.files));
    } finally {
      await closeServer(server);
    }
  });
});
