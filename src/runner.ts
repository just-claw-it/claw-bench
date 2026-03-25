import * as path from "path";
import * as fs from "fs";
import {
  BenchConfig,
  BenchmarkReport,
  DEFAULT_CONFIG,
  SemanticCheckResult,
} from "./types.js";
import {
  loadManifest,
  loadBenchJson,
  requiresCredentials,
  runSkill,
} from "./harness.js";
import {
  scoreCorrectness,
  scoreConsistency,
  scoreRobustness,
  scoreLatency,
  computeAuthoredScore,
  computeAutomatedScore,
} from "./scoring.js";
import { storeRun } from "./store.js";

// ── Resolve skill directory ────────────────────────────────────────────────

export function resolveSkillDir(nameOrPath: string): string {
  if (nameOrPath.startsWith(".") || nameOrPath.startsWith("/")) {
    const resolved = path.resolve(nameOrPath);
    if (!fs.existsSync(resolved)) throw new Error(`Path not found: ${resolved}`);
    return resolved;
  }
  const candidates = [
    path.join(process.cwd(), "skills", nameOrPath),
    path.join(process.env.HOME ?? "", ".clawhub", "skills", nameOrPath),
    path.join("/usr/local/lib/clawhub/skills", nameOrPath),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `Skill '${nameOrPath}' not found. ` +
    `Use a path (./path/to/skill) or install it via ClawHub.`
  );
}

// ── Skipped report helper ──────────────────────────────────────────────────

function skippedReport(
  skillName: string,
  skillPath: string,
  skillType: BenchmarkReport["skillType"],
  config: BenchConfig,
  reason: string
): BenchmarkReport {
  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    skillName,
    skillPath,
    skillType,
    skippedReason: reason,
    config,
    scoreType: "automated",
    score: computeAutomatedScore(0, 0, 0),
    dimensions: {
      correctness: { tested: false, passedPairs: 0, totalPairs: 0, misses: [], score: 0 },
      consistency: { runs: 0, embedModel: config.embedModel, threshold: config.consistencyThreshold, minSimilarity: 0, avgSimilarity: 0, stable: false, score: 0 },
      robustness: { malformedInputs: 0, gracefulFailures: 0, crashes: 0, score: 0 },
      latency: { thresholdMs: config.latencyThresholdMs, p50Ms: 0, p95Ms: 0, withinThreshold: false, score: 0 },
    },
  };
}

// ── Optional: LLM semantic check ──────────────────────────────────────────

async function runSemanticCheck(
  taskDescription: string,
  output: string
): Promise<SemanticCheckResult> {
  const DISCLAIMER =
    "semantic-check results are indicative only and have not been validated for false negative rate.";
  try {
    const prompt =
      `Task: ${taskDescription}\n\nSkill output:\n${output}\n\n` +
      `Did this output accomplish the task? Reply with exactly: PASS or FAIL, then one sentence of reasoning.`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
        max_tokens: 120,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      return { experimental: true, disclaimer: DISCLAIMER, taskDescription, result: "error", judgeReasoning: `API error ${res.status}` };
    }
    const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
    const text = data.content.find((b) => b.type === "text")?.text ?? "";
    const result: "pass" | "fail" = text.toUpperCase().startsWith("PASS") ? "pass" : "fail";
    return { experimental: true, disclaimer: DISCLAIMER, taskDescription, result, judgeReasoning: text.replace(/^(PASS|FAIL)[,.\s]*/i, "").trim() };
  } catch (err) {
    return {
      experimental: true,
      disclaimer: DISCLAIMER,
      taskDescription,
      result: "error",
      judgeReasoning: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Main benchmark orchestrator ────────────────────────────────────────────

export interface RunOptions {
  config?: Partial<BenchConfig>;
  semanticCheck?: boolean;
  outputDir?: string;
  skillVersion?: string;
  noStore?: boolean;   // opt out of local DB write (e.g. in tests)
}

export async function benchmark(
  nameOrPath: string,
  opts: RunOptions = {}
): Promise<BenchmarkReport> {
  const skillPath = resolveSkillDir(nameOrPath);
  const config: BenchConfig = { ...DEFAULT_CONFIG, ...opts.config };
  const manifest = loadManifest(skillPath);
  const skillName = manifest.name;
  const skillType = manifest.type;

  // Credential check — skip with explicit message
  if (requiresCredentials(skillPath, manifest)) {
    return skippedReport(
      skillName, skillPath, skillType, config,
      "Skill requires external credentials. " +
      "Declare `credentialVars: []` in skill.json to confirm none are needed, " +
      "or mock them before benchmarking."
    );
  }

  const benchJson = loadBenchJson(skillPath);
  const hasAuthored = benchJson !== null && benchJson.pairs.length > 0;

  const [correctness, consistency, robustness, latency] = await Promise.all([
    scoreCorrectness(skillPath, manifest, benchJson),
    scoreConsistency(skillPath, manifest, benchJson, config),
    scoreRobustness(skillPath, manifest, config),
    scoreLatency(skillPath, manifest, benchJson, config),
  ]);

  const scoreType = hasAuthored ? "authored" : "automated";
  const score = hasAuthored
    ? computeAuthoredScore(correctness.score, consistency.score, robustness.score, latency.score)
    : computeAutomatedScore(consistency.score, robustness.score, latency.score);

  let semanticCheck: SemanticCheckResult | undefined;
  if (opts.semanticCheck && benchJson?.pairs[0]) {
    const probeResult = await runSkill(skillPath, manifest, benchJson.pairs[0].input);
    const actualOutput = probeResult.output
      ? JSON.stringify(probeResult.output)
      : (probeResult.error ?? "crash");
    semanticCheck = await runSemanticCheck(
      benchJson.pairs[0].description,
      actualOutput
    );
  }

  const report: BenchmarkReport = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    skillName,
    skillPath,
    skillType,
    config,
    scoreType,
    score,
    dimensions: { correctness, consistency, robustness, latency },
    semanticCheck,
  };

  if (!opts.noStore) {
    await storeRun(report, { skillVersion: opts.skillVersion }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[claw-bench] Warning: could not write to local DB: ${msg}`);
    });
  }

  return report;
}
