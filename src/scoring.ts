import {
  BenchConfig,
  BenchJson,
  CorrectnessResult,
  ConsistencyResult,
  RobustnessResult,
  LatencyResult,
  AuthoredScore,
  AutomatedScore,
  SkillManifest,
} from "./types.js";
import {
  runSkill,
  syntheticMalformedInputs,
  collectConsistencyOutputs,
} from "./harness.js";
import { consistencyStats } from "./embeddings.js";

// ── Correctness ────────────────────────────────────────────────────────────

export async function scoreCorrectness(
  skillDir: string,
  manifest: SkillManifest,
  benchJson: BenchJson | null
): Promise<CorrectnessResult> {
  if (!benchJson || benchJson.pairs.length === 0) {
    return { tested: false, passedPairs: 0, totalPairs: 0, misses: [], score: 0 };
  }

  let passed = 0;
  const misses: CorrectnessResult["misses"] = [];

  for (let i = 0; i < benchJson.pairs.length; i++) {
    const pair = benchJson.pairs[i];
    const result = await runSkill(skillDir, manifest, pair.input);
    if (result.crashed || result.output === null) {
      misses.push({
        pairIndex: i,
        description: pair.description,
        expected: pair.expectedOutput,
        actual: { error: result.error ?? "crash" },
      });
      continue;
    }
    // Deep equality check against expected output keys
    const allMatch = Object.entries(pair.expectedOutput).every(
      ([k, v]) => JSON.stringify(result.output![k]) === JSON.stringify(v)
    );
    if (allMatch) {
      passed++;
    } else {
      misses.push({
        pairIndex: i,
        description: pair.description,
        expected: pair.expectedOutput,
        actual: result.output,
      });
    }
  }

  return {
    tested: true,
    passedPairs: passed,
    totalPairs: benchJson.pairs.length,
    misses,
    score: passed / benchJson.pairs.length,
  };
}

// ── Consistency ────────────────────────────────────────────────────────────

export async function scoreConsistency(
  skillDir: string,
  manifest: SkillManifest,
  benchJson: BenchJson | null,
  config: BenchConfig
): Promise<ConsistencyResult> {
  const outputs = await collectConsistencyOutputs(
    skillDir,
    manifest,
    benchJson,
    config.consistencyRuns
  );

  let minSimilarity: number;
  let avgSimilarity: number;

  try {
    ({ minSimilarity, avgSimilarity } = await consistencyStats(outputs, config));
  } catch {
    // Ollama unavailable — degrade gracefully, score as 0
    return {
      runs: config.consistencyRuns,
      embedModel: config.embedModel,
      threshold: config.consistencyThreshold,
      minSimilarity: 0,
      avgSimilarity: 0,
      stable: false,
      score: 0,
    };
  }

  const stable = minSimilarity >= config.consistencyThreshold;
  const floor = Math.max(0, config.consistencyThreshold - 0.1);
  const range = 1 - floor;
  const score = range <= 0 ? (avgSimilarity >= 1 ? 1 : 0)
    : Math.max(0, Math.min(1, (avgSimilarity - floor) / range));

  return {
    runs: config.consistencyRuns,
    embedModel: config.embedModel,
    threshold: config.consistencyThreshold,
    minSimilarity,
    avgSimilarity,
    stable,
    score,
  };
}

// ── Robustness ────────────────────────────────────────────────────────────

export async function scoreRobustness(
  skillDir: string,
  manifest: SkillManifest,
  config: BenchConfig
): Promise<RobustnessResult> {
  const inputs = syntheticMalformedInputs(config, manifest.type);
  let graceful = 0;
  let crashes = 0;

  for (const input of inputs) {
    const result = await runSkill(skillDir, manifest, input);
    if (result.crashed) {
      crashes++;
    } else {
      graceful++;
    }
  }

  return {
    malformedInputs: inputs.length,
    gracefulFailures: graceful,
    crashes,
    // Every crash is penalised; graceful error responses are fine
    score: graceful / inputs.length,
  };
}

// ── Latency ────────────────────────────────────────────────────────────────

export async function scoreLatency(
  skillDir: string,
  manifest: SkillManifest,
  benchJson: BenchJson | null,
  config: BenchConfig
): Promise<LatencyResult> {
  const input: Record<string, unknown> =
    benchJson?.pairs[0]?.input ?? { input: "benchmark-latency-probe" };

  const samples: number[] = [];
  const runs = config.consistencyRuns;

  for (let i = 0; i < runs; i++) {
    const result = await runSkill(skillDir, manifest, input);
    samples.push(result.durationMs);
  }

  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? samples[samples.length - 1];

  const withinThreshold = p95 <= config.latencyThresholdMs;
  const score = config.latencyThresholdMs <= 0 ? (p95 <= 0 ? 1 : 0)
    : Math.max(0, 1 - (p95 - config.latencyThresholdMs) / (2 * config.latencyThresholdMs));

  return {
    thresholdMs: config.latencyThresholdMs,
    p50Ms: Math.round(p50),
    p95Ms: Math.round(p95),
    withinThreshold,
    score: withinThreshold ? 1 : Math.round(score * 100) / 100,
  };
}

// ── Composite scores ───────────────────────────────────────────────────────

export function computeAuthoredScore(
  correctness: number,
  consistency: number,
  robustness: number,
  latency: number
): AuthoredScore {
  const composite =
    correctness * 0.4 + consistency * 0.3 + robustness * 0.2 + latency * 0.1;
  return {
    type: "authored",
    composite: Math.round(composite * 100) / 100,
    correctness: Math.round(correctness * 100) / 100,
    consistency: Math.round(consistency * 100) / 100,
    robustness: Math.round(robustness * 100) / 100,
    latency: Math.round(latency * 100) / 100,
  };
}

export function computeAutomatedScore(
  consistency: number,
  robustness: number,
  latency: number
): AutomatedScore {
  const composite = consistency * 0.5 + robustness * 0.35 + latency * 0.15;
  return {
    type: "automated",
    composite: Math.round(composite * 100) / 100,
    consistency: Math.round(consistency * 100) / 100,
    robustness: Math.round(robustness * 100) / 100,
    latency: Math.round(latency * 100) / 100,
  };
}
