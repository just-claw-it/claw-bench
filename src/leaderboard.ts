import { BenchmarkReport, LeaderboardPushResult } from "./types.js";

/** Legacy default; `api.clawhub.dev` may not resolve publicly—set `CLAWHUB_API_URL` when ClawHub documents an endpoint. */
const DEFAULT_CLAWHUB_API_URL = "https://api.clawhub.dev/v1/leaderboard";

export interface LeaderboardPushOptions {
  apiKey: string;
  apiUrl?: string;
  /** Override skill name on leaderboard (defaults to report.skillName) */
  skillName?: string;
  /** Mark as a pre-release / draft submission */
  draft?: boolean;
}

/**
 * Push a benchmark report to the ClawHub public leaderboard.
 *
 * The API contract (v2 target):
 *   POST /v1/leaderboard
 *   Authorization: Bearer <apiKey>
 *   Body: LeaderboardPayload (defined below)
 *
 * Returns the leaderboard entry URL on success.
 */
export async function pushToLeaderboard(
  report: BenchmarkReport,
  opts: LeaderboardPushOptions
): Promise<LeaderboardPushResult> {
  if (report.skippedReason) {
    return {
      success: false,
      error: `Cannot push a skipped benchmark. Reason: ${report.skippedReason}`,
    };
  }

  const url = opts.apiUrl ?? process.env.CLAWHUB_API_URL ?? DEFAULT_CLAWHUB_API_URL;
  const apiKey = opts.apiKey || (process.env.CLAWHUB_API_KEY ?? "");

  if (!apiKey) {
    return {
      success: false,
      error: "No API key provided. Set CLAWHUB_API_KEY or pass --api-key.",
    };
  }

  const payload: LeaderboardPayload = {
    schemaVersion: report.schemaVersion,
    submittedAt: new Date().toISOString(),
    skillName: opts.skillName ?? report.skillName,
    skillType: report.skillType,
    scoreType: report.scoreType,
    composite: report.score.composite,
    dimensions: {
      correctness: report.score.type === "authored" ? report.score.correctness : null,
      consistency: report.score.consistency,
      robustness: report.score.robustness,
      latency: report.score.latency,
    },
    config: {
      embedModel: report.config.embedModel,
      consistencyRuns: report.config.consistencyRuns,
      consistencyThreshold: report.config.consistencyThreshold,
      latencyThresholdMs: report.config.latencyThresholdMs,
    },
    draft: opts.draft ?? false,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "claw-bench/0.1.0",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        success: false,
        error: `Leaderboard API error ${res.status}: ${body}`,
      };
    }

    const data = (await res.json()) as { url?: string };
    return {
      success: true,
      leaderboardUrl: data.url,
    };
  } catch (err) {
    return {
      success: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Payload schema sent to ClawHub API ─────────────────────────────────────

interface LeaderboardPayload {
  schemaVersion: string;
  submittedAt: string;
  skillName: string;
  skillType: string;
  scoreType: string;
  composite: number;
  dimensions: {
    correctness: number | null; // null if automated score
    consistency: number;
    robustness: number;
    latency: number;
  };
  config: {
    embedModel: string;
    consistencyRuns: number;
    consistencyThreshold: number;
    latencyThresholdMs: number;
  };
  draft: boolean;
}
