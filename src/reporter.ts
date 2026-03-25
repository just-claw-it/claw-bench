import * as fs from "fs";
import * as path from "path";
import { BenchmarkReport, AuthoredScore, AutomatedScore } from "./types.js";

// ── Formatting helpers ─────────────────────────────────────────────────────

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const CYAN   = "\x1b[36m";

function scoreColor(score: number): string {
  if (score >= 0.8) return GREEN;
  if (score >= 0.5) return YELLOW;
  return RED;
}

function bar(score: number, width = 20): string {
  const filled = Math.round(score * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function pct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function scoreRow(label: string, score: number): string {
  const col = scoreColor(score);
  return `  ${label.padEnd(16)} ${col}${bar(score)}${RESET} ${col}${pct(score)}${RESET}`;
}

// ── stdout report ──────────────────────────────────────────────────────────

export function printReport(report: BenchmarkReport): void {
  const { skillName, scoreType, score, dimensions, semanticCheck, skippedReason } = report;

  console.log();
  console.log(`${BOLD}${CYAN}claw-bench report${RESET}  ${DIM}${report.generatedAt}${RESET}`);
  console.log(`${BOLD}Skill:${RESET} ${skillName}  ${DIM}(${report.skillPath})${RESET}`);
  console.log();

  if (skippedReason) {
    console.log(`${YELLOW}⚠  SKIPPED: ${skippedReason}${RESET}`);
    console.log();
    return;
  }

  // Score type header — always explicit
  if (scoreType === "authored") {
    console.log(`${BOLD}Score type:${RESET} ${GREEN}AUTHORED${RESET}  (bench.json present — correctness included)`);
  } else {
    console.log(`${BOLD}Score type:${RESET} ${YELLOW}AUTOMATED${RESET}  (no bench.json — correctness marked untested)`);
  }
  console.log();

  // Composite
  const composite = score.composite;
  const col = scoreColor(composite);
  console.log(`${BOLD}Composite score:${RESET} ${col}${BOLD}${pct(composite)}${RESET}`);
  console.log();

  // Dimension breakdown
  console.log(`${BOLD}Dimensions:${RESET}`);
  if (scoreType === "authored") {
    const s = score as AuthoredScore;
    if (dimensions.correctness.tested) {
      console.log(scoreRow("Correctness", s.correctness));
      console.log(`    ${dimensions.correctness.passedPairs}/${dimensions.correctness.totalPairs} pairs passed`);
    } else {
      console.log(`  ${"Correctness".padEnd(16)} ${DIM}UNTESTED (no bench.json)${RESET}`);
    }
    console.log(scoreRow("Consistency", s.consistency));
    console.log(scoreRow("Robustness", s.robustness));
    console.log(scoreRow("Latency", s.latency));
  } else {
    const s = score as AutomatedScore;
    console.log(`  ${"Correctness".padEnd(16)} ${DIM}UNTESTED (no bench.json)${RESET}`);
    console.log(scoreRow("Consistency", s.consistency));
    console.log(scoreRow("Robustness", s.robustness));
    console.log(scoreRow("Latency", s.latency));
  }

  // Consistency detail
  const c = dimensions.consistency;
  console.log();
  console.log(`${BOLD}Consistency detail:${RESET}`);
  console.log(`  Model:       ${c.embedModel}`);
  console.log(`  Runs:        ${c.runs}`);
  console.log(`  Threshold:   ${c.threshold} (calibrated for nomic-embed-text)`);
  console.log(`  Min sim:     ${c.minSimilarity.toFixed(4)}  ${c.stable ? GREEN + "✓ stable" + RESET : RED + "✗ unstable" + RESET}`);
  console.log(`  Avg sim:     ${c.avgSimilarity.toFixed(4)}`);

  // Robustness detail
  const r = dimensions.robustness;
  console.log();
  console.log(`${BOLD}Robustness detail:${RESET}`);
  console.log(`  Malformed inputs tested: ${r.malformedInputs}`);
  console.log(`  Graceful failures:       ${r.gracefulFailures}`);
  console.log(`  Crashes:                 ${r.crashes}  ${r.crashes > 0 ? RED + "⚠" + RESET : GREEN + "✓" + RESET}`);

  // Latency detail
  const l = dimensions.latency;
  console.log();
  console.log(`${BOLD}Latency detail:${RESET}`);
  console.log(`  p50:  ${l.p50Ms}ms`);
  console.log(`  p95:  ${l.p95Ms}ms  (threshold: ${l.thresholdMs}ms)  ${l.withinThreshold ? GREEN + "✓" + RESET : RED + "✗" + RESET}`);

  // Correctness misses
  if (dimensions.correctness.tested && dimensions.correctness.misses.length > 0) {
    console.log();
    console.log(`${BOLD}Correctness misses:${RESET}`);
    for (const miss of dimensions.correctness.misses) {
      console.log(`  [pair ${miss.pairIndex}] ${miss.description}`);
      console.log(`    expected: ${JSON.stringify(miss.expected)}`);
      console.log(`    actual:   ${JSON.stringify(miss.actual)}`);
    }
  }

  // Semantic check — visually distinct, experimental
  if (semanticCheck) {
    console.log();
    console.log(`${DIM}─────────────────────────────────────────────────────${RESET}`);
    console.log(`${DIM}[experimental] semantic-check${RESET}`);
    console.log(`${DIM}semantic-check results are indicative only and have not been validated for false negative rate.${RESET}`);
    const resultColor = semanticCheck.result === "pass" ? GREEN : semanticCheck.result === "fail" ? RED : YELLOW;
    console.log(`  Result:  ${resultColor}${semanticCheck.result.toUpperCase()}${RESET}`);
    console.log(`  Reason:  ${DIM}${semanticCheck.judgeReasoning}${RESET}`);
  }

  console.log();
}

// ── JSON report ────────────────────────────────────────────────────────────

export function writeJsonReport(report: BenchmarkReport, outputDir: string): string {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const filename = `benchmark-report.json`;
  const filePath = path.join(outputDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

export function printComparison(a: BenchmarkReport, b: BenchmarkReport): void {
  console.log();
  console.log(`${BOLD}${CYAN}claw-bench comparison${RESET}`);
  console.log();

  const headers = ["Skill", "Type", "Composite", "Consistency", "Robustness", "Latency"];
  const rows = [a, b].map((r) => [
    r.skillName,
    r.scoreType,
    pct(r.score.composite),
    pct(r.score.consistency),
    pct(r.score.robustness),
    pct(r.score.latency),
  ]);

  // Simple table
  const col = (s: string, w: number) => s.padEnd(w);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)) + 2
  );
  const line = widths.map((w) => "─".repeat(w)).join("┼");
  console.log(headers.map((h, i) => col(h, widths[i])).join("│"));
  console.log(line);
  for (const row of rows) {
    console.log(row.map((cell, i) => col(cell, widths[i])).join("│"));
  }
  console.log();

  const winner =
    a.score.composite > b.score.composite
      ? a.skillName
      : b.score.composite > a.score.composite
      ? b.skillName
      : null;
  if (winner) {
    console.log(`${GREEN}${BOLD}${winner}${RESET} scores higher overall.`);
  } else {
    console.log(`Scores are equal.`);
  }
  console.log();
}
