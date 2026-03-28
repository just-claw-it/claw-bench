/**
 * ClawHub catalog scoring: composite weights (static vs LLM) and multi-LLM aggregation.
 * Mirrors common “composite evaluator” patterns (weighted sum of heterogeneous judges).
 */

/** Latest row per (slug, llm_model) among runs that have LLM scores. */
export const CLAWHUB_LLM_LATEST_PER_MODEL_SUB = `
  SELECT ca.*,
    ROW_NUMBER() OVER (
      PARTITION BY ca.slug, ca.llm_model
      ORDER BY ca.analyzed_at DESC
    ) AS rnm
  FROM clawhub_analysis ca
  WHERE ca.llm_model IS NOT NULL AND ca.llm_composite IS NOT NULL
`;

/** One row per latest LLM evaluation per model name for a skill. */
export const CLAWHUB_LP_ROWSET = `(SELECT * FROM (${CLAWHUB_LLM_LATEST_PER_MODEL_SUB}) lp WHERE lp.rnm = 1)`;

export type LlmAggregateMode = "mean" | "median" | "min" | "max";

function clampNonNeg(n: number, fallback: number): number {
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * Weights for overall composite when LLM data exists: wStatic * static + wLlm * llm_agg.
 * Normalized to sum to 1. Defaults 0.6 / 0.4.
 */
export function readClawHubOverallWeights(): { wStatic: number; wLlm: number } {
  let ws = parseFloat(process.env.CLAWHUB_OVERALL_STATIC_WEIGHT ?? "0.6");
  let wl = parseFloat(process.env.CLAWHUB_OVERALL_LLM_WEIGHT ?? "0.4");
  ws = clampNonNeg(ws, 0.6);
  wl = clampNonNeg(wl, 0.4);
  const t = ws + wl;
  if (t <= 0) return { wStatic: 0.6, wLlm: 0.4 };
  return { wStatic: ws / t, wLlm: wl / t };
}

/** How to combine scores from multiple LLM models (latest run per model). */
export function readLlmAggregateMode(): LlmAggregateMode {
  const raw = (process.env.CLAWHUB_LLM_AGGREGATE ?? "mean").toLowerCase().trim();
  if (raw === "median") return "median";
  if (raw === "min") return "min";
  if (raw === "max") return "max";
  if (raw === "mean" || raw === "avg" || raw === "average") return "mean";
  return "mean";
}

/** SQL fragment: CASE … END for overall_composite (aliases: latest, llm). */
export function clawhubOverallCompositeSqlExpr(): string {
  const { wStatic, wLlm } = readClawHubOverallWeights();
  return `CASE
         WHEN llm.llm_composite IS NOT NULL AND latest.static_composite IS NOT NULL
           THEN latest.static_composite * ${wStatic} + llm.llm_composite * ${wLlm}
         ELSE COALESCE(latest.overall_composite, latest.static_composite)
       END`;
}

function medianSubqueryForColumn(col: string): string {
  return `(
    SELECT t.slug, AVG(t.v) AS ${col}
    FROM (
      SELECT z.slug, z.${col} AS v
      FROM (
        SELECT b.slug, b.${col},
          ROW_NUMBER() OVER (PARTITION BY b.slug ORDER BY b.${col}) AS rk,
          COUNT(*) OVER (PARTITION BY b.slug) AS n
        FROM ${CLAWHUB_LP_ROWSET} b
      ) z
      WHERE (z.n % 2 = 1 AND z.rk = (z.n + 1) / 2)
         OR (z.n % 2 = 0 AND z.rk IN (z.n / 2, z.n / 2 + 1))
    ) t
    GROUP BY t.slug
  )`;
}

function buildMedianLlmStatsSubquery(): string {
  const c0 = medianSubqueryForColumn("llm_clarity");
  const c1 = medianSubqueryForColumn("llm_usefulness");
  const c2 = medianSubqueryForColumn("llm_safety");
  const c3 = medianSubqueryForColumn("llm_completeness");
  const c4 = medianSubqueryForColumn("llm_composite");
  return `
    SELECT cnt.slug, cnt.llm_model_count,
      m0.llm_clarity, m1.llm_usefulness, m2.llm_safety, m3.llm_completeness, m4.llm_composite
    FROM (SELECT slug, COUNT(*) AS llm_model_count FROM ${CLAWHUB_LP_ROWSET} GROUP BY slug) cnt
    LEFT JOIN ${c0} m0 ON m0.slug = cnt.slug
    LEFT JOIN ${c1} m1 ON m1.slug = cnt.slug
    LEFT JOIN ${c2} m2 ON m2.slug = cnt.slug
    LEFT JOIN ${c3} m3 ON m3.slug = cnt.slug
    LEFT JOIN ${c4} m4 ON m4.slug = cnt.slug
  `;
}

/**
 * Subquery body: slug, llm_model_count, llm_clarity … llm_composite (aggregated across models).
 */
export function buildClawhubLlmAggregateSubquery(): string {
  const mode = readLlmAggregateMode();
  if (mode === "median") {
    return buildMedianLlmStatsSubquery();
  }
  const fn = mode === "min" ? "MIN" : mode === "max" ? "MAX" : "AVG";
  return `
    SELECT x.slug, COUNT(*) AS llm_model_count,
      ${fn}(x.llm_clarity) AS llm_clarity,
      ${fn}(x.llm_usefulness) AS llm_usefulness,
      ${fn}(x.llm_safety) AS llm_safety,
      ${fn}(x.llm_completeness) AS llm_completeness,
      ${fn}(x.llm_composite) AS llm_composite
    FROM ${CLAWHUB_LP_ROWSET} x
    GROUP BY x.slug
  `;
}

/** Same formula as SQL overall, for a single analyze run (one LLM judge). */
export function computeOverallComposite(staticComposite: number, llmComposite: number | null): number {
  const { wStatic, wLlm } = readClawHubOverallWeights();
  if (llmComposite == null || !Number.isFinite(llmComposite)) {
    return staticComposite;
  }
  return staticComposite * wStatic + llmComposite * wLlm;
}
