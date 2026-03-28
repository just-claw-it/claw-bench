// ── Core config ────────────────────────────────────────────────────────────

export interface BenchConfig {
  embedModel: string;       // default: nomic-embed-text
  consistencyRuns: number;  // default: 5
  consistencyThreshold: number; // default: 0.92 (calibrated for nomic-embed-text)
  latencyThresholdMs: number;   // default: 5000
}

export const DEFAULT_CONFIG: BenchConfig = {
  embedModel: process.env.BENCH_EMBED_MODEL ?? "nomic-embed-text",
  consistencyRuns: 5,
  consistencyThreshold: 0.92,
  latencyThresholdMs: 5000,
};

// ── bench.json schema ──────────────────────────────────────────────────────

export interface BenchPair {
  description: string;
  input: Record<string, unknown>;
  expectedOutput: Record<string, unknown>;
}

export interface BenchJson {
  skillName: string;
  pairs: BenchPair[];
}

// ── Skill interface (what claw-bench loads and calls) ──────────────────────

export interface SkillManifest {
  name: string;
  description: string;
  type: "linear" | "webhook" | "cron";
  entrypoint: string; // relative path to the skill's main module
  /**
   * Explicit credential declaration by the skill author.
   * When present, claw-bench uses this list instead of heuristic detection.
   * e.g. ["GITHUB_TOKEN", "OPENAI_API_KEY"]
   */
  credentialVars?: string[];
}

// ── Mock inputs per skill type ─────────────────────────────────────────────

/** Mock HTTP request injected into webhook skills. */
export interface MockWebhookPayload {
  method: "POST" | "GET" | "PUT" | "DELETE" | "PATCH";
  headers: Record<string, string>;
  body: Record<string, unknown>;
  query: Record<string, string>;
  params: Record<string, string>;
}

/** Mock schedule trigger injected into cron skills. */
export interface MockCronTrigger {
  scheduledTime: string;   // ISO 8601
  cronExpression: string;  // e.g. "0 9 * * 1-5"
  timezone: string;        // e.g. "UTC"
  jobName: string;
}

// ── Dimension results ──────────────────────────────────────────────────────

export type CorrectnessMiss = {
  pairIndex: number;
  description: string;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
};

export interface CorrectnessResult {
  tested: boolean;
  passedPairs: number;
  totalPairs: number;
  misses: CorrectnessMiss[];
  score: number; // 0–1, meaningless if !tested
}

export interface ConsistencyResult {
  runs: number;
  embedModel: string;
  threshold: number;
  minSimilarity: number;
  avgSimilarity: number;
  stable: boolean;
  score: number; // 0–1
}

export interface RobustnessResult {
  malformedInputs: number;
  gracefulFailures: number; // returned structured error, didn't crash
  crashes: number;
  score: number; // 0–1
}

export interface LatencyResult {
  thresholdMs: number;
  p50Ms: number;
  p95Ms: number;
  withinThreshold: boolean;
  score: number; // 0–1
}

export interface SemanticCheckResult {
  experimental: true;
  disclaimer: string;
  taskDescription: string;
  result: "pass" | "fail" | "error";
  judgeReasoning: string;
}

// ── Score types ────────────────────────────────────────────────────────────

export type ScoreType = "authored" | "automated";

export interface AuthoredScore {
  type: "authored";
  composite: number; // weighted: correctness 40, consistency 30, robustness 20, latency 10
  correctness: number;
  consistency: number;
  robustness: number;
  latency: number;
}

export interface AutomatedScore {
  type: "automated";
  composite: number; // weighted: consistency 50, robustness 35, latency 15
  consistency: number;
  robustness: number;
  latency: number;
}

// ── Final report ───────────────────────────────────────────────────────────

export interface BenchmarkReport {
  schemaVersion: "1.0";
  generatedAt: string; // ISO 8601
  skillName: string;
  skillPath: string;
  skillType: "linear" | "webhook" | "cron";
  skippedReason?: string; // set if skill was skipped (e.g. requires credentials)
  config: BenchConfig;
  scoreType: ScoreType;
  score: AuthoredScore | AutomatedScore;
  dimensions: {
    correctness: CorrectnessResult;
    consistency: ConsistencyResult;
    robustness: RobustnessResult;
    latency: LatencyResult;
  };
  semanticCheck?: SemanticCheckResult;
}

// ── Leaderboard ────────────────────────────────────────────────────────────

export interface LeaderboardPushResult {
  success: boolean;
  leaderboardUrl?: string;
  error?: string;
}

// ── ClawHub skill metadata ─────────────────────────────────────────────────

/**
 * Full metadata for a ClawHub skill.
 * Consumed by importSkillMetadata() — shape the API response or manual dump
 * to match this interface before importing.
 */
export interface SkillMetadata {
  skillName: string;
  author: string;
  verifiedAuthor: boolean;
  tags: string[];                 // e.g. ["nlp", "webhook", "productivity"]
  starRating: number | null;      // 0–5, null if unrated
  starCount: number;              // number of ratings
  latestVersion: string | null;   // semver string
  firstPublishedAt: string | null; // ISO 8601
  lastUpdatedAt: string | null;   // ISO 8601
  dependencyNames: string[];      // direct dependencies by skill name
  /** Time-series install snapshots — include as many points as ClawHub provides */
  installHistory: Array<{
    recordedAt: string;   // ISO 8601
    installCount: number;
  }>;
  /** All known versions */
  versionHistory: Array<{
    version: string;
    publishedAt: string | null; // ISO 8601
    isLatest: boolean;
  }>;
}

// ── ClawHub catalog types ──────────────────────────────────────────────────

/** Scraped metadata from the ClawHub skills registry page. */
export interface ClawHubSkillEntry {
  slug: string;
  name: string;
  author: string;
  version: string;
  summary: string;
  downloads: string;   // e.g. "295k"
  stars: string;       // e.g. "2.6k"
  versionCount: number;
}

/** Static analysis scores for a ClawHub skill (each 0–1). */
export interface StaticAnalysisResult {
  docQuality: number;
  completeness: number;
  security: number;
  codeQuality: number | null;
  maintainability: number;
  staticComposite: number;
}

/** LLM evaluation scores for a ClawHub skill (each 0–1). */
export interface LLMEvalResult {
  clarity: number;
  usefulness: number;
  safety: number;
  completeness: number;
  llmComposite: number;
  model: string;
  reasoning: string;
}

/** Wall-clock milliseconds per analyze pipeline step (logged + stored on `clawhub_analysis`). */
export interface ClawHubAnalysisTiming {
  /** Unzip into clawhub-skills; 0 when the skill folder already existed. */
  extractMs: number;
  /** Five static analyzers + static composite. */
  staticMs: number;
  /** LLM call; null when `--llm` was not used. */
  llmMs: number | null;
  /** `collectFileStats` (sync scan). */
  fileStatsMs: number;
  /** Wall time for full `analyzeSkill()` (static + optional LLM + file stats). */
  pipelineMs: number;
}

/** Combined analysis result for a ClawHub skill. */
export interface ClawHubAnalysis {
  slug: string;
  analyzedAt: string;
  staticAnalysis: StaticAnalysisResult;
  llmEval: LLMEvalResult | null;
  overallComposite: number;
  fileStats: {
    fileCount: number;
    totalSizeBytes: number;
    hasScripts: boolean;
    skillMdLength: number;
    languages: string[];
  };
  timing: ClawHubAnalysisTiming;
}
