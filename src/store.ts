/**
 * store.ts — SQLite-backed persistence for benchmark runs and ClawHub metadata.
 *
 * Uses sql.js (pure JS, no native build). The database is a single file:
 *   ~/.claw-bench/bench.db   (default)
 *   or CLAW_BENCH_DB env var
 *
 * Schema is forward-compatible with Postgres: all types map directly.
 * Migrating later = dump to CSV, load into Postgres, done.
 *
 * Migration: on open, runs MIGRATE() which is idempotent — safe to call
 * repeatedly. Drops the old install_counts table if present and creates
 * the new metadata tables.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { BenchmarkReport, SkillMetadata, ClawHubSkillEntry, ClawHubAnalysis } from "./types.js";
import {
  CLAWHUB_LLM_LATEST_PER_MODEL_SUB,
  buildClawhubLlmAggregateSubquery,
  clawhubOverallCompositeSqlExpr,
} from "./clawhub-scoring.js";

// ── DB path ────────────────────────────────────────────────────────────────

export function dbPath(): string {
  return (
    process.env.CLAW_BENCH_DB ??
    path.join(os.homedir(), ".claw-bench", "bench.db")
  );
}

// ── Schema ─────────────────────────────────────────────────────────────────

// sql.js does not reliably support WAL; using the default journal mode avoids
// "disk I/O error" during migrate() on some platforms.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at           TEXT    NOT NULL,
  benchmarked_at        TEXT    NOT NULL,
  skill_name            TEXT    NOT NULL,
  skill_version         TEXT,
  skill_type            TEXT    NOT NULL,
  skill_path            TEXT    NOT NULL,
  score_type            TEXT    NOT NULL,
  composite             REAL    NOT NULL,
  score_correctness     REAL,
  score_consistency     REAL    NOT NULL,
  score_robustness      REAL    NOT NULL,
  score_latency         REAL    NOT NULL,
  consistency_min_sim   REAL    NOT NULL,
  consistency_avg_sim   REAL    NOT NULL,
  consistency_stable    INTEGER NOT NULL,
  robustness_crashes    INTEGER NOT NULL,
  latency_p50_ms        INTEGER NOT NULL,
  latency_p95_ms        INTEGER NOT NULL,
  embed_model           TEXT    NOT NULL,
  consistency_threshold REAL    NOT NULL,
  consistency_runs      INTEGER NOT NULL,
  latency_threshold_ms  INTEGER NOT NULL,
  skipped               INTEGER NOT NULL DEFAULT 0,
  skipped_reason        TEXT
);

-- One row per skill. Upserted on every import.
CREATE TABLE IF NOT EXISTS skill_metadata (
  skill_name          TEXT    PRIMARY KEY,
  author              TEXT    NOT NULL,
  verified_author     INTEGER NOT NULL DEFAULT 0,  -- 0 | 1
  tags                TEXT    NOT NULL DEFAULT '[]', -- JSON array
  star_rating         REAL,                         -- 0–5, null if unrated
  star_count          INTEGER NOT NULL DEFAULT 0,
  latest_version      TEXT,
  total_versions      INTEGER NOT NULL DEFAULT 0,
  dependency_count    INTEGER NOT NULL DEFAULT 0,
  first_published_at  TEXT,
  last_updated_at     TEXT,
  metadata_recorded_at TEXT   NOT NULL              -- when we pulled this from ClawHub
);

-- Time-series install snapshots (append-only).
CREATE TABLE IF NOT EXISTS install_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name    TEXT    NOT NULL,
  recorded_at   TEXT    NOT NULL,
  install_count INTEGER NOT NULL,
  -- delta from previous snapshot for this skill; null on first row
  delta         INTEGER
);

-- All known versions per skill.
CREATE TABLE IF NOT EXISTS version_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name   TEXT    NOT NULL,
  version      TEXT    NOT NULL,
  published_at TEXT,
  is_latest    INTEGER NOT NULL DEFAULT 0,
  UNIQUE(skill_name, version)
);

-- Normalised dependency graph.
CREATE TABLE IF NOT EXISTS skill_dependencies (
  skill_name TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (skill_name, depends_on)
);

-- ClawHub skill catalog (scraped metadata).
CREATE TABLE IF NOT EXISTS clawhub_skills (
  slug             TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT,
  author           TEXT,
  version          TEXT,
  downloads        TEXT,
  stars            TEXT,
  version_count    INTEGER,
  published_at     TEXT,
  scraped_at       TEXT NOT NULL,
  zip_path         TEXT,
  extracted_path   TEXT,
  has_scripts      INTEGER NOT NULL DEFAULT 0,
  file_count       INTEGER NOT NULL DEFAULT 0,
  total_size_bytes INTEGER NOT NULL DEFAULT 0,
  skill_md_length  INTEGER NOT NULL DEFAULT 0
);

-- Analysis results for ClawHub skills (one row per analysis run).
CREATE TABLE IF NOT EXISTS clawhub_analysis (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT    NOT NULL,
  analyzed_at       TEXT    NOT NULL,
  doc_quality       REAL    NOT NULL,
  completeness      REAL    NOT NULL,
  security          REAL    NOT NULL,
  code_quality      REAL,
  maintainability   REAL    NOT NULL,
  static_composite  REAL    NOT NULL,
  llm_clarity       REAL,
  llm_usefulness    REAL,
  llm_safety        REAL,
  llm_completeness  REAL,
  llm_composite     REAL,
  llm_model         TEXT,
  llm_reasoning     TEXT,
  overall_composite REAL    NOT NULL,
  extract_ms           INTEGER,
  static_analysis_ms   INTEGER,
  llm_ms               INTEGER,
  file_stats_ms        INTEGER,
  pipeline_ms          INTEGER,
  analysis_insights    TEXT,
  FOREIGN KEY (slug) REFERENCES clawhub_skills(slug)
);

CREATE INDEX IF NOT EXISTS idx_runs_skill_name      ON runs(skill_name);
CREATE INDEX IF NOT EXISTS idx_runs_skill_type      ON runs(skill_type);
CREATE INDEX IF NOT EXISTS idx_runs_recorded_at     ON runs(recorded_at);
CREATE INDEX IF NOT EXISTS idx_runs_skill_version   ON runs(skill_name, skill_version);
CREATE INDEX IF NOT EXISTS idx_install_history_skill ON install_history(skill_name);
CREATE INDEX IF NOT EXISTS idx_version_history_skill ON version_history(skill_name);
CREATE INDEX IF NOT EXISTS idx_deps_skill            ON skill_dependencies(skill_name);
CREATE INDEX IF NOT EXISTS idx_deps_depends_on       ON skill_dependencies(depends_on);
CREATE INDEX IF NOT EXISTS idx_clawhub_analysis_slug ON clawhub_analysis(slug);
`;

// ── Migration (idempotent) ─────────────────────────────────────────────────

function clawhubAnalysisColumnNames(db: Database): Set<string> {
  const names = new Set<string>();
  const stmt = db.prepare("PRAGMA table_info(clawhub_analysis)");
  while (stmt.step()) {
    const row = stmt.getAsObject() as { name?: string };
    if (row.name) names.add(row.name);
  }
  stmt.free();
  return names;
}

function ensureClawhubAnalysisTimingColumns(db: Database): void {
  if (!clawhubAnalysisColumnNames(db).has("slug")) return;
  const cols = clawhubAnalysisColumnNames(db);
  const add = (name: string) => {
    if (!cols.has(name)) {
      db.run(`ALTER TABLE clawhub_analysis ADD COLUMN ${name} INTEGER`);
      cols.add(name);
    }
  };
  add("extract_ms");
  add("static_analysis_ms");
  add("llm_ms");
  add("file_stats_ms");
  add("pipeline_ms");
  add("analysis_insights");
}

function migrate(db: Database): void {
  // Drop old install_counts table if it exists from a previous schema version
  db.run(`DROP TABLE IF EXISTS install_counts`);
  // `run()` only executes a single statement; `exec()` applies the full schema.
  db.exec(SCHEMA);
  ensureClawhubAnalysisTimingColumns(db);
}

/** Stale -wal / -shm from legacy WAL mode break sql.js opens — safe to remove for this app. */
function stripWalSidecarFiles(mainDbPath: string): void {
  for (const ext of ["-wal", "-shm"] as const) {
    const p = mainDbPath + ext;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

// ── SQL.js singleton (lazy init) ───────────────────────────────────────────

let _SQL: SqlJsStatic | null = null;

async function getSql(): Promise<SqlJsStatic> {
  if (!_SQL) _SQL = await initSqlJs();
  return _SQL;
}

// ── Serialization lock ─────────────────────────────────────────────────────

let _dbLock: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireProcessDbLock(dbFilePath: string): Promise<() => void> {
  const lockPath = `${dbFilePath}.lock`;
  const retryMs = Math.max(25, parseInt(process.env.CLAW_BENCH_DB_LOCK_RETRY_MS ?? "100", 10) || 100);
  const staleMs = Math.max(10_000, parseInt(process.env.CLAW_BENCH_DB_LOCK_STALE_MS ?? "21600000", 10) || 21_600_000); // 6h
  const timeoutMs = Math.max(0, parseInt(process.env.CLAW_BENCH_DB_LOCK_TIMEOUT_MS ?? "0", 10) || 0); // 0 = wait forever
  const started = Date.now();

  while (true) {
    try {
      const dir = path.dirname(dbFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), db: dbFilePath })
      );
      fs.closeSync(fd);
      return () => {
        try {
          if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;

      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // lock disappeared between checks; retry quickly
        continue;
      }

      if (timeoutMs > 0 && Date.now() - started > timeoutMs) {
        throw new Error(
          `Timed out waiting for DB lock: ${lockPath} (timeout ${timeoutMs}ms). ` +
          `Set CLAW_BENCH_DB_LOCK_TIMEOUT_MS=0 to wait indefinitely.`
        );
      }
      await sleep(retryMs);
    }
  }
}

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const p = _dbLock.then(async () => {
    const release = await acquireProcessDbLock(dbPath());
    try {
      return await fn();
    } finally {
      release();
    }
  });
  _dbLock = p.catch(() => {});
  return p;
}

// ── Load / save ────────────────────────────────────────────────────────────

function loadDb(SQL: SqlJsStatic, filePath: string): Database {
  if (fs.existsSync(filePath)) {
    stripWalSidecarFiles(filePath);
  }
  const db = fs.existsSync(filePath)
    ? new SQL.Database(fs.readFileSync(filePath))
    : new SQL.Database();
  migrate(db);
  return db;
}

function saveDb(db: Database, filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(db.export()));
}

// ── Benchmark run storage ──────────────────────────────────────────────────

export interface StoreRunOptions {
  skillVersion?: string;
}

export function storeRun(
  report: BenchmarkReport,
  opts: StoreRunOptions = {}
): Promise<number> {
  return serialize(async () => {
  const SQL = await getSql();
  const fp = dbPath();
  const db = loadDb(SQL, fp);

  const d = report.dimensions;
  const s = report.score;

  db.run(
    `INSERT INTO runs (
      recorded_at, benchmarked_at, skill_name, skill_version, skill_type, skill_path,
      score_type, composite,
      score_correctness, score_consistency, score_robustness, score_latency,
      consistency_min_sim, consistency_avg_sim, consistency_stable,
      robustness_crashes, latency_p50_ms, latency_p95_ms,
      embed_model, consistency_threshold, consistency_runs, latency_threshold_ms,
      skipped, skipped_reason
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      new Date().toISOString(),
      report.generatedAt,
      report.skillName,
      opts.skillVersion ?? null,
      report.skillType,
      report.skillPath,
      report.scoreType,
      s.composite,
      s.type === "authored" ? s.correctness : null,
      s.consistency,
      s.robustness,
      s.latency,
      d.consistency.minSimilarity,
      d.consistency.avgSimilarity,
      d.consistency.stable ? 1 : 0,
      d.robustness.crashes,
      d.latency.p50Ms,
      d.latency.p95Ms,
      report.config.embedModel,
      report.config.consistencyThreshold,
      report.config.consistencyRuns,
      report.config.latencyThresholdMs,
      report.skippedReason ? 1 : 0,
      report.skippedReason ?? null,
    ]
  );

  const result = db.exec("SELECT last_insert_rowid()");
  const rowid = result[0]?.values[0]?.[0] as number;
  saveDb(db, fp);
  db.close();
  return rowid;
  });
}

// ── Skill metadata import ──────────────────────────────────────────────────

/**
 * Upsert a batch of SkillMetadata records.
 *
 * install_history is append-only — we compute the delta from the last
 * known snapshot for each skill before inserting.
 *
 * version_history uses INSERT OR IGNORE so re-importing the same version
 * does not create duplicate rows.
 *
 * skill_dependencies is fully replaced per skill on each import.
 */
export function importSkillMetadata(
  skills: SkillMetadata[]
): Promise<{ upserted: number; installSnapshots: number; versions: number; deps: number }> {
  return serialize(async () => {
  const SQL = await getSql();
  const fp = dbPath();
  const db = loadDb(SQL, fp);
  const now = new Date().toISOString();

  let upserted = 0;
  let installSnapshots = 0;
  let versions = 0;
  let deps = 0;

  for (const skill of skills) {
    // ── skill_metadata (upsert) ──────────────────────────────────────────
    db.run(
      `INSERT INTO skill_metadata (
        skill_name, author, verified_author, tags, star_rating, star_count,
        latest_version, total_versions, dependency_count,
        first_published_at, last_updated_at, metadata_recorded_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(skill_name) DO UPDATE SET
        author              = excluded.author,
        verified_author     = excluded.verified_author,
        tags                = excluded.tags,
        star_rating         = excluded.star_rating,
        star_count          = excluded.star_count,
        latest_version      = excluded.latest_version,
        total_versions      = excluded.total_versions,
        dependency_count    = excluded.dependency_count,
        first_published_at  = excluded.first_published_at,
        last_updated_at     = excluded.last_updated_at,
        metadata_recorded_at = excluded.metadata_recorded_at`,
      [
        skill.skillName,
        skill.author,
        skill.verifiedAuthor ? 1 : 0,
        JSON.stringify(skill.tags),
        skill.starRating ?? null,
        skill.starCount,
        skill.latestVersion ?? null,
        skill.versionHistory.length,
        skill.dependencyNames.length,
        skill.firstPublishedAt ?? null,
        skill.lastUpdatedAt ?? null,
        now,
      ]
    );
    upserted++;

    // ── install_history (append new snapshots only) ──────────────────────
    for (const snapshot of skill.installHistory) {
      // Get the most recent install count for this skill to compute delta
      const prev = db.exec(
        `SELECT install_count FROM install_history
         WHERE skill_name = ? ORDER BY recorded_at DESC LIMIT 1`,
        [skill.skillName]
      );
      const prevCount = prev[0]?.values[0]?.[0] as number | undefined;
      const delta = prevCount !== undefined ? snapshot.installCount - prevCount : null;

      // Skip if this exact (skill, recorded_at) snapshot already exists
      const exists = db.exec(
        `SELECT 1 FROM install_history WHERE skill_name = ? AND recorded_at = ?`,
        [skill.skillName, snapshot.recordedAt]
      );
      if (exists[0]?.values.length) continue;

      db.run(
        `INSERT INTO install_history (skill_name, recorded_at, install_count, delta)
         VALUES (?,?,?,?)`,
        [skill.skillName, snapshot.recordedAt, snapshot.installCount, delta]
      );
      installSnapshots++;
    }

    // ── version_history (INSERT OR IGNORE — never duplicate) ────────────
    for (const v of skill.versionHistory) {
      // Mark all versions for this skill as not-latest first
      if (v.isLatest) {
        db.run(
          `UPDATE version_history SET is_latest = 0 WHERE skill_name = ?`,
          [skill.skillName]
        );
      }
      db.run(
        `INSERT OR IGNORE INTO version_history (skill_name, version, published_at, is_latest)
         VALUES (?,?,?,?)`,
        [skill.skillName, v.version, v.publishedAt ?? null, v.isLatest ? 1 : 0]
      );
      if (db.getRowsModified() > 0) versions++;
    }

    // ── skill_dependencies (replace per skill) ───────────────────────────
    db.run(`DELETE FROM skill_dependencies WHERE skill_name = ?`, [skill.skillName]);
    for (const dep of skill.dependencyNames) {
      db.run(
        `INSERT INTO skill_dependencies (skill_name, depends_on) VALUES (?,?)`,
        [skill.skillName, dep]
      );
      deps++;
    }
  }

  saveDb(db, fp);
  db.close();
  return { upserted, installSnapshots, versions, deps };
  });
}

// ── Low-level query helper ────────────────────────────────────────────────

export function query<T = Record<string, unknown>>(
  sql: string,
  params: (string | number | null)[] = []
): Promise<T[]> {
  return serialize(async () => {
    const SQL = await getSql();
    const fp = dbPath();
    if (!fs.existsSync(fp)) return [];

    const db = loadDb(SQL, fp);
    const results: T[] = [];
    const stmt = db.prepare(sql);
    stmt.bind(params);
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T);
    }
    stmt.free();
    db.close();
    return results;
  });
}

export async function runCount(): Promise<number> {
  const rows = await query<{ n: number }>("SELECT COUNT(*) as n FROM runs");
  return rows[0]?.n ?? 0;
}

export async function metadataCount(): Promise<number> {
  const rows = await query<{ n: number }>("SELECT COUNT(*) as n FROM skill_metadata");
  return rows[0]?.n ?? 0;
}

// ── ClawHub skill catalog CRUD ────────────────────────────────────────────

export function upsertClawHubSkill(
  entry: ClawHubSkillEntry,
  extra: {
    zipPath?: string;
    extractedPath?: string;
    hasScripts?: boolean;
    fileCount?: number;
    totalSizeBytes?: number;
    skillMdLength?: number;
  } = {}
): Promise<void> {
  return serialize(async () => {
    const SQL = await getSql();
    const fp = dbPath();
    const db = loadDb(SQL, fp);
    db.run(
      `INSERT INTO clawhub_skills (
        slug, name, description, author, version, downloads, stars,
        version_count, scraped_at, zip_path, extracted_path,
        has_scripts, file_count, total_size_bytes, skill_md_length
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(slug) DO UPDATE SET
        name             = excluded.name,
        description      = excluded.description,
        author           = excluded.author,
        version          = excluded.version,
        downloads        = excluded.downloads,
        stars            = excluded.stars,
        version_count    = excluded.version_count,
        scraped_at       = excluded.scraped_at,
        zip_path         = COALESCE(excluded.zip_path, clawhub_skills.zip_path),
        extracted_path   = COALESCE(excluded.extracted_path, clawhub_skills.extracted_path),
        has_scripts      = CASE WHEN excluded.has_scripts > 0 THEN excluded.has_scripts ELSE clawhub_skills.has_scripts END,
        file_count       = CASE WHEN excluded.file_count > 0 THEN excluded.file_count ELSE clawhub_skills.file_count END,
        total_size_bytes = CASE WHEN excluded.total_size_bytes > 0 THEN excluded.total_size_bytes ELSE clawhub_skills.total_size_bytes END,
        skill_md_length  = CASE WHEN excluded.skill_md_length > 0 THEN excluded.skill_md_length ELSE clawhub_skills.skill_md_length END`,
      [
        entry.slug,
        entry.name,
        entry.summary,
        entry.author,
        entry.version,
        entry.downloads,
        entry.stars,
        entry.versionCount,
        new Date().toISOString(),
        extra.zipPath ?? null,
        extra.extractedPath ?? null,
        extra.hasScripts ? 1 : 0,
        extra.fileCount ?? 0,
        extra.totalSizeBytes ?? 0,
        extra.skillMdLength ?? 0,
      ]
    );
    saveDb(db, fp);
    db.close();
  });
}

/** True if we already stored a successful LLM composite for this slug + model (skips redundant `--llm` runs). */
export async function hasClawHubLlmAnalysisForModel(
  slug: string,
  llmModel: string
): Promise<boolean> {
  const rows = await query<{ n: number }>(
    `SELECT 1 AS n FROM clawhub_analysis
     WHERE slug = ? AND llm_model = ? AND llm_composite IS NOT NULL
     LIMIT 1`,
    [slug, llmModel]
  );
  return rows.length > 0;
}

/** Remove every row in `clawhub_analysis` (full catalog re-analyze). */
export function deleteAllClawHubAnalysis(): Promise<void> {
  return serialize(async () => {
    const SQL = await getSql();
    const fp = dbPath();
    if (!fs.existsSync(fp)) return;
    const db = loadDb(SQL, fp);
    db.run("DELETE FROM clawhub_analysis");
    saveDb(db, fp);
    db.close();
  });
}

/** Remove all analysis history for the given slugs (chunked for large lists). */
export function deleteClawHubAnalysisForSlugs(slugs: string[]): Promise<void> {
  if (slugs.length === 0) return Promise.resolve();
  return serialize(async () => {
    const SQL = await getSql();
    const fp = dbPath();
    if (!fs.existsSync(fp)) return;
    const db = loadDb(SQL, fp);
    const chunk = 400;
    for (let i = 0; i < slugs.length; i += chunk) {
      const part = slugs.slice(i, i + chunk);
      const placeholders = part.map(() => "?").join(",");
      db.run(`DELETE FROM clawhub_analysis WHERE slug IN (${placeholders})`, part);
    }
    saveDb(db, fp);
    db.close();
  });
}

/** Remove analysis rows for one LLM model across all slugs. */
export function deleteAllClawHubAnalysisForModel(llmModel: string): Promise<void> {
  return serialize(async () => {
    const SQL = await getSql();
    const fp = dbPath();
    if (!fs.existsSync(fp)) return;
    const db = loadDb(SQL, fp);
    db.run("DELETE FROM clawhub_analysis WHERE llm_model = ?", [llmModel]);
    saveDb(db, fp);
    db.close();
  });
}

/** Remove analysis rows for specific slugs, but only for one LLM model. */
export function deleteClawHubAnalysisForSlugsAndModel(
  slugs: string[],
  llmModel: string
): Promise<void> {
  if (slugs.length === 0) return Promise.resolve();
  return serialize(async () => {
    const SQL = await getSql();
    const fp = dbPath();
    if (!fs.existsSync(fp)) return;
    const db = loadDb(SQL, fp);
    const chunk = 400;
    for (let i = 0; i < slugs.length; i += chunk) {
      const part = slugs.slice(i, i + chunk);
      const placeholders = part.map(() => "?").join(",");
      db.run(
        `DELETE FROM clawhub_analysis WHERE llm_model = ? AND slug IN (${placeholders})`,
        [llmModel, ...part]
      );
    }
    saveDb(db, fp);
    db.close();
  });
}

export function storeClawHubAnalysis(analysis: ClawHubAnalysis): Promise<number> {
  return serialize(async () => {
    const SQL = await getSql();
    const fp = dbPath();
    const db = loadDb(SQL, fp);

    const s = analysis.staticAnalysis;
    const l = analysis.llmEval;
    const tm = analysis.timing;
    const insightsJson = analysis.insights ? JSON.stringify(analysis.insights) : null;

    db.run(
      `INSERT INTO clawhub_analysis (
        slug, analyzed_at,
        doc_quality, completeness, security, code_quality, maintainability, static_composite,
        llm_clarity, llm_usefulness, llm_safety, llm_completeness, llm_composite,
        llm_model, llm_reasoning, overall_composite,
        extract_ms, static_analysis_ms, llm_ms, file_stats_ms, pipeline_ms,
        analysis_insights
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        analysis.slug,
        analysis.analyzedAt,
        s.docQuality,
        s.completeness,
        s.security,
        s.codeQuality,
        s.maintainability,
        s.staticComposite,
        l?.clarity ?? null,
        l?.usefulness ?? null,
        l?.safety ?? null,
        l?.completeness ?? null,
        l?.llmComposite ?? null,
        l?.model ?? null,
        l?.reasoning ?? null,
        analysis.overallComposite,
        tm.extractMs,
        tm.staticMs,
        tm.llmMs,
        tm.fileStatsMs,
        tm.pipelineMs,
        insightsJson,
      ]
    );

    const result = db.exec("SELECT last_insert_rowid()");
    const rowid = result[0]?.values[0]?.[0] as number;

    // Update file stats on the skill row
    const fs2 = analysis.fileStats;
    db.run(
      `UPDATE clawhub_skills SET
        has_scripts = ?, file_count = ?, total_size_bytes = ?, skill_md_length = ?
       WHERE slug = ?`,
      [fs2.hasScripts ? 1 : 0, fs2.fileCount, fs2.totalSizeBytes, fs2.skillMdLength, analysis.slug]
    );

    saveDb(db, fp);
    db.close();
    return rowid;
  });
}

/** Latest analysis row per skill (static + metadata). */
const CLAWHUB_LATEST_ANALYSIS_SUB = `
  SELECT *, ROW_NUMBER() OVER (PARTITION BY slug ORDER BY analyzed_at DESC) AS rn
  FROM clawhub_analysis
`;

function clawhubCatalogAnalysisJoinSql(): string {
  const llmAgg = buildClawhubLlmAggregateSubquery().trim();
  return `FROM clawhub_skills s
LEFT JOIN (
  ${CLAWHUB_LATEST_ANALYSIS_SUB}
) latest ON latest.slug = s.slug AND latest.rn = 1
LEFT JOIN (
  ${llmAgg}
) llm ON llm.slug = s.slug
LEFT JOIN (
  SELECT
    lp.slug,
    json_group_array(
      json_object(
        'model', lp.llm_model,
        'analyzed_at', lp.analyzed_at,
        'llm_clarity', lp.llm_clarity,
        'llm_usefulness', lp.llm_usefulness,
        'llm_safety', lp.llm_safety,
        'llm_completeness', lp.llm_completeness,
        'llm_composite', lp.llm_composite
      )
    ) AS llm_models_json
  FROM (${CLAWHUB_LLM_LATEST_PER_MODEL_SUB}) lp
  WHERE lp.rnm = 1
  GROUP BY lp.slug
) llm_json ON llm_json.slug = s.slug`;
}

function clawhubCatalogSelectSql(): string {
  const overall = clawhubOverallCompositeSqlExpr();
  return `SELECT s.*,
       latest.doc_quality, latest.completeness AS completeness_score, latest.security,
       latest.code_quality, latest.maintainability, latest.static_composite,
       llm.llm_clarity, llm.llm_usefulness, llm.llm_safety, llm.llm_completeness,
       llm.llm_composite,
       llm.llm_model_count,
       llm_json.llm_models_json,
       (${overall}) AS overall_composite,
       (SELECT MAX(ca.analyzed_at) FROM clawhub_analysis ca WHERE ca.slug = s.slug) AS analyzed_at,
       CASE WHEN latest.id IS NOT NULL THEN 1 ELSE 0 END AS analyzed`;
}

export interface ClawHubCatalogPageOpts {
  page: number;
  limit: number;
  sort: "overall" | "name" | "downloads" | "stars";
  q?: string;
  analyzedOnly?: boolean;
  withScripts?: boolean;
}

function catalogOrderBy(sort: ClawHubCatalogPageOpts["sort"]): string {
  const overall = clawhubOverallCompositeSqlExpr();
  switch (sort) {
    case "name":
      return "s.name COLLATE NOCASE ASC";
    case "downloads":
      return "s.downloads DESC";
    case "stars":
      return "s.stars DESC";
    default:
      return `CASE WHEN (${overall}) IS NULL THEN 1 ELSE 0 END,
              (${overall}) DESC,
              s.slug ASC`;
  }
}

/** Paginated catalog for the dashboard (search + filters + sort). */
export async function getClawHubSkillsPaged(
  opts: ClawHubCatalogPageOpts
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const page = Math.max(1, opts.page);
  const limit = Math.min(200, Math.max(1, opts.limit));
  const offset = (page - 1) * limit;

  const conditions: string[] = ["1=1"];
  const params: (string | number)[] = [];

  const q = opts.q?.trim();
  if (q) {
    const like = `%${q}%`;
    conditions.push(
      "(s.slug LIKE ? OR s.name LIKE ? OR s.author LIKE ? OR IFNULL(s.description,'') LIKE ?)"
    );
    params.push(like, like, like, like);
  }
  if (opts.analyzedOnly) {
    conditions.push("latest.id IS NOT NULL");
  }
  if (opts.withScripts) {
    conditions.push("s.has_scripts = 1");
  }

  const whereSql = conditions.join(" AND ");
  const orderSql = catalogOrderBy(opts.sort);

  const joinSql = clawhubCatalogAnalysisJoinSql();
  const selectSql = clawhubCatalogSelectSql();
  const countSql = `SELECT COUNT(*) as n ${joinSql} WHERE ${whereSql}`;
  const dataSql = `${selectSql} ${joinSql} WHERE ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`;

  const totalRows = await query<{ n: number }>(countSql, params);
  const total = totalRows[0]?.n ?? 0;

  const rows = await query<Record<string, unknown>>(dataSql, [...params, limit, offset]);
  return { rows, total };
}

/** Full catalog (CLI / legacy); avoid for large DBs — use getClawHubSkillsPaged. */
export async function getClawHubSkills(): Promise<Record<string, unknown>[]> {
  const joinSql = clawhubCatalogAnalysisJoinSql();
  const selectSql = clawhubCatalogSelectSql();
  const overall = clawhubOverallCompositeSqlExpr();
  return query(
    `${selectSql} ${joinSql}
     ORDER BY CASE WHEN (${overall}) IS NULL THEN 1 ELSE 0 END,
              (${overall}) DESC,
              s.slug ASC`
  );
}

export async function getClawHubSkillDetail(slug: string): Promise<Record<string, unknown> | null> {
  const llmAgg = buildClawhubLlmAggregateSubquery().trim();
  const overall = clawhubOverallCompositeSqlExpr();
  const LLM_DETAIL_JSON_SUB = `
    SELECT
      lp.slug,
      json_group_array(
        json_object(
          'model', lp.llm_model,
          'analyzed_at', lp.analyzed_at,
          'llm_clarity', lp.llm_clarity,
          'llm_usefulness', lp.llm_usefulness,
          'llm_safety', lp.llm_safety,
          'llm_completeness', lp.llm_completeness,
          'llm_composite', lp.llm_composite,
          'llm_reasoning', lp.llm_reasoning
        )
      ) AS llm_models_json
    FROM (${CLAWHUB_LLM_LATEST_PER_MODEL_SUB}) lp
    WHERE lp.rnm = 1 AND lp.slug = ?
    GROUP BY lp.slug
  `;

  const rows = await query(
    `SELECT s.*,
       latest.doc_quality, latest.completeness AS completeness_score, latest.security,
       latest.code_quality, latest.maintainability, latest.static_composite,
       llm.llm_clarity, llm.llm_usefulness, llm.llm_safety, llm.llm_completeness,
       llm.llm_composite,
       llm.llm_model_count,
       detail.llm_models_json,
       latest.llm_model AS llm_model,
       latest.llm_reasoning AS llm_reasoning,
       (${overall}) AS overall_composite,
       (SELECT MAX(ca.analyzed_at) FROM clawhub_analysis ca WHERE ca.slug = s.slug) AS analyzed_at,
       CASE WHEN latest.id IS NOT NULL THEN 1 ELSE 0 END AS analyzed
     FROM clawhub_skills s
     LEFT JOIN (
       ${CLAWHUB_LATEST_ANALYSIS_SUB}
     ) latest ON latest.slug = s.slug AND latest.rn = 1
     LEFT JOIN (
       ${llmAgg}
     ) llm ON llm.slug = s.slug
     LEFT JOIN (${LLM_DETAIL_JSON_SUB}) detail ON detail.slug = s.slug
     WHERE s.slug = ?`,
    [slug, slug]
  );
  return rows[0] ?? null;
}

export async function getClawHubCatalogStats(): Promise<{
  totalSkills: number;
  analyzedCount: number;
  avgOverallComposite: number;
  avgStaticComposite: number;
  withScripts: number;
}> {
  const total = await query<{ n: number }>("SELECT COUNT(*) as n FROM clawhub_skills");
  const analyzed = await query<{ n: number }>(
    "SELECT COUNT(DISTINCT slug) as n FROM clawhub_analysis"
  );
  const avgOverall = await query<{ avg: number }>(
    `SELECT AVG(overall_composite) as avg FROM (
       SELECT overall_composite, ROW_NUMBER() OVER (PARTITION BY slug ORDER BY analyzed_at DESC) AS rn
       FROM clawhub_analysis
     ) WHERE rn = 1`
  );
  const avgStatic = await query<{ avg: number }>(
    `SELECT AVG(static_composite) as avg FROM (
       SELECT static_composite, ROW_NUMBER() OVER (PARTITION BY slug ORDER BY analyzed_at DESC) AS rn
       FROM clawhub_analysis
     ) WHERE rn = 1`
  );
  const scripts = await query<{ n: number }>(
    "SELECT COUNT(*) as n FROM clawhub_skills WHERE has_scripts = 1"
  );
  return {
    totalSkills: total[0]?.n ?? 0,
    analyzedCount: analyzed[0]?.n ?? 0,
    avgOverallComposite: avgOverall[0]?.avg ?? 0,
    avgStaticComposite: avgStatic[0]?.avg ?? 0,
    withScripts: scripts[0]?.n ?? 0,
  };
}
