#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_CONFIG, SkillMetadata } from "./types.js";
import { benchmark } from "./runner.js";
import { printReport, writeJsonReport, printComparison } from "./reporter.js";
import { pushToLeaderboard } from "./leaderboard.js";
import { importSkillMetadata, runCount, dbPath, metadataCount } from "./store.js";
import {
  scoreDistributions,
  thresholdCalibration,
  installCorrelation,
  scoreDrift,
  allDrift,
  scoreByAuthorVerification,
  scoreByTag,
  scoreVsStarRating,
  scoreVsDependencyCount,
  installGrowthVsScore,
} from "./analyze.js";

const program = new Command();

program
  .name("claw-bench")
  .description("Benchmark tool for ClawHub skills")
  .version("0.1.0");

// ── claw-bench run <skill> ─────────────────────────────────────────────────

program
  .command("run <skill>")
  .description("Benchmark an installed or local skill")
  .option("--threshold <n>", "Consistency similarity threshold (default 0.92)", parseFloat)
  .option("--runs <n>", "Number of consistency runs (default 5)", parseInt)
  .option("--latency-threshold <ms>", "Latency p95 threshold in ms (default 5000)", parseInt)
  .option("--embed-model <model>", "Ollama embedding model (default nomic-embed-text)")
  .option("--semantic-check", "Run experimental LLM semantic check (requires ANTHROPIC_API_KEY)")
  .option("--skill-version <v>", "Tag this run with a version string for drift tracking")
  .option("--no-store", "Skip recording this run to the local database")
  .option("--output-dir <dir>", "Directory to write benchmark-report.json", "./bench-reports")
  .action(async (skill: string, opts) => {
    console.log(`\nRunning benchmark for: ${skill}`);
    const config = {
      embedModel: opts.embedModel ?? DEFAULT_CONFIG.embedModel,
      consistencyRuns: opts.runs ?? DEFAULT_CONFIG.consistencyRuns,
      consistencyThreshold: opts.threshold ?? DEFAULT_CONFIG.consistencyThreshold,
      latencyThresholdMs: opts.latencyThreshold ?? DEFAULT_CONFIG.latencyThresholdMs,
    };
    try {
      const report = await benchmark(skill, {
        config,
        semanticCheck: !!opts.semanticCheck,
        skillVersion: opts.skillVersion,
        noStore: !opts.store,
      });
      printReport(report);
      const jsonPath = writeJsonReport(report, opts.outputDir ?? "./bench-reports");
      console.log(`Report saved: ${jsonPath}`);
      if (opts.store !== false) {
        console.log(`Run recorded to: ${dbPath()}`);
      }
      console.log();
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

// ── claw-bench compare <skill-a> <skill-b> ────────────────────────────────

program
  .command("compare <skillA> <skillB>")
  .description("Side-by-side benchmark comparison of two skills")
  .option("--threshold <n>", "Consistency similarity threshold (default 0.92)", parseFloat)
  .option("--runs <n>", "Number of consistency runs (default 5)", parseInt)
  .option("--latency-threshold <ms>", "Latency p95 threshold in ms (default 5000)", parseInt)
  .option("--embed-model <model>", "Ollama embedding model (default nomic-embed-text)")
  .option("--output-dir <dir>", "Directory to write reports", "./bench-reports")
  .action(async (skillA: string, skillB: string, opts) => {
    console.log(`\nComparing: ${skillA} vs ${skillB}`);
    const config = {
      embedModel: opts.embedModel ?? DEFAULT_CONFIG.embedModel,
      consistencyRuns: opts.runs ?? DEFAULT_CONFIG.consistencyRuns,
      consistencyThreshold: opts.threshold ?? DEFAULT_CONFIG.consistencyThreshold,
      latencyThresholdMs: opts.latencyThreshold ?? DEFAULT_CONFIG.latencyThresholdMs,
    };
    try {
      const [reportA, reportB] = await Promise.all([
        benchmark(skillA, { config, outputDir: opts.outputDir }),
        benchmark(skillB, { config, outputDir: opts.outputDir }),
      ]);
      printComparison(reportA, reportB);
      writeJsonReport(reportA, path.join(opts.outputDir, skillA));
      writeJsonReport(reportB, path.join(opts.outputDir, skillB));
      console.log(`Reports saved to ${opts.outputDir}\n`);
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

// ── claw-bench report ─────────────────────────────────────────────────────

program
  .command("report")
  .description("Export the last benchmark report")
  .option("--format <fmt>", "Output format: json | md", "json")
  .option("--input <file>", "Path to benchmark-report.json", "./bench-reports/benchmark-report.json")
  .action((opts) => {
    if (!fs.existsSync(opts.input)) {
      console.error(`No report found at ${opts.input}. Run 'claw-bench run <skill>' first.`);
      process.exit(1);
    }
    const report = JSON.parse(fs.readFileSync(opts.input, "utf-8"));
    if (opts.format === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else if (opts.format === "md") {
      const s = report.score;
      const d = report.dimensions;
      const lines = [
        `# claw-bench report`,
        `**Skill:** ${report.skillName}  `,
        `**Score type:** ${report.scoreType.toUpperCase()}  `,
        `**Composite:** ${Math.round(s.composite * 100)}%  `,
        `**Generated:** ${report.generatedAt}`,
        ``,
        `## Dimensions`,
        `| Dimension | Score |`,
        `|-----------|-------|`,
        report.scoreType === "authored"
          ? `| Correctness | ${Math.round(s.correctness * 100)}% |`
          : `| Correctness | UNTESTED |`,
        `| Consistency | ${Math.round(s.consistency * 100)}% |`,
        `| Robustness | ${Math.round(s.robustness * 100)}% |`,
        `| Latency | ${Math.round(s.latency * 100)}% |`,
        ``,
        `## Consistency`,
        `- Model: ${d.consistency.embedModel}`,
        `- Runs: ${d.consistency.runs}`,
        `- Min similarity: ${d.consistency.minSimilarity.toFixed(4)}`,
        `- Stable: ${d.consistency.stable}`,
        ``,
        `## Robustness`,
        `- Malformed inputs: ${d.robustness.malformedInputs}`,
        `- Graceful failures: ${d.robustness.gracefulFailures}`,
        `- Crashes: ${d.robustness.crashes}`,
        ``,
        `## Latency`,
        `- p50: ${d.latency.p50Ms}ms`,
        `- p95: ${d.latency.p95Ms}ms (threshold: ${d.latency.thresholdMs}ms)`,
      ];
      if (report.semanticCheck) {
        lines.push(
          ``,
          `## [experimental] Semantic Check`,
          `> semantic-check results are indicative only and have not been validated for false negative rate.`,
          `- Result: ${report.semanticCheck.result.toUpperCase()}`,
          `- Reasoning: ${report.semanticCheck.judgeReasoning}`
        );
      }
      console.log(lines.join("\n"));
    } else {
      console.error(`Unknown format: ${opts.format}. Use 'json' or 'md'.`);
      process.exit(1);
    }
  });

// ── claw-bench push ───────────────────────────────────────────────────────

program
  .command("push")
  .description("Push the last benchmark report to the ClawHub leaderboard")
  .option("--input <file>", "Path to benchmark-report.json", "./bench-reports/benchmark-report.json")
  .option("--api-key <key>", "ClawHub API key (or set CLAWHUB_API_KEY)")
  .option("--api-url <url>", "Override ClawHub API endpoint")
  .option("--skill-name <n>", "Override skill name on the leaderboard")
  .option("--draft", "Submit as a draft (not visible on public leaderboard)")
  .action(async (opts) => {
    if (!fs.existsSync(opts.input)) {
      console.error(`No report found at ${opts.input}. Run 'claw-bench run <skill>' first.`);
      process.exit(1);
    }
    const report = JSON.parse(fs.readFileSync(opts.input, "utf-8"));
    console.log(`\nPushing benchmark for '${report.skillName}' to ClawHub leaderboard...`);
    const result = await pushToLeaderboard(report, {
      apiKey: opts.apiKey ?? process.env.CLAWHUB_API_KEY ?? "",
      apiUrl: opts.apiUrl,
      skillName: opts.skillName,
      draft: !!opts.draft,
    });
    if (result.success) {
      console.log(`\n✓ Pushed successfully.`);
      if (result.leaderboardUrl) console.log(`  Leaderboard entry: ${result.leaderboardUrl}`);
    } else {
      console.error(`\n✗ Push failed: ${result.error}`);
      process.exit(1);
    }
    console.log();
  });

// ── claw-bench data ───────────────────────────────────────────────────────

const data = program
  .command("data")
  .description("Query the local benchmark database");

data
  .command("stats")
  .description("Total runs and DB location")
  .action(async () => {
    const [runs, meta] = await Promise.all([runCount(), metadataCount()]);
    console.log(`\nDB:              ${dbPath()}`);
    console.log(`Runs:            ${runs}`);
    console.log(`Skills (metadata): ${meta}\n`);
  });

data
  .command("distribution")
  .description("Score distributions grouped by skill type")
  .option("--format <fmt>", "json | table", "table")
  .action(async (opts) => {
    const rows = await scoreDistributions();
    if (rows.length === 0) { console.log("\nNo data yet.\n"); return; }
    if (opts.format === "json") { console.log(JSON.stringify(rows, null, 2)); return; }
    console.log("\nScore distributions (composite, 0–1)\n");
    for (const r of rows) {
      console.log(`  ${r.skill_type} / ${r.score_type}  (n=${r.n})`);
      console.log(`    min=${r.min_composite}  p25=${r.p25_composite}  median=${r.median_composite}  p75=${r.p75_composite}  max=${r.max_composite}`);
      console.log(`    mean=${r.mean_composite}  stddev=${r.stddev_composite}`);
    }
    console.log();
  });

data
  .command("threshold")
  .description("Calibrate the consistency similarity threshold")
  .option("--model <model>", "Embed model to analyse", "nomic-embed-text")
  .option("--format <fmt>", "json | table", "table")
  .action(async (opts) => {
    const result = await thresholdCalibration(opts.model);
    if (opts.format === "json") { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`\nThreshold calibration — ${result.embed_model} (n=${result.n})`);
    if (result.n === 0) { console.log(`  ${result.recommendation}\n`); return; }
    const d = result.min_sim_distribution;
    console.log(`\n  min_similarity distribution:`);
    console.log(`    p10=${d.p10}  p25=${d.p25}  p50=${d.p50}  p75=${d.p75}  p90=${d.p90}  p95=${d.p95}`);
    console.log(`\n  threshold   stable   unstable`);
    for (const c of result.candidates) {
      const marker = c.threshold === 0.92 ? " ← current default" : "";
      console.log(`  ${String(c.threshold).padEnd(10)}${`${Math.round(c.pct_stable * 100)}%`.padStart(6)}  ${`${Math.round(c.pct_unstable * 100)}%`.padStart(8)}${marker}`);
    }
    console.log(`\n  Recommendation: ${result.recommendation}\n`);
  });

data
  .command("installs")
  .description("Score vs install count correlation")
  .option("--format <fmt>", "json | table", "table")
  .action(async (opts) => {
    const result = await installCorrelation();
    if (opts.format === "json") { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`\nInstall correlation`);
    console.log(`  Skills with install data: ${result.n_with_installs}`);
    console.log(`  Skills without:           ${result.n_without_installs}`);
    if (result.pearson_r !== null) console.log(`  Pearson r:                ${result.pearson_r}`);
    console.log(`  ${result.interpretation}`);
    if (result.rows.length > 0) {
      console.log("\n  skill                     composite  installs");
      for (const r of result.rows.slice(0, 20)) {
        console.log(`  ${r.skill_name.padEnd(26)} ${String(r.latest_composite).padEnd(9)}  ${r.latest_install_count ?? "—"}`);
      }
      if (result.rows.length > 20) console.log(`  ... and ${result.rows.length - 20} more (use --format json)`);
    }
    console.log();
  });

data
  .command("drift [skill]")
  .description("Score drift over time. Omit skill name to list all.")
  .option("--format <fmt>", "json | table", "table")
  .action(async (skill: string | undefined, opts) => {
    if (skill) {
      const result = await scoreDrift(skill);
      if (!result) { console.log(`\nNo data found for skill '${skill}'.\n`); return; }
      if (opts.format === "json") { console.log(JSON.stringify(result, null, 2)); return; }
      console.log(`\nDrift: ${result.skill_name}  (${result.n_runs} runs)`);
      console.log(`  First seen:  ${result.first_seen}`);
      console.log(`  Last seen:   ${result.last_seen}`);
      const sign = result.composite_delta >= 0 ? "+" : "";
      console.log(`  Composite:   min=${result.min_composite}  max=${result.max_composite}  delta=${sign}${result.composite_delta}`);
      if (result.versions_seen.length > 0) console.log(`  Versions:    ${result.versions_seen.join(", ")}`);
      if (result.version_deltas.length > 0) {
        console.log("\n  Version-to-version deltas:");
        for (const d of result.version_deltas) {
          const s = d.composite_delta >= 0 ? "+" : "";
          console.log(`    ${d.from_version} → ${d.to_version}:  ${s}${d.composite_delta}`);
        }
      }
      console.log("\n  Timeline:");
      for (const p of result.timeline) {
        const ver = p.skill_version ? ` [${p.skill_version}]` : "";
        console.log(`    ${p.benchmarked_at.slice(0, 10)}${ver}  composite=${p.composite}  consistency=${p.score_consistency}  robustness=${p.score_robustness}`);
      }
      console.log();
    } else {
      const rows = await allDrift() as Array<{ skill_name: string; n_runs: number; composite_delta: number; min: number; max: number }>;
      if (rows.length === 0) { console.log("\nNo skills with multiple runs yet.\n"); return; }
      if (opts.format === "json") { console.log(JSON.stringify(rows, null, 2)); return; }
      console.log("\nDrift summary (skills with >1 run)\n");
      console.log("  skill                     runs   min    max    delta");
      for (const r of rows) {
        const s = r.composite_delta >= 0 ? "+" : "";
        console.log(`  ${r.skill_name.padEnd(26)} ${String(r.n_runs).padEnd(6)} ${String(r.min).padEnd(6)} ${String(r.max).padEnd(6)} ${s}${r.composite_delta}`);
      }
      console.log();
    }
  });

data
  .command("import-metadata <file>")
  .description("Import full skill metadata from a JSON file (array of SkillMetadata objects)")
  .action(async (file: string) => {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) { console.error(`File not found: ${resolved}`); process.exit(1); }
    let records: unknown[];
    try { records = JSON.parse(fs.readFileSync(resolved, "utf-8")); }
    catch (e) { console.error(`Invalid JSON: ${e}`); process.exit(1); }
    if (!Array.isArray(records)) { console.error("Expected a JSON array of SkillMetadata objects."); process.exit(1); }
    const result = await importSkillMetadata(records as SkillMetadata[]);
    console.log(`\nImported:`);
    console.log(`  Skills upserted:       ${result.upserted}`);
    console.log(`  Install snapshots:     ${result.installSnapshots}`);
    console.log(`  Version history rows:  ${result.versions}`);
    console.log(`  Dependency edges:      ${result.deps}\n`);
  });

data
  .command("authors")
  .description("Score breakdown by author verification status")
  .option("--format <fmt>", "json | table", "table")
  .action(async (opts) => {
    const r = await scoreByAuthorVerification();
    if (opts.format === "json") { console.log(JSON.stringify(r, null, 2)); return; }
    console.log("\nScore by author verification\n");
    if (r.verified)   console.log(`  Verified    n=${r.verified.n}    mean=${r.verified.mean_composite}    median=${r.verified.median_composite}`);
    if (r.unverified) console.log(`  Unverified  n=${r.unverified.n}  mean=${r.unverified.mean_composite}  median=${r.unverified.median_composite}`);
    if (r.delta !== null) console.log(`  Delta:  ${r.delta >= 0 ? "+" : ""}${r.delta}`);
    console.log(`  ${r.interpretation}\n`);
  });

data
  .command("tags")
  .description("Mean score per tag, ranked")
  .option("--format <fmt>", "json | table", "table")
  .option("--min-n <n>", "Minimum skill count to show a tag", parseInt)
  .action(async (opts) => {
    const minN = opts.minN ?? 1;
    const rows = (await scoreByTag()).filter((r) => r.n >= minN);
    if (opts.format === "json") { console.log(JSON.stringify(rows, null, 2)); return; }
    if (rows.length === 0) { console.log("\nNo tag data yet.\n"); return; }
    console.log("\nScore by tag (ranked by mean composite)\n");
    console.log("  tag                        n    mean   median   min    max");
    for (const r of rows) {
      console.log(`  ${r.tag.padEnd(26)} ${String(r.n).padEnd(4)} ${String(r.mean_composite).padEnd(6)} ${String(r.median_composite).padEnd(8)} ${String(r.min_composite).padEnd(6)} ${r.max_composite}`);
    }
    console.log();
  });

data
  .command("stars")
  .description("Score vs star rating correlation")
  .option("--format <fmt>", "json | table", "table")
  .action(async (opts) => {
    const r = await scoreVsStarRating();
    if (opts.format === "json") { console.log(JSON.stringify(r, null, 2)); return; }
    console.log(`\nScore vs star rating  (n=${r.n})`);
    if (r.pearson_r !== null) console.log(`  Pearson r: ${r.pearson_r}`);
    console.log(`  ${r.interpretation}`);
    if (r.buckets.length > 0) {
      console.log("\n  stars       n    mean");
      for (const b of r.buckets) {
        console.log(`  ${b.star_bucket.padEnd(10)}  ${String(b.n).padEnd(4)} ${b.mean_composite}`);
      }
    }
    console.log();
  });

data
  .command("deps")
  .description("Score vs dependency count correlation")
  .option("--format <fmt>", "json | table", "table")
  .action(async (opts) => {
    const r = await scoreVsDependencyCount();
    if (opts.format === "json") { console.log(JSON.stringify(r, null, 2)); return; }
    console.log(`\nScore vs dependency count  (n=${r.n})`);
    if (r.pearson_r !== null) console.log(`  Pearson r: ${r.pearson_r}`);
    console.log(`  ${r.interpretation}`);
    if (r.buckets.length > 0) {
      console.log("\n  deps   n    mean");
      for (const b of r.buckets) {
        console.log(`  ${String(b.dep_count).padEnd(6)} ${String(b.n).padEnd(4)} ${b.mean_composite}`);
      }
    }
    console.log();
  });

data
  .command("growth")
  .description("Install growth rate vs benchmark score")
  .option("--format <fmt>", "json | table", "table")
  .action(async (opts) => {
    const rows = await installGrowthVsScore();
    if (opts.format === "json") { console.log(JSON.stringify(rows, null, 2)); return; }
    if (rows.length === 0) { console.log("\nNo install history data yet.\n"); return; }
    console.log("\nInstall growth vs score  (skills with ≥2 install snapshots)\n");
    console.log("  skill                     score  first   latest  growth    growth%");
    for (const r of rows) {
      const pct = r.growth_pct !== null ? `${r.growth_pct}%` : "—";
      console.log(`  ${r.skill_name.padEnd(26)} ${String(r.composite).padEnd(6)} ${String(r.first_installs).padEnd(7)} ${String(r.latest_installs).padEnd(7)} ${String(r.growth_absolute).padEnd(9)} ${pct}`);
    }
    console.log();
  });

// ── claw-bench clawhub ────────────────────────────────────────────────────

const clawhub = program
  .command("clawhub")
  .description("Manage ClawHub skill catalog: download, analyze, and browse");

clawhub
  .command("crawl")
  .description(
    "Fetch the full public skill list from ClawHub (Convex API) and write clawhub/skills-seed.json"
  )
  .option(
    "--sort <field>",
    "Registry sort: newest | updated | downloads | installs | stars | name",
    "downloads"
  )
  .option("--dry-run", "Print counts only; do not write the seed file")
  .option(
    "--seed-only",
    "Skip Convex fetch; sync existing clawhub/skills-seed.json into SQLite only"
  )
  .action(async (opts) => {
    if (opts.seedOnly) {
      const { loadSeedList, seedSkillsToDB } = await import("./clawhub.js");
      const seeds = loadSeedList(process.cwd());
      if (seeds.length === 0) {
        console.error(
          "clawhub/skills-seed.json is missing or empty — run `clawhub crawl` without --seed-only first.\n"
        );
        process.exit(1);
      }
      if (opts.dryRun) {
        console.log(
          `\n${seeds.length} skills in clawhub/skills-seed.json (dry-run — no DB write).\n`
        );
        return;
      }
      console.log(`\nSyncing ${seeds.length} skills from seed file into SQLite…\n`);
      const { seeded } = await seedSkillsToDB(process.cwd());
      console.log(`Synced ${seeded} rows into SQLite catalog.\n`);
      return;
    }

    const { fetchFullRegistry } = await import("./clawhub-registry.js");
    const sort = opts.sort as
      | "newest"
      | "updated"
      | "downloads"
      | "installs"
      | "stars"
      | "name";
    const allowed = new Set([
      "newest",
      "updated",
      "downloads",
      "installs",
      "stars",
      "name",
    ]);
    if (!allowed.has(sort)) {
      console.error(`Invalid --sort: ${opts.sort}`);
      process.exit(1);
    }

    console.log(`\nFetching ClawHub registry (sort=${sort}) via Convex…\n`);
    const entries = await fetchFullRegistry({
      sort,
      dir: sort === "name" ? "asc" : "desc",
      onPage: (page, total) => {
        console.log(`  Page ${page}: ${total} skills so far…`);
      },
    });

    console.log(`\nTotal skills: ${entries.length}\n`);

    if (opts.dryRun) {
      return;
    }

    const outPath = path.join(process.cwd(), "clawhub", "skills-seed.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(entries, null, 2) + "\n", "utf-8");
    console.log(`Wrote ${outPath}`);

    const { seedSkillsToDB } = await import("./clawhub.js");
    const { seeded } = await seedSkillsToDB(process.cwd());
    console.log(`Synced ${seeded} rows into SQLite catalog.\n`);
  });

clawhub
  .command("list")
  .description("Show all known skills from the seed file and database")
  .option("--format <fmt>", "json | table", "table")
  .action(async (opts) => {
    const { loadSeedList } = await import("./clawhub.js");
    const { getClawHubSkills } = await import("./store.js");
    const seeds = loadSeedList(process.cwd());
    const dbSkills = await getClawHubSkills();

    if (opts.format === "json") {
      console.log(JSON.stringify({ seeds, dbSkills }, null, 2));
      return;
    }

    console.log(`\nClawHub Skills (${seeds.length} in seed, ${dbSkills.length} in DB)\n`);
    console.log("  slug                          author           version    downloads  stars");
    for (const s of seeds) {
      const analyzed = dbSkills.find((d) => d.slug === s.slug);
      const marker = analyzed ? " [analyzed]" : "";
      console.log(
        `  ${s.slug.padEnd(30)} ${s.author.padEnd(16)} ${s.version.padEnd(10)} ${s.downloads.padEnd(10)} ${s.stars}${marker}`
      );
    }
    console.log();
  });

clawhub
  .command("download [slug]")
  .description("Download skill zip(s) from ClawHub")
  .option("--all", "Download all skills from seed list")
  .action(async (slug: string | undefined, opts) => {
    const { loadSeedList, downloadSkill, downloadAll, seedSkillsToDB } = await import("./clawhub.js");
    const clawhubDir = path.join(process.cwd(), "clawhub");

    if (opts.all || !slug) {
      const seeds = loadSeedList(process.cwd());
      const slugs = seeds.map((s) => s.slug);
      console.log(`\nDownloading ${slugs.length} skills...\n`);
      const result = await downloadAll(slugs, clawhubDir, (s, idx, total, ok, skipped) => {
        const status = !ok ? "FAIL" : skipped ? "SKIP" : "OK";
        console.log(`  [${idx}/${total}] ${s} — ${status}`);
      });
      const fresh = result.succeeded.length - result.skipped;
      console.log(
        `\nDone: ${result.succeeded.length} ok (${result.skipped} skipped, ${fresh} downloaded), ${result.failed.length} failed`
      );
      if (result.failed.length > 0) {
        console.log(`  Failed: ${result.failed.join(", ")}`);
      }
      await seedSkillsToDB(process.cwd());
      console.log();
    } else {
      console.log(`\nDownloading: ${slug}`);
      const result = await downloadSkill(slug, clawhubDir);
      if (result.skipped) {
        console.log(`  Already present: ${result.zipPath}`);
        await seedSkillsToDB(process.cwd());
      } else if (result.downloaded) {
        console.log(`  Saved to: ${result.zipPath}`);
        await seedSkillsToDB(process.cwd());
      } else {
        console.log(`  Download failed.`);
      }
      console.log();
    }
  });

clawhub
  .command("analyze [slug]")
  .description("Analyze skill(s) — static analysis + optional LLM evaluation")
  .option("--all", "Analyze all downloaded skills")
  .option(
    "--cleanup",
    "After each successful analysis, delete that skill's zip and extracted folder (saves disk; re-download to re-analyze)"
  )
  .option(
    "--llm",
    "Include LLM evaluation (set CLAWHUB_LLM_PROVIDER + API keys — see README)"
  )
  .option(
    "--no-seed",
    "Skip syncing the full seed list into SQLite before analyzing (faster after crawl/download; dashboard zip paths may be stale until next seed)"
  )
  .action(async (slug: string | undefined, opts) => {
    const { loadSeedList, extractSkill, findExistingZip, seedSkillsToDB } = await import("./clawhub.js");
    const { analyzeSkill } = await import("./clawhub-analyzer.js");
    const { storeClawHubAnalysis, upsertClawHubSkill } = await import("./store.js");

    const clawhubDir = path.join(process.cwd(), "clawhub");
    const skillsDir = path.join(process.cwd(), "clawhub-skills");
    const seeds = loadSeedList(process.cwd());
    if (!opts.noSeed) {
      await seedSkillsToDB(process.cwd());
    } else {
      console.log("\nSkipping catalog seed (--no-seed). Ensure you ran crawl/download recently.\n");
    }

    const toAnalyze = (opts.all || !slug)
      ? seeds
      : seeds.filter((s) => s.slug === slug);

    if (toAnalyze.length === 0 && slug) {
      console.error(`\nSkill "${slug}" not found in seed list.\n`);
      process.exit(1);
    }

    console.log(
      `\nAnalyzing ${toAnalyze.length} skill(s)${opts.llm ? " (with LLM)" : ""}${opts.cleanup ? " (cleanup after each)" : ""}...\n`
    );

    let analyzed = 0;
    for (const entry of toAnalyze) {
      const zipPath = findExistingZip(entry.slug, clawhubDir);
      if (!zipPath) {
        console.log(`  ${entry.slug} — no zip found, skipping`);
        continue;
      }

      let extractedDir: string;
      const existing = path.join(skillsDir, entry.slug);
      if (fs.existsSync(existing) && fs.existsSync(path.join(existing, "SKILL.md"))) {
        extractedDir = existing;
      } else {
        console.log(`  ${entry.slug} — extracting...`);
        extractedDir = await extractSkill(zipPath, skillsDir);
      }

      console.log(`  ${entry.slug} — analyzing...`);
      const result = await analyzeSkill(extractedDir, entry.slug, entry, { llm: !!opts.llm });

      await upsertClawHubSkill(entry, {
        zipPath,
        extractedPath: extractedDir,
        hasScripts: result.fileStats.hasScripts,
        fileCount: result.fileStats.fileCount,
        totalSizeBytes: result.fileStats.totalSizeBytes,
        skillMdLength: result.fileStats.skillMdLength,
      });
      await storeClawHubAnalysis(result);
      analyzed++;

      const s = result.staticAnalysis;
      const pct = (v: number) => `${Math.round(v * 100)}%`;
      console.log(
        `    static: doc=${pct(s.docQuality)} complete=${pct(s.completeness)} security=${pct(s.security)} ` +
        `code=${s.codeQuality !== null ? pct(s.codeQuality) : "n/a"} maintain=${pct(s.maintainability)} → ${pct(s.staticComposite)}`
      );
      if (result.llmEval) {
        const l = result.llmEval;
        console.log(
          `    llm:    clarity=${pct(l.clarity)} useful=${pct(l.usefulness)} safety=${pct(l.safety)} ` +
          `complete=${pct(l.completeness)} → ${pct(l.llmComposite)}`
        );
      }
      console.log(`    overall: ${pct(result.overallComposite)}`);

      if (opts.cleanup) {
        try {
          if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
          if (fs.existsSync(extractedDir)) {
            fs.rmSync(extractedDir, { recursive: true, force: true });
          }
          await upsertClawHubSkill(entry, {
            zipPath: "",
            extractedPath: "",
            hasScripts: result.fileStats.hasScripts,
            fileCount: result.fileStats.fileCount,
            totalSizeBytes: result.fileStats.totalSizeBytes,
            skillMdLength: result.fileStats.skillMdLength,
          });
          console.log(`    cleaned up zip + extracted files`);
        } catch (err) {
          console.warn(
            `    cleanup failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    console.log(`\nAnalyzed ${analyzed} skill(s).\n`);
  });

clawhub
  .command("status")
  .description("Summary of downloaded and analyzed skills")
  .action(async () => {
    const { loadSeedList, findExistingZip } = await import("./clawhub.js");
    const { getClawHubCatalogStats } = await import("./store.js");

    const seeds = loadSeedList(process.cwd());
    const clawhubDir = path.join(process.cwd(), "clawhub");
    let downloaded = 0;
    for (const s of seeds) {
      if (findExistingZip(s.slug, clawhubDir)) downloaded++;
    }

    const stats = await getClawHubCatalogStats();
    console.log(`\nClawHub Catalog Status`);
    console.log(`  Skills in seed:    ${seeds.length}`);
    console.log(`  Zips downloaded:   ${downloaded}`);
    console.log(`  Skills in DB:      ${stats.totalSkills}`);
    console.log(`  Analyzed:          ${stats.analyzedCount}`);
    if (stats.analyzedCount > 0) {
      console.log(`  Avg static score:  ${Math.round(stats.avgStaticComposite * 100)}%`);
      console.log(`  Avg overall score: ${Math.round(stats.avgOverallComposite * 100)}%`);
    }
    console.log(`  With scripts:      ${stats.withScripts}`);
    console.log();
  });

// ── claw-bench dashboard ──────────────────────────────────────────────────

program
  .command("dashboard")
  .description("Launch the interactive benchmark dashboard")
  .option("--port <port>", "Port to serve on", "3077")
  .action(async (opts) => {
    const { startDashboard } = await import("./server.js");
    startDashboard({ port: parseInt(opts.port) });
  });

program.parse(process.argv);
