export interface Run {
  id: number;
  recorded_at: string;
  benchmarked_at: string;
  skill_name: string;
  skill_version: string | null;
  skill_type: string;
  skill_path: string;
  score_type: string;
  composite: number;
  score_correctness: number | null;
  score_consistency: number;
  score_robustness: number;
  score_latency: number;
  consistency_min_sim: number;
  consistency_avg_sim: number;
  consistency_stable: number;
  robustness_crashes: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  embed_model: string;
  consistency_threshold: number;
  consistency_runs: number;
  latency_threshold_ms: number;
  skipped: number;
  skipped_reason: string | null;
}

export interface Skill {
  skill_name: string;
  skill_type: string;
  run_count: number;
  last_benchmarked_at: string;
  best_composite: number;
  worst_composite: number;
  latest_composite: number;
  latest_score_type: string;
}

export interface Stats {
  totalRuns: number;
  totalSkills: number;
  totalMetadata: number;
  avgComposite: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
  dbPath: string;
  /** Rows in clawhub_skills (ClawHub catalog seed) */
  clawhubCatalogSkills: number;
}

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
  composite_delta: number;
  max_composite: number;
  min_composite: number;
  versions_seen: string[];
  timeline: DriftPoint[];
  version_deltas: Array<{
    from_version: string;
    to_version: string;
    composite_delta: number;
  }>;
}

export function scoreColor(score: number): string {
  if (score >= 0.8) return "text-emerald-500";
  if (score >= 0.5) return "text-amber-500";
  return "text-red-500";
}

export function scoreBg(score: number): string {
  if (score >= 0.8) return "bg-emerald-500";
  if (score >= 0.5) return "bg-amber-500";
  return "bg-red-500";
}

export function pct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

// ── ClawHub catalog types ──────────────────────────────────────────────────

/** One LLM judge’s scores (latest run per model name for that skill). */
export interface LlmModelBreakdown {
  model: string;
  analyzed_at: string;
  llm_clarity: number;
  llm_usefulness: number;
  llm_safety: number;
  llm_completeness: number;
  llm_composite: number;
  llm_reasoning?: string | null;
}

export interface CatalogSkill {
  slug: string;
  name: string;
  author: string;
  version: string;
  downloads: string;
  stars: string;
  version_count: number;
  description: string | null;
  has_scripts: number;
  file_count: number;
  total_size_bytes: number;
  skill_md_length: number;
  analyzed: boolean;
  doc_quality: number | null;
  completeness_score: number | null;
  security: number | null;
  code_quality: number | null;
  maintainability: number | null;
  static_composite: number | null;
  llm_clarity: number | null;
  llm_usefulness: number | null;
  llm_safety: number | null;
  llm_completeness: number | null;
  llm_composite: number | null;
  /** Distinct LLM models with scores (latest row per model); null if none. */
  llm_model_count: number | null;
  /** JSON array of LlmModelBreakdown (compact in catalog: no reasoning). */
  llm_models_json: string | null;
  overall_composite: number | null;
  /** Wall-clock ms from latest analysis row (null if never analyzed). */
  extract_ms?: number | null;
  static_analysis_ms?: number | null;
  llm_ms?: number | null;
  file_stats_ms?: number | null;
  pipeline_ms?: number | null;
}

/** Response from GET /api/catalog (paginated). */
export interface CatalogPage {
  skills: CatalogSkill[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface SkillAnalysisDetail extends CatalogSkill {
  llm_model: string | null;
  llm_reasoning: string | null;
  analyzed_at: string | null;
  extracted_path: string | null;
  zip_path: string | null;
  scraped_at: string;
  skill_md_content: string | null;
  files: string[];
  /** JSON string of ClawHubSourceInsights; parse on the client. */
  analysis_insights?: string | null;
  /** Convex / `import-metadata` row when `skill_name` matches this slug. */
  import_meta_author?: string | null;
  import_meta_verified_author?: number | null;
  import_meta_tags?: string | null;
  import_meta_star_rating?: number | null;
  import_meta_star_count?: number | null;
  import_meta_latest_version?: string | null;
  import_meta_total_versions?: number | null;
  import_meta_dependency_count?: number | null;
  import_meta_first_published_at?: string | null;
  import_meta_last_updated_at?: string | null;
  import_meta_recorded_at?: string | null;
}

export interface CatalogStats {
  totalSkills: number;
  analyzedCount: number;
  avgOverallComposite: number;
  avgStaticComposite: number;
  withScripts: number;
  /** Resolved SQLite path (same as server `CLAW_BENCH_DB` or default). */
  dbPath: string;
}
