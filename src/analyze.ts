/**
 * analyze.ts — query functions for the four measurements.
 *
 * All functions return plain objects — no presentation logic here.
 * The CLI layer in cli.ts handles formatting.
 */

import { query } from "./store.js";
import { runsVisibilitySql } from "./dashboardFilters.js";

// ── 1. Score distributions per skill type ──────────────────────────────────

export interface DistributionRow {
  skill_type: string;
  score_type: string;
  n: number;
  min_composite: number;
  p25_composite: number;
  median_composite: number;
  p75_composite: number;
  max_composite: number;
  mean_composite: number;
  stddev_composite: number;
}

/**
 * Score distribution stats grouped by skill_type × score_type.
 * Percentiles are computed in-process (sql.js has no built-in percentile fn).
 */
export async function scoreDistributions(): Promise<DistributionRow[]> {
  // Pull raw composites grouped by type
  const raw = await query<{
    skill_type: string;
    score_type: string;
    composite: number;
  }>(
    `SELECT skill_type, score_type, composite
     FROM runs
     WHERE skipped = 0 ${runsVisibilitySql()}
     ORDER BY skill_type, score_type, composite`
  );

  // Group
  const groups = new Map<string, { skill_type: string; score_type: string; values: number[] }>();
  for (const row of raw) {
    const key = `${row.skill_type}::${row.score_type}`;
    if (!groups.has(key)) {
      groups.set(key, { skill_type: row.skill_type, score_type: row.score_type, values: [] });
    }
    groups.get(key)!.values.push(row.composite);
  }

  const out: DistributionRow[] = [];
  for (const { skill_type, score_type, values } of groups.values()) {
    if (values.length === 0) continue;
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;

    out.push({
      skill_type,
      score_type,
      n,
      min_composite: round(sorted[0]),
      p25_composite: round(percentile(sorted, 0.25)),
      median_composite: round(percentile(sorted, 0.5)),
      p75_composite: round(percentile(sorted, 0.75)),
      max_composite: round(sorted[n - 1]),
      mean_composite: round(mean),
      stddev_composite: round(Math.sqrt(variance)),
    });
  }
  return out;
}

// ── 2. Threshold calibration ───────────────────────────────────────────────

export interface ThresholdAnalysis {
  embed_model: string;
  n: number;
  /** What fraction of runs would be marked "unstable" at each candidate threshold */
  candidates: Array<{
    threshold: number;
    pct_unstable: number;  // 0–1
    pct_stable: number;    // 0–1
  }>;
  /** Distribution of min_similarity values */
  min_sim_distribution: {
    p10: number; p25: number; p50: number; p75: number; p90: number; p95: number;
  };
  recommendation: string;
}

export async function thresholdCalibration(
  embedModel = "nomic-embed-text"
): Promise<ThresholdAnalysis> {
  const rows = await query<{ min_sim: number }>(
    `SELECT consistency_min_sim as min_sim
     FROM runs
     WHERE skipped = 0 AND embed_model = ? ${runsVisibilitySql()}
     ORDER BY consistency_min_sim`,
    [embedModel]
  );

  const values = rows.map((r) => r.min_sim).sort((a, b) => a - b);
  const n = values.length;

  if (n === 0) {
    return {
      embed_model: embedModel,
      n: 0,
      candidates: [],
      min_sim_distribution: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p95: 0 },
      recommendation: "No data yet. Run more benchmarks first.",
    };
  }

  const candidates = [0.80, 0.85, 0.88, 0.90, 0.92, 0.94, 0.95, 0.97].map(
    (threshold) => {
      const unstable = values.filter((v) => v < threshold).length;
      return {
        threshold,
        pct_unstable: round(unstable / n),
        pct_stable: round(1 - unstable / n),
      };
    }
  );

  const dist = {
    p10: round(percentile(values, 0.1)),
    p25: round(percentile(values, 0.25)),
    p50: round(percentile(values, 0.5)),
    p75: round(percentile(values, 0.75)),
    p90: round(percentile(values, 0.9)),
    p95: round(percentile(values, 0.95)),
  };

  // Heuristic recommendation: threshold that marks ~20% of skills as unstable
  // is a reasonable starting point — not too strict, not too loose
  const target = candidates.find((c) => c.pct_unstable >= 0.18 && c.pct_unstable <= 0.25);
  const recommendation = target
    ? `Based on ${n} runs, a threshold of ${target.threshold} marks ${Math.round(target.pct_unstable * 100)}% of skills as unstable. This is a reasonable signal-to-noise ratio.`
    : `No candidate threshold produces ~20% unstable rate. Distribution may be bimodal. Inspect min_sim_distribution manually.`;

  return { embed_model: embedModel, n, candidates, min_sim_distribution: dist, recommendation };
}

// ── 3. Install correlation ─────────────────────────────────────────────────

export interface InstallCorrelationRow {
  skill_name: string;
  latest_composite: number;
  latest_score_type: string;
  latest_benchmarked_at: string;
  latest_install_count: number | null;
  install_data_available: boolean;
}

export interface InstallCorrelationSummary {
  n_with_installs: number;
  n_without_installs: number;
  pearson_r: number | null;    // null if <3 data points
  interpretation: string;
  rows: InstallCorrelationRow[];
}

export async function installCorrelation(): Promise<InstallCorrelationSummary> {
  const rows = await query<{
    skill_name: string;
    composite: number;
    score_type: string;
    benchmarked_at: string;
    install_count: number | null;
  }>(
    `SELECT
       r.skill_name,
       r.composite,
       r.score_type,
       r.benchmarked_at,
       ih.install_count
     FROM runs r
     LEFT JOIN (
       SELECT skill_name, MAX(recorded_at) as latest_at
       FROM install_history GROUP BY skill_name
     ) latest_ih ON r.skill_name = latest_ih.skill_name
     LEFT JOIN install_history ih
       ON ih.skill_name = latest_ih.skill_name AND ih.recorded_at = latest_ih.latest_at
     WHERE r.skipped = 0 ${runsVisibilitySql("r")}
       AND r.benchmarked_at = (
         SELECT MAX(benchmarked_at) FROM runs r2
         WHERE r2.skill_name = r.skill_name AND r2.skipped = 0 ${runsVisibilitySql("r2")}
       )
     ORDER BY r.composite DESC`
  );

  const withInstalls = rows.filter((r) => r.install_count !== null);
  const pearson =
    withInstalls.length >= 3
      ? pearsonR(
          withInstalls.map((r) => r.composite),
          withInstalls.map((r) => r.install_count as number)
        )
      : null;

  const interpretation = interpretR(pearson, withInstalls.length);

  return {
    n_with_installs: withInstalls.length,
    n_without_installs: rows.length - withInstalls.length,
    pearson_r: pearson !== null ? round(pearson) : null,
    interpretation,
    rows: rows.map((r) => ({
      skill_name: r.skill_name,
      latest_composite: round(r.composite),
      latest_score_type: r.score_type,
      latest_benchmarked_at: r.benchmarked_at,
      latest_install_count: r.install_count,
      install_data_available: r.install_count !== null,
    })),
  };
}

// ── 4. Score drift ─────────────────────────────────────────────────────────

export interface DriftPoint {
  benchmarked_at: string;
  skill_version: string | null;
  composite: number;
  score_consistency: number;
  score_robustness: number;
  score_latency: number;
  score_correctness: number | null;
}

export interface DriftAnalysis {
  skill_name: string;
  n_runs: number;
  first_seen: string;
  last_seen: string;
  composite_delta: number;          // last − first
  max_composite: number;
  min_composite: number;
  versions_seen: string[];
  /** Ordered chronologically */
  timeline: DriftPoint[];
  /** Version-to-version deltas (only when skill_version is populated) */
  version_deltas: Array<{
    from_version: string;
    to_version: string;
    composite_delta: number;
  }>;
}

export async function scoreDrift(skillName: string): Promise<DriftAnalysis | null> {
  const rows = await query<DriftPoint & { skill_version: string | null }>(
    `SELECT
       benchmarked_at,
       skill_version,
       composite,
       score_consistency,
       score_robustness,
       score_latency,
       score_correctness
     FROM runs
     WHERE skill_name = ? AND skipped = 0 ${runsVisibilitySql()}
     ORDER BY benchmarked_at ASC`,
    [skillName]
  );

  if (rows.length === 0) return null;

  const composites = rows.map((r) => r.composite);
  const versions = [...new Set(rows.map((r) => r.skill_version).filter(Boolean))] as string[];

  // Version-to-version deltas: find the first run for each distinct version
  const versionRuns = new Map<string, number>();
  for (const row of rows) {
    if (row.skill_version && !versionRuns.has(row.skill_version)) {
      versionRuns.set(row.skill_version, row.composite);
    }
  }
  const versionList = [...versionRuns.entries()];
  const versionDeltas = versionList.slice(1).map(([ver, comp], i) => ({
    from_version: versionList[i][0],
    to_version: ver,
    composite_delta: round(comp - versionList[i][1]),
  }));

  return {
    skill_name: skillName,
    n_runs: rows.length,
    first_seen: rows[0].benchmarked_at,
    last_seen: rows[rows.length - 1].benchmarked_at,
    composite_delta: round(composites[composites.length - 1] - composites[0]),
    max_composite: round(Math.max(...composites)),
    min_composite: round(Math.min(...composites)),
    versions_seen: versions,
    timeline: rows.map((r) => ({ ...r, composite: round(r.composite) })),
    version_deltas: versionDeltas,
  };
}

/**
 * Return drift summaries for all skills that have more than one run.
 */
export async function allDrift(): Promise<Array<{ skill_name: string; n_runs: number; composite_delta: number; min: number; max: number }>> {
  return query(
    `SELECT
       skill_name,
       COUNT(*) as n_runs,
       ROUND(MAX(composite) - MIN(composite), 3) as composite_delta,
       ROUND(MIN(composite), 3) as min,
       ROUND(MAX(composite), 3) as max
     FROM runs
     WHERE skipped = 0 ${runsVisibilitySql()}
     GROUP BY skill_name
     HAVING COUNT(*) > 1
     ORDER BY composite_delta DESC`
  );
}

// ── Stat helpers ───────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function pearsonR(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((acc, x, i) => acc + (x - mx) * (ys[i] - my), 0);
  const den = Math.sqrt(
    xs.reduce((acc, x) => acc + (x - mx) ** 2, 0) *
    ys.reduce((acc, y) => acc + (y - my) ** 2, 0)
  );
  return den === 0 ? 0 : num / den;
}

function interpretR(r: number | null, n: number, metric = "install count"): string {
  if (r === null) return `Insufficient data (need ≥3 skills with ${metric} data).`;
  const abs = Math.abs(r);
  const direction = r >= 0 ? "positive" : "negative";
  const strength = abs >= 0.7 ? "strong" : abs >= 0.4 ? "moderate" : abs >= 0.2 ? "weak" : "negligible";
  return `${strength} ${direction} correlation (r=${round(r)}, n=${n}). ${
    abs < 0.2
      ? `Score does not appear to predict ${metric} at this sample size.`
      : r > 0
      ? `Higher-scoring skills tend to have higher ${metric}.`
      : `Higher-scoring skills tend to have lower ${metric} — investigate.`
  }`;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── 5. Score by author verification status ────────────────────────────────

export interface AuthorVerificationAnalysis {
  verified: { n: number; mean_composite: number; median_composite: number } | null;
  unverified: { n: number; mean_composite: number; median_composite: number } | null;
  delta: number | null;   // verified.mean − unverified.mean
  interpretation: string;
}

export async function scoreByAuthorVerification(): Promise<AuthorVerificationAnalysis> {
  const rows = await query<{
    verified_author: number;
    composite: number;
  }>(
    `SELECT m.verified_author, r.composite
     FROM runs r
     JOIN skill_metadata m ON r.skill_name = m.skill_name
     WHERE r.skipped = 0 ${runsVisibilitySql("r")}
     ORDER BY m.verified_author, r.composite`
  );

  const verified   = rows.filter((r) => r.verified_author === 1).map((r) => r.composite);
  const unverified = rows.filter((r) => r.verified_author === 0).map((r) => r.composite);

  const summarise = (vals: number[]) => vals.length === 0 ? null : {
    n: vals.length,
    mean_composite: round(vals.reduce((a, b) => a + b, 0) / vals.length),
    median_composite: round(percentile([...vals].sort((a, b) => a - b), 0.5)),
  };

  const v = summarise(verified);
  const u = summarise(unverified);
  const delta = v && u ? round(v.mean_composite - u.mean_composite) : null;

  let interpretation: string;
  if (!v && !u) {
    interpretation = "No metadata imported yet. Run 'claw-bench data import-metadata'.";
  } else if (!v) {
    interpretation = "No verified author skills in the dataset yet.";
  } else if (!u) {
    interpretation = "No unverified author skills in the dataset yet.";
  } else if (delta === null || Math.abs(delta) < 0.02) {
    interpretation = "No meaningful difference between verified and unverified author scores.";
  } else {
    const direction = delta > 0 ? "higher" : "lower";
    interpretation = `Verified authors score ${Math.abs(delta * 100).toFixed(1)} percentage points ${direction} on average.`;
  }

  return { verified: v, unverified: u, delta, interpretation };
}

// ── 6. Score by tag ───────────────────────────────────────────────────────

export interface TagScoreRow {
  tag: string;
  n: number;
  mean_composite: number;
  median_composite: number;
  min_composite: number;
  max_composite: number;
}

export async function scoreByTag(): Promise<TagScoreRow[]> {
  // Tags are stored as JSON arrays — expand in-process
  const rows = await query<{ skill_name: string; tags: string; composite: number }>(
    `SELECT m.skill_name, m.tags, r.composite
     FROM runs r
     JOIN skill_metadata m ON r.skill_name = m.skill_name
     WHERE r.skipped = 0 ${runsVisibilitySql("r")}`
  );

  const tagMap = new Map<string, number[]>();
  for (const row of rows) {
    let tags: string[] = [];
    try { tags = JSON.parse(row.tags); } catch { tags = []; }
    for (const tag of tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag)!.push(row.composite);
    }
  }

  const result: TagScoreRow[] = [];
  for (const [tag, values] of tagMap.entries()) {
    const sorted = [...values].sort((a, b) => a - b);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    result.push({
      tag,
      n: values.length,
      mean_composite: round(mean),
      median_composite: round(percentile(sorted, 0.5)),
      min_composite: round(sorted[0]),
      max_composite: round(sorted[sorted.length - 1]),
    });
  }

  return result.sort((a, b) => b.mean_composite - a.mean_composite);
}

// ── 7. Score vs star rating ───────────────────────────────────────────────

export interface StarCorrelationSummary {
  n: number;
  pearson_r: number | null;
  interpretation: string;
  buckets: Array<{
    star_bucket: string;   // e.g. "4.0–4.5"
    n: number;
    mean_composite: number;
  }>;
}

export async function scoreVsStarRating(): Promise<StarCorrelationSummary> {
  const rows = await query<{ composite: number; star_rating: number }>(
    `SELECT r.composite, m.star_rating
     FROM runs r
     JOIN skill_metadata m ON r.skill_name = m.skill_name
     WHERE r.skipped = 0 AND m.star_rating IS NOT NULL ${runsVisibilitySql("r")}`
  );

  if (rows.length < 3) {
    return { n: rows.length, pearson_r: null, interpretation: "Insufficient data (need ≥3 rated skills).", buckets: [] };
  }

  const composites  = rows.map((r) => r.composite);
  const starRatings = rows.map((r) => r.star_rating);
  const r = pearsonR(composites, starRatings);

  // Bucket by 0.5-star increments
  const bucketMap = new Map<string, number[]>();
  for (const row of rows) {
    const lo  = Math.floor(row.star_rating * 2) / 2;
    const hi  = lo + 0.5;
    const key = `${lo.toFixed(1)}–${hi.toFixed(1)}`;
    if (!bucketMap.has(key)) bucketMap.set(key, []);
    bucketMap.get(key)!.push(row.composite);
  }

  const buckets = [...bucketMap.entries()]
    .sort(([a], [b]) => parseFloat(a) - parseFloat(b))
    .map(([star_bucket, vals]) => ({
      star_bucket,
      n: vals.length,
      mean_composite: round(vals.reduce((a, b) => a + b, 0) / vals.length),
    }));

  return {
    n: rows.length,
    pearson_r: round(r),
    interpretation: interpretR(r, rows.length, "star rating"),
    buckets,
  };
}

// ── 8. Score vs dependency count ─────────────────────────────────────────

export interface DependencyCorrelationSummary {
  n: number;
  pearson_r: number | null;
  interpretation: string;
  buckets: Array<{
    dep_count: number;
    n: number;
    mean_composite: number;
  }>;
}

export async function scoreVsDependencyCount(): Promise<DependencyCorrelationSummary> {
  const rows = await query<{ composite: number; dependency_count: number }>(
    `SELECT r.composite, m.dependency_count
     FROM runs r
     JOIN skill_metadata m ON r.skill_name = m.skill_name
     WHERE r.skipped = 0 ${runsVisibilitySql("r")}`
  );

  if (rows.length < 3) {
    return { n: rows.length, pearson_r: null, interpretation: "Insufficient data.", buckets: [] };
  }

  const r = pearsonR(rows.map((r) => r.composite), rows.map((r) => r.dependency_count));

  const bucketMap = new Map<number, number[]>();
  for (const row of rows) {
    const k = row.dependency_count;
    if (!bucketMap.has(k)) bucketMap.set(k, []);
    bucketMap.get(k)!.push(row.composite);
  }

  const buckets = [...bucketMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([dep_count, vals]) => ({
      dep_count,
      n: vals.length,
      mean_composite: round(vals.reduce((a, b) => a + b, 0) / vals.length),
    }));

  return {
    n: rows.length,
    pearson_r: round(r),
    interpretation: interpretR(r, rows.length, "dependency count"),
    buckets,
  };
}

// ── 9. Install growth vs score ────────────────────────────────────────────

export interface InstallGrowthRow {
  skill_name: string;
  composite: number;
  first_installs: number;
  latest_installs: number;
  growth_absolute: number;
  growth_pct: number | null;    // null if first_installs === 0
  snapshots: number;
}

export async function installGrowthVsScore(): Promise<InstallGrowthRow[]> {
  // Latest composite per skill
  const scores = await query<{ skill_name: string; composite: number }>(
    `SELECT skill_name, composite FROM runs
     WHERE skipped = 0 ${runsVisibilitySql()}
       AND benchmarked_at = (
         SELECT MAX(benchmarked_at) FROM runs r2
         WHERE r2.skill_name = runs.skill_name AND r2.skipped = 0 ${runsVisibilitySql("r2")}
       )`
  );

  const result: InstallGrowthRow[] = [];
  for (const score of scores) {
    const history = await query<{ install_count: number; recorded_at: string }>(
      `SELECT install_count, recorded_at FROM install_history
       WHERE skill_name = ? ORDER BY recorded_at ASC`,
      [score.skill_name]
    );
    if (history.length < 2) continue;

    const first  = history[0].install_count;
    const latest = history[history.length - 1].install_count;
    const abs    = latest - first;
    const pct    = first > 0 ? round((abs / first) * 100) : null;

    result.push({
      skill_name: score.skill_name,
      composite: round(score.composite),
      first_installs: first,
      latest_installs: latest,
      growth_absolute: abs,
      growth_pct: pct,
      snapshots: history.length,
    });
  }

  return result.sort((a, b) => b.growth_absolute - a.growth_absolute);
}

// ── Re-export stat helpers needed by new analyses ─────────────────────────
// (percentile, pearsonR, interpretR, round are defined earlier in this file)
