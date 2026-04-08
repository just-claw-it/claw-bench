/**
 * store.ts — SQLite-backed persistence for benchmark runs and ClawHub metadata.
 *
 * Uses sql.js for writes and CLI portability. Read-heavy paths (`withSerializedDb`)
 * prefer `better-sqlite3` when installed (native SQLite, mmap — similar to desktop DB browsers);
 * set `CLAW_BENCH_SQLJS_ONLY=1` to force sql.js. The database is a single file:
 *   <cwd>/clawhub/bench.db   (default)
 *   or CLAW_BENCH_DB env var (absolute or relative path)
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
import { spawnSync } from "node:child_process";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import BetterSqlite from "better-sqlite3";
import {
  BenchmarkReport,
  SkillMetadata,
  ClawHubSkillEntry,
  ClawHubAnalysis,
  ClawHubRuntimeRequirements,
} from "./types.js";
import {
  CLAWHUB_LLM_LATEST_PER_MODEL_SUB,
  buildClawhubLlmAggregateSubquery,
  clawhubOverallCompositeSqlExpr,
} from "./clawhub-scoring.js";

/** Native SQLite instance (better-sqlite3). */
export type NativeReadDb = InstanceType<typeof BetterSqlite>;

/** sql.js or native SQLite — anything passed to {@link dbQueryAll} from {@link withSerializedDb}. */
export type ReadOnlyDb = Database | NativeReadDb;

function getBetterSqliteCtor(): typeof BetterSqlite | null {
  if (process.env.CLAW_BENCH_SQLJS_ONLY === "1") return null;
  return BetterSqlite;
}

function isSqlJsReadDb(db: ReadOnlyDb): db is Database {
  return typeof (db as Database).export === "function";
}

// ── DB path ────────────────────────────────────────────────────────────────

export function dbPath(): string {
  const raw = process.env.CLAW_BENCH_DB?.trim();
  if (raw) return path.resolve(raw);
  return path.resolve(process.cwd(), "clawhub", "bench.db");
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
  llm_outcome          TEXT,
  req_internet         INTEGER,
  req_disk_read        INTEGER,
  req_disk_write       INTEGER,
  req_secrets          INTEGER,
  req_subprocess       INTEGER,
  req_system_tools     INTEGER,
  req_confidence       TEXT,
  req_evidence_json    TEXT,
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
CREATE INDEX IF NOT EXISTS idx_clawhub_analysis_llm_slug
  ON clawhub_analysis(llm_model, slug) WHERE llm_composite IS NOT NULL;
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

function ensureClawhubAnalysisLlmOutcomeColumn(db: Database): void {
  if (!clawhubAnalysisColumnNames(db).has("slug")) return;
  const cols = clawhubAnalysisColumnNames(db);
  if (!cols.has("llm_outcome")) {
    db.run(`ALTER TABLE clawhub_analysis ADD COLUMN llm_outcome TEXT`);
  }
}

function ensureClawhubAnalysisRequirementColumns(db: Database): void {
  if (!clawhubAnalysisColumnNames(db).has("slug")) return;
  const cols = clawhubAnalysisColumnNames(db);
  const addInt = (name: string) => {
    if (!cols.has(name)) {
      db.run(`ALTER TABLE clawhub_analysis ADD COLUMN ${name} INTEGER`);
      cols.add(name);
    }
  };
  const addText = (name: string) => {
    if (!cols.has(name)) {
      db.run(`ALTER TABLE clawhub_analysis ADD COLUMN ${name} TEXT`);
      cols.add(name);
    }
  };
  addInt("req_internet");
  addInt("req_disk_read");
  addInt("req_disk_write");
  addInt("req_secrets");
  addInt("req_subprocess");
  addInt("req_system_tools");
  addText("req_confidence");
  addText("req_evidence_json");
}

/** Sets `llm_outcome = 'ok'` for legacy rows that already had model + composite. */
function backfillClawhubAnalysisLlmOutcomeOk(db: Database): void {
  if (!clawhubAnalysisColumnNames(db).has("llm_outcome")) return;
  db.run(
    `UPDATE clawhub_analysis SET llm_outcome = 'ok'
     WHERE llm_outcome IS NULL AND llm_model IS NOT NULL AND llm_composite IS NOT NULL`
  );
}

function ensureRunsDashboardIndexes(db: Database): void {
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_runs_skipped_benchmark ON runs(skipped, benchmarked_at DESC)`
  );
}

/** Speeds up latest-analysis lookups and overview leaderboard subqueries. */
function ensureClawHubQueryIndexes(db: Database): void {
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_clawhub_analysis_slug_analyzed_at ON clawhub_analysis(slug, analyzed_at DESC)`
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_runs_skill_skipped_bench ON runs(skill_name, skipped, benchmarked_at DESC)`
  );
}

function migrate(db: Database): void {
  // Drop old install_counts table if it exists from a previous schema version
  db.run(`DROP TABLE IF EXISTS install_counts`);
  // `run()` only executes a single statement; `exec()` applies the full schema.
  db.exec(SCHEMA);
  ensureClawhubAnalysisTimingColumns(db);
  ensureClawhubAnalysisLlmOutcomeColumn(db);
  ensureClawhubAnalysisRequirementColumns(db);
  backfillClawhubAnalysisLlmOutcomeOk(db);
  ensureRunsDashboardIndexes(db);
  ensureClawHubQueryIndexes(db);
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

/** sql.js in-memory read cache (fallback when native SQLite is unavailable). */
let _readDbCache: {
  filePath: string;
  mtimeMs: number;
  size: number;
  db: Database;
} | null = null;

/** Native read-only handle — avoids loading the whole DB into WASM. */
let _nativeReadDb: {
  filePath: string;
  mtimeMs: number;
  size: number;
  db: NativeReadDb;
} | null = null;

function invalidateReadDbCache(): void {
  if (_readDbCache) {
    try {
      _readDbCache.db.close();
    } catch {
      /* ignore */
    }
    _readDbCache = null;
  }
  if (_nativeReadDb) {
    try {
      _nativeReadDb.db.close();
    } catch {
      /* ignore */
    }
    _nativeReadDb = null;
  }
}

function tryOpenNativeForRead(filePath: string, st: fs.Stats): NativeReadDb | null {
  const Ctor = getBetterSqliteCtor();
  if (!Ctor) return null;
  if (
    _nativeReadDb &&
    _nativeReadDb.filePath === filePath &&
    _nativeReadDb.mtimeMs === st.mtimeMs &&
    _nativeReadDb.size === st.size
  ) {
    return _nativeReadDb.db;
  }
  if (_nativeReadDb) {
    try {
      _nativeReadDb.db.close();
    } catch {
      /* ignore */
    }
    _nativeReadDb = null;
  }
  try {
    stripWalSidecarFiles(filePath);
    const db = new Ctor(filePath, { readonly: true, fileMustExist: true });
    try {
      db.pragma("cache_size = -131072");
      db.pragma("mmap_size = 268435456");
      db.pragma("temp_store = MEMORY");
    } catch {
      /* ignore pragma failures on exotic builds */
    }
    _nativeReadDb = {
      filePath,
      mtimeMs: st.mtimeMs,
      size: st.size,
      db,
    };
    return db;
  } catch {
    if (_nativeReadDb?.filePath === filePath) {
      try {
        _nativeReadDb.db.close();
      } catch {
        /* ignore */
      }
      _nativeReadDb = null;
    }
    return null;
  }
}

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

/**
 * Shared read-only connection for dashboard queries.
 * Prefers native SQLite (mmap, no full-file WASM load); falls back to cached sql.js.
 * Invalidated when the file changes on disk or after any `saveDb`.
 */
function loadDbForRead(SQL: SqlJsStatic, filePath: string): ReadOnlyDb {
  const st = fs.statSync(filePath);
  const native = tryOpenNativeForRead(filePath, st);
  if (native) {
    if (_readDbCache) {
      try {
        _readDbCache.db.close();
      } catch {
        /* ignore */
      }
      _readDbCache = null;
    }
    return native;
  }

  if (
    _readDbCache &&
    _readDbCache.filePath === filePath &&
    _readDbCache.mtimeMs === st.mtimeMs &&
    _readDbCache.size === st.size
  ) {
    return _readDbCache.db;
  }
  if (_readDbCache) {
    try {
      _readDbCache.db.close();
    } catch {
      /* ignore */
    }
    _readDbCache = null;
  }
  const db = loadDb(SQL, filePath);
  _readDbCache = {
    filePath,
    mtimeMs: st.mtimeMs,
    size: st.size,
    db,
  };
  return db;
}

function saveDb(db: Database, filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(db.export()));
  invalidateReadDbCache();
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
  invalidateReadDbCache();
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

export interface ImportSkillMetadataOptions {
  /** Called after each skill is written (1-based index). */
  onProgress?: (current: number, total: number, skillName: string) => void;
}

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
  skills: SkillMetadata[],
  options?: ImportSkillMetadataOptions
): Promise<{ upserted: number; installSnapshots: number; versions: number; deps: number }> {
  return serialize(async () => {
  invalidateReadDbCache();
  const SQL = await getSql();
  const fp = dbPath();
  const db = loadDb(SQL, fp);
  const now = new Date().toISOString();

  let upserted = 0;
  let installSnapshots = 0;
  let versions = 0;
  let deps = 0;

  const total = skills.length;
  const onProgress = options?.onProgress;

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];
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

    onProgress?.(upserted, total, skill.skillName);
  }

  saveDb(db, fp);
  db.close();
  return {
    upserted,
    installSnapshots,
    versions,
    deps,
  };
  });
}

/**
 * Rebuild {@link SkillMetadata}[] from SQLite for backup or `import-metadata` on another machine.
 */
export function exportSkillMetadata(): Promise<SkillMetadata[]> {
  return serialize(async () => {
    const SQL = await getSql();
    const fp = dbPath();
    if (!fs.existsSync(fp)) return [];

    const db = loadDb(SQL, fp);
    try {
      const mainStmt = db.prepare(
        `SELECT skill_name, author, verified_author, tags, star_rating, star_count, latest_version,
                first_published_at, last_updated_at
         FROM skill_metadata ORDER BY skill_name`
      );

      const out: SkillMetadata[] = [];
      while (mainStmt.step()) {
        const r = mainStmt.getAsObject() as {
          skill_name: string;
          author: string;
          verified_author: number;
          tags: string;
          star_rating: number | null;
          star_count: number;
          latest_version: string | null;
          first_published_at: string | null;
          last_updated_at: string | null;
        };

        let tags: string[] = [];
        try {
          const p = JSON.parse(r.tags) as unknown;
          if (Array.isArray(p)) {
            tags = p.filter((x): x is string => typeof x === "string");
          }
        } catch {
          /* ignore invalid JSON */
        }

        const instStmt = db.prepare(
          `SELECT recorded_at, install_count FROM install_history WHERE skill_name = ? ORDER BY recorded_at ASC`
        );
        instStmt.bind([r.skill_name]);
        const installHistory: SkillMetadata["installHistory"] = [];
        while (instStmt.step()) {
          const row = instStmt.getAsObject() as { recorded_at: string; install_count: number };
          installHistory.push({
            recordedAt: row.recorded_at,
            installCount: row.install_count,
          });
        }
        instStmt.free();

        const verStmt = db.prepare(
          `SELECT version, published_at, is_latest FROM version_history WHERE skill_name = ?
           ORDER BY (published_at IS NULL), published_at ASC, version ASC`
        );
        verStmt.bind([r.skill_name]);
        const versionHistory: SkillMetadata["versionHistory"] = [];
        while (verStmt.step()) {
          const row = verStmt.getAsObject() as {
            version: string;
            published_at: string | null;
            is_latest: number;
          };
          versionHistory.push({
            version: row.version,
            publishedAt: row.published_at,
            isLatest: row.is_latest === 1,
          });
        }
        verStmt.free();

        const depStmt = db.prepare(
          `SELECT depends_on FROM skill_dependencies WHERE skill_name = ? ORDER BY depends_on ASC`
        );
        depStmt.bind([r.skill_name]);
        const dependencyNames: string[] = [];
        while (depStmt.step()) {
          const row = depStmt.getAsObject() as { depends_on: string };
          dependencyNames.push(row.depends_on);
        }
        depStmt.free();

        out.push({
          skillName: r.skill_name,
          author: r.author,
          verifiedAuthor: r.verified_author === 1,
          tags,
          starRating: r.star_rating ?? null,
          starCount: r.star_count,
          latestVersion: r.latest_version ?? null,
          firstPublishedAt: r.first_published_at ?? null,
          lastUpdatedAt: r.last_updated_at ?? null,
          dependencyNames,
          installHistory,
          versionHistory,
        });
      }
      mainStmt.free();
      return out;
    } finally {
      db.close();
    }
  });
}

// ── Low-level query helper ────────────────────────────────────────────────

/** Run multiple reads in one lock + one sql.js load (critical for large DBs). */
export async function withSerializedDb<T>(fn: (db: ReadOnlyDb | null) => T): Promise<T> {
  return serialize(async () => {
    const SQL = await getSql();
    const fp = dbPath();
    if (!fs.existsSync(fp)) return fn(null);

    const db = loadDbForRead(SQL, fp);
    return fn(db);
  });
}

export function dbQueryAll<T = Record<string, unknown>>(
  db: ReadOnlyDb,
  sql: string,
  params: (string | number | null)[] = []
): T[] {
  if (!isSqlJsReadDb(db)) {
    const stmt = db.prepare(sql);
    const rows =
      params.length === 0
        ? (stmt.all() as T[])
        : (stmt.all(...params) as T[]);
    return rows;
  }
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: T[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return results;
}

export function query<T = Record<string, unknown>>(
  sql: string,
  params: (string | number | null)[] = []
): Promise<T[]> {
  return withSerializedDb((db) => {
    if (!db) return [];
    return dbQueryAll<T>(db, sql, params);
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

/** Extra columns for `clawhub_skills` upsert (zip path, analysis-derived stats). */
export type ClawHubSkillUpsertExtra = {
  zipPath?: string;
  extractedPath?: string;
  hasScripts?: boolean;
  fileCount?: number;
  totalSizeBytes?: number;
  skillMdLength?: number;
};

const UPSERT_CLAWHUB_SKILL_SQL = `INSERT INTO clawhub_skills (
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
        skill_md_length  = CASE WHEN excluded.skill_md_length > 0 THEN excluded.skill_md_length ELSE clawhub_skills.skill_md_length END`;

function upsertClawHubSkillOnDb(
  db: Database,
  entry: ClawHubSkillEntry,
  extra: ClawHubSkillUpsertExtra,
  scrapedAt: string
): void {
  db.run(UPSERT_CLAWHUB_SKILL_SQL, [
    entry.slug,
    entry.name,
    entry.summary,
    entry.author,
    entry.version,
    entry.downloads,
    entry.stars,
    entry.versionCount,
    scrapedAt,
    extra.zipPath ?? null,
    extra.extractedPath ?? null,
    extra.hasScripts ? 1 : 0,
    extra.fileCount ?? 0,
    extra.totalSizeBytes ?? 0,
    extra.skillMdLength ?? 0,
  ]);
}

export function upsertClawHubSkill(
  entry: ClawHubSkillEntry,
  extra: ClawHubSkillUpsertExtra = {}
): Promise<void> {
  return serialize(async () => {
    invalidateReadDbCache();
    const SQL = await getSql();
    const fp = dbPath();
    const db = loadDb(SQL, fp);
    upsertClawHubSkillOnDb(db, entry, extra, new Date().toISOString());
    saveDb(db, fp);
    db.close();
  });
}

export interface UpsertClawHubSkillsBatchOptions {
  /** Invoked once the DB lock is acquired, before loading sql.js / opening the file. */
  onBatchBegin?: () => void;
  /** Called after each row is applied in-memory (1-based `current`). */
  onProgress?: (current: number, total: number) => void;
  /**
   * Called after all `INSERT`s, immediately before writing the DB file to disk.
   * The following step (`db.export` + `writeFileSync`) can take a long time and blocks the event loop.
   */
  beforeFlush?: () => void;
}

/**
 * Batch upsert into `clawhub_skills` in a single DB load/save (same pattern as `importSkillMetadata`).
 * Use for full-catalog seeding; callers should prefer this over many `upsertClawHubSkill` calls.
 */
export function upsertClawHubSkillsBatch(
  rows: Array<{ entry: ClawHubSkillEntry; extra?: ClawHubSkillUpsertExtra }>,
  options?: UpsertClawHubSkillsBatchOptions
): Promise<void> {
  if (rows.length === 0) return Promise.resolve();
  return serialize(async () => {
    options?.onBatchBegin?.();
    invalidateReadDbCache();
    const SQL = await getSql();
    const fp = dbPath();
    const db = loadDb(SQL, fp);
    const scrapedAt = new Date().toISOString();
    const total = rows.length;
    let current = 0;
    for (const { entry, extra = {} } of rows) {
      upsertClawHubSkillOnDb(db, entry, extra, scrapedAt);
      current++;
      options?.onProgress?.(current, total);
      // Let the event loop run so TTY progress can flush during long in-memory upserts.
      if (current % 500 === 0 && current < total) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    options?.beforeFlush?.();
    saveDb(db, fp);
    db.close();
  });
}

/** True if we already stored an analysis row for this slug with this `llm_model` (skips redundant `--llm` runs). */
export async function hasClawHubLlmAnalysisForModel(
  slug: string,
  llmModel: string
): Promise<boolean> {
  const rows = await query<{ n: number }>(
    `SELECT 1 AS n FROM clawhub_analysis
     WHERE slug = ? AND llm_model = ?
     LIMIT 1`,
    [slug, llmModel]
  );
  return rows.length > 0;
}

function sqlStringLiteralForCli(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Read-only slug list without loading the DB into sql.js (fast on huge bench.db / NFS).
 * Returns null if `sqlite3` is missing or the command fails.
 */
function slugsWithAnyAnalysisViaSqlite3Cli(fp: string): Set<string> | null {
  try {
    const sql = `SELECT DISTINCT slug FROM clawhub_analysis;`;
    const r = spawnSync("sqlite3", [fp, "-batch", "-noheader", sql], {
      encoding: "utf-8",
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
    if (r.error) return null;
    if (r.status !== 0) return null;
    const lines = (r.stdout ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return new Set(lines);
  } catch {
    return null;
  }
}

function slugsWithLlmCompositeViaSqlite3Cli(fp: string, llmModel: string): Set<string> | null {
  try {
    const sql = `SELECT DISTINCT slug FROM clawhub_analysis WHERE llm_model = ${sqlStringLiteralForCli(
      llmModel
    )};`;
    const r = spawnSync("sqlite3", [fp, "-batch", "-noheader", sql], {
      encoding: "utf-8",
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
    if (r.error) return null;
    if (r.status !== 0) return null;
    const lines = (r.stdout ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return new Set(lines);
  } catch {
    return null;
  }
}

/**
 * One DB round-trip: slugs that already have at least one `clawhub_analysis` row for this `llm_model`.
 * Prefer this over calling {@link hasClawHubLlmAnalysisForModel} per slug (each call reloads the whole DB with sql.js).
 *
 * **Prefetch strategy:** Unless `CLAW_BENCH_USE_SQLITE3_CLI=0`, tries the **`sqlite3` shell** on PATH first (fast on
 * NFS — no full-file load into Node). Falls back to sql.js `query()` if the CLI is missing or errors.
 * Set `CLAW_BENCH_USE_SQLITE3_CLI=0` to always use sql.js.
 */
export async function getSlugsWithLlmCompositeForModel(llmModel: string): Promise<Set<string>> {
  const fp = dbPath();
  if (!fs.existsSync(fp)) return new Set();

  const forceSqlJs =
    process.env.CLAW_BENCH_USE_SQLITE3_CLI === "0" ||
    process.env.CLAW_BENCH_USE_SQLITE3_CLI === "false";
  const requireCli =
    process.env.CLAW_BENCH_USE_SQLITE3_CLI === "1" ||
    process.env.CLAW_BENCH_USE_SQLITE3_CLI === "true";

  if (!forceSqlJs) {
    const via = slugsWithLlmCompositeViaSqlite3Cli(fp, llmModel);
    if (via !== null) {
      return via;
    }
    if (requireCli) {
      console.warn(
        "[claw-bench] CLAW_BENCH_USE_SQLITE3_CLI=1 but `sqlite3` failed; falling back to sql.js."
      );
    } else {
      let sizeHint = "";
      try {
        sizeHint = ` (${(fs.statSync(fp).size / (1024 * 1024)).toFixed(0)} MiB)`;
      } catch {
        /* ignore */
      }
      console.warn(
        `[claw-bench] LLM prefetch: no working \`sqlite3\` on PATH${sizeHint}; using sql.js (full read — slow on Lustre/NFS). ` +
          "Add sqlite3 to PATH (e.g. `module load sqlite`) or expect a long pause here."
      );
    }
  }

  const rows = await query<{ slug: string }>(
    `SELECT DISTINCT slug FROM clawhub_analysis
     WHERE llm_model = ?`,
    [llmModel]
  );
  return new Set(rows.map((r) => r.slug));
}

/** Distinct slugs with any `clawhub_analysis` row (static skip). Same sqlite3/sql.js strategy as LLM prefetch. */
export async function getSlugsWithAnyClawHubAnalysis(): Promise<Set<string>> {
  const fp = dbPath();
  if (!fs.existsSync(fp)) return new Set();

  const forceSqlJs =
    process.env.CLAW_BENCH_USE_SQLITE3_CLI === "0" ||
    process.env.CLAW_BENCH_USE_SQLITE3_CLI === "false";
  const requireCli =
    process.env.CLAW_BENCH_USE_SQLITE3_CLI === "1" ||
    process.env.CLAW_BENCH_USE_SQLITE3_CLI === "true";

  if (!forceSqlJs) {
    const via = slugsWithAnyAnalysisViaSqlite3Cli(fp);
    if (via !== null) {
      return via;
    }
    if (requireCli) {
      console.warn(
        "[claw-bench] CLAW_BENCH_USE_SQLITE3_CLI=1 but `sqlite3` failed; falling back to sql.js."
      );
    } else {
      let sizeHint = "";
      try {
        sizeHint = ` (${(fs.statSync(fp).size / (1024 * 1024)).toFixed(0)} MiB)`;
      } catch {
        /* ignore */
      }
      console.warn(
        `[claw-bench] Analysis prefetch: no working \`sqlite3\` on PATH${sizeHint}; using sql.js (full read — slow on Lustre/NFS). ` +
          "Add sqlite3 to PATH (e.g. `module load sqlite`) or expect a long pause here."
      );
    }
  }

  const rows = await query<{ slug: string }>(`SELECT DISTINCT slug FROM clawhub_analysis`, []);
  return new Set(rows.map((r) => r.slug));
}

/** Remove every row in `clawhub_analysis` (full catalog re-analyze). */
export function deleteAllClawHubAnalysis(): Promise<void> {
  return serialize(async () => {
    invalidateReadDbCache();
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
    invalidateReadDbCache();
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
    invalidateReadDbCache();
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
    invalidateReadDbCache();
    const SQL = await getSql();
    const fp = dbPath();
    const db = loadDb(SQL, fp);

    const s = analysis.staticAnalysis;
    const l = analysis.llmEval;
    const tm = analysis.timing;
    const llmModelStored = l?.model ?? analysis.catalogLlmModel ?? null;
    const insightsJson = analysis.insights ? JSON.stringify(analysis.insights) : null;
    const llmOutcomeStored = analysis.llmOutcome ?? null;

    db.run(
      `INSERT INTO clawhub_analysis (
        slug, analyzed_at,
        doc_quality, completeness, security, code_quality, maintainability, static_composite,
        llm_clarity, llm_usefulness, llm_safety, llm_completeness, llm_composite,
        llm_model, llm_reasoning, overall_composite,
        extract_ms, static_analysis_ms, llm_ms, file_stats_ms, pipeline_ms,
        analysis_insights,
        llm_outcome
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        llmModelStored,
        l?.reasoning ?? null,
        analysis.overallComposite,
        tm.extractMs,
        tm.staticMs,
        tm.llmMs,
        tm.fileStatsMs,
        tm.pipelineMs,
        insightsJson,
        llmOutcomeStored,
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

/**
 * Update inferred runtime requirements on the latest analysis row for a slug.
 * Safe additive enrichment: does not modify existing score/timing fields.
 */
export function updateLatestClawHubAnalysisRequirements(
  slug: string,
  req: ClawHubRuntimeRequirements
): Promise<boolean> {
  return serialize(async () => {
    invalidateReadDbCache();
    const SQL = await getSql();
    const fp = dbPath();
    if (!fs.existsSync(fp)) return false;
    const db = loadDb(SQL, fp);
    const idRows = db.exec(
      `SELECT id FROM clawhub_analysis
       WHERE slug = ?
       ORDER BY analyzed_at DESC, id DESC
       LIMIT 1`,
      [slug]
    );
    const id = idRows[0]?.values[0]?.[0] as number | undefined;
    if (id === undefined) {
      db.close();
      return false;
    }
    db.run(
      `UPDATE clawhub_analysis SET
        req_internet = ?,
        req_disk_read = ?,
        req_disk_write = ?,
        req_secrets = ?,
        req_subprocess = ?,
        req_system_tools = ?,
        req_confidence = ?,
        req_evidence_json = ?
       WHERE id = ?`,
      [
        req.needsInternet ? 1 : 0,
        req.needsDiskRead ? 1 : 0,
        req.needsDiskWrite ? 1 : 0,
        req.needsSecrets ? 1 : 0,
        req.needsSubprocess ? 1 : 0,
        req.needsSystemTools ? 1 : 0,
        req.confidence,
        JSON.stringify(req.evidence),
        id,
      ]
    );
    saveDb(db, fp);
    db.close();
    return true;
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

/** For COUNT(*) only — matches filters; avoids LLM aggregate + json_group_array (very slow on large DBs). */
function clawhubCatalogCountJoinSql(): string {
  return `FROM clawhub_skills s
LEFT JOIN (
  ${CLAWHUB_LATEST_ANALYSIS_SUB}
) latest ON latest.slug = s.slug AND latest.rn = 1`;
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
       CASE WHEN latest.id IS NOT NULL THEN 1 ELSE 0 END AS analyzed,
       latest.extract_ms, latest.static_analysis_ms, latest.llm_ms, latest.file_stats_ms,
       latest.pipeline_ms,
       latest.llm_outcome AS llm_outcome`;
}

/** Catalog list sort field (see dashboard table headers + API `sort` query). */
export type ClawHubCatalogSortKey =
  | "overall"
  | "name"
  | "author"
  | "downloads"
  | "stars"
  | "static"
  | "llm"
  | "pipeline";

export interface ClawHubCatalogPageOpts {
  page: number;
  limit: number;
  sort: ClawHubCatalogSortKey;
  /** Default `desc` for scores/metrics, callers may pass `asc` for name/author-first sorts. */
  sortDir?: "asc" | "desc";
  q?: string;
  analyzedOnly?: boolean;
  withScripts?: boolean;
}

function catalogOrderBy(
  sort: ClawHubCatalogSortKey,
  sortDir: "asc" | "desc"
): string {
  const overall = clawhubOverallCompositeSqlExpr();
  const d = sortDir === "asc" ? "ASC" : "DESC";
  const slugTie = "s.slug ASC";
  const nullsLastScore = (expr: string) =>
    `CASE WHEN (${expr}) IS NULL THEN 1 ELSE 0 END ASC, (${expr}) ${d}, ${slugTie}`;
  const nullsLastOverall = nullsLastScore(overall);

  switch (sort) {
    case "name":
      return `s.name COLLATE NOCASE ${d}, ${slugTie}`;
    case "author":
      return `s.author COLLATE NOCASE ${d}, ${slugTie}`;
    case "downloads":
      return `s.downloads ${d}, ${slugTie}`;
    case "stars":
      return `s.stars ${d}, ${slugTie}`;
    case "static":
      return nullsLastScore("latest.static_composite");
    case "llm":
      return nullsLastScore("llm.llm_composite");
    case "pipeline":
      return nullsLastScore("latest.pipeline_ms");
    default:
      return nullsLastOverall;
  }
}

/**
 * Top catalog rows by latest analysis score — for dashboard overview only.
 * Avoids the full {@link clawhubCatalogAnalysisJoinSql} + COUNT used by the main catalog page.
 */
export function getClawHubCatalogPeekTopOnDb(
  db: ReadOnlyDb,
  limit: number
): { rows: Record<string, unknown>[] } {
  const lim = Math.min(50, Math.max(1, limit));
  const rows = dbQueryAll<Record<string, unknown>>(
    db,
    `SELECT s.slug, s.name, s.author, s.version,
            latest.overall_composite AS overall_composite
     FROM clawhub_skills s
     INNER JOIN (
       SELECT slug, overall_composite,
              ROW_NUMBER() OVER (PARTITION BY slug ORDER BY analyzed_at DESC) AS rn
       FROM clawhub_analysis
     ) latest ON latest.slug = s.slug AND latest.rn = 1
     ORDER BY latest.overall_composite DESC
     LIMIT ?`,
    [lim]
  );
  return { rows };
}

/** Paginated catalog (same DB connection — use from `withSerializedDb` bundles). */
export function getClawHubSkillsPagedOnDb(
  db: ReadOnlyDb,
  opts: ClawHubCatalogPageOpts
): { rows: Record<string, unknown>[]; total: number } {
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
  const dir = opts.sortDir ?? "desc";
  const orderSql = catalogOrderBy(opts.sort, dir);

  const joinSql = clawhubCatalogAnalysisJoinSql();
  const countJoinSql = clawhubCatalogCountJoinSql();
  const selectSql = clawhubCatalogSelectSql();
  const countSql = `SELECT COUNT(*) as n ${countJoinSql} WHERE ${whereSql}`;
  const dataSql = `${selectSql} ${joinSql} WHERE ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`;

  const totalRows = dbQueryAll<{ n: number }>(db, countSql, params);
  const total = totalRows[0]?.n ?? 0;
  const rows = dbQueryAll<Record<string, unknown>>(db, dataSql, [...params, limit, offset]);
  return { rows, total };
}

/** Paginated catalog for the dashboard (search + filters + sort). */
export async function getClawHubSkillsPaged(
  opts: ClawHubCatalogPageOpts
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  return withSerializedDb((db) => {
    if (!db) return { rows: [], total: 0 };
    return getClawHubSkillsPagedOnDb(db, opts);
  });
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
       latest.llm_outcome AS llm_outcome,
       (${overall}) AS overall_composite,
       (SELECT MAX(ca.analyzed_at) FROM clawhub_analysis ca WHERE ca.slug = s.slug) AS analyzed_at,
       CASE WHEN latest.id IS NOT NULL THEN 1 ELSE 0 END AS analyzed,
       latest.extract_ms, latest.static_analysis_ms, latest.llm_ms, latest.file_stats_ms,
       latest.pipeline_ms,
       latest.analysis_insights,
       meta.author AS import_meta_author,
       meta.verified_author AS import_meta_verified_author,
       meta.tags AS import_meta_tags,
       meta.star_rating AS import_meta_star_rating,
       meta.star_count AS import_meta_star_count,
       meta.latest_version AS import_meta_latest_version,
       meta.total_versions AS import_meta_total_versions,
       meta.dependency_count AS import_meta_dependency_count,
       meta.first_published_at AS import_meta_first_published_at,
       meta.last_updated_at AS import_meta_last_updated_at,
       meta.metadata_recorded_at AS import_meta_recorded_at
     FROM clawhub_skills s
     LEFT JOIN (
       ${CLAWHUB_LATEST_ANALYSIS_SUB}
     ) latest ON latest.slug = s.slug AND latest.rn = 1
     LEFT JOIN (
       ${llmAgg}
     ) llm ON llm.slug = s.slug
     LEFT JOIN (${LLM_DETAIL_JSON_SUB}) detail ON detail.slug = s.slug
     LEFT JOIN skill_metadata meta ON meta.skill_name = s.slug
     WHERE s.slug = ?`,
    [slug, slug]
  );
  return rows[0] ?? null;
}

const CLAWHUB_CATALOG_STATS_COMBINED_SQL = `SELECT
  (SELECT COUNT(*) FROM clawhub_skills) AS totalSkills,
  (SELECT COUNT(*) FROM clawhub_skills s
    WHERE EXISTS (SELECT 1 FROM clawhub_analysis ca WHERE ca.slug = s.slug)) AS analyzedCount,
  (SELECT AVG(overall_composite) FROM (
      SELECT overall_composite,
        ROW_NUMBER() OVER (PARTITION BY slug ORDER BY analyzed_at DESC) AS rn
      FROM clawhub_analysis
    ) lp WHERE lp.rn = 1) AS avgOverallComposite,
  (SELECT AVG(static_composite) FROM (
      SELECT static_composite,
        ROW_NUMBER() OVER (PARTITION BY slug ORDER BY analyzed_at DESC) AS rn
      FROM clawhub_analysis
    ) lp WHERE lp.rn = 1) AS avgStaticComposite,
  (SELECT COUNT(*) FROM clawhub_skills WHERE has_scripts = 1) AS withScripts`;

export function getClawHubCatalogStatsOnDb(db: ReadOnlyDb): {
  totalSkills: number;
  analyzedCount: number;
  avgOverallComposite: number;
  avgStaticComposite: number;
  withScripts: number;
} {
  const rows = dbQueryAll<{
    totalSkills: number;
    analyzedCount: number;
    avgOverallComposite: number | null;
    avgStaticComposite: number | null;
    withScripts: number;
  }>(db, CLAWHUB_CATALOG_STATS_COMBINED_SQL);
  const r = rows[0];
  return {
    totalSkills: r?.totalSkills ?? 0,
    analyzedCount: r?.analyzedCount ?? 0,
    avgOverallComposite: r?.avgOverallComposite ?? 0,
    avgStaticComposite: r?.avgStaticComposite ?? 0,
    withScripts: r?.withScripts ?? 0,
  };
}

export async function getClawHubCatalogStats(): Promise<{
  totalSkills: number;
  analyzedCount: number;
  avgOverallComposite: number;
  avgStaticComposite: number;
  withScripts: number;
  dbPath: string;
}> {
  return withSerializedDb((db) => {
    const base = db
      ? getClawHubCatalogStatsOnDb(db)
      : {
          totalSkills: 0,
          analyzedCount: 0,
          avgOverallComposite: 0,
          avgStaticComposite: 0,
          withScripts: 0,
        };
    return { ...base, dbPath: dbPath() };
  });
}
