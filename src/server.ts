import express, { type Request, type Response } from "express";
import * as path from "path";
import * as fs from "fs";
import {
  query, storeRun, metadataCount, dbPath,
  getClawHubSkillsPaged, getClawHubSkillDetail, getClawHubCatalogStats,
} from "./store.js";
import { runsVisibilitySql, hideExampleRunsFromDashboard, isTestRunRow } from "./dashboardFilters.js";
import {
  scoreDistributions,
  scoreDrift,
  allDrift,
} from "./analyze.js";
import { BenchmarkReport } from "./types.js";

function listFilesRecursive(dir: string, baseDir: string): string[] {
  const results: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        results.push(path.relative(baseDir, full));
      }
    }
  };
  walk(dir);
  return results.sort();
}

export interface DashboardOptions {
  port: number;
}

export function startDashboard(opts: DashboardOptions): void {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // ── Stats ──────────────────────────────────────────────────────────────

  app.get("/api/stats", async (_req: Request, res: Response) => {
    try {
      const vis = runsVisibilitySql();
      const [runsRow, skills] = await Promise.all([
        query<{ n: number }>(`SELECT COUNT(*) as n FROM runs WHERE 1=1 ${vis}`),
        metadataCount(),
      ]);
      const runs = runsRow[0]?.n ?? 0;
      const skillCount = await query<{ n: number }>(
        `SELECT COUNT(DISTINCT skill_name) as n FROM runs WHERE skipped = 0 ${vis}`
      );
      const dateRange = await query<{ first_run: string; last_run: string }>(
        `SELECT MIN(benchmarked_at) as first_run, MAX(benchmarked_at) as last_run
         FROM runs WHERE skipped = 0 ${vis}`
      );
      const avgComposite = await query<{ avg: number }>(
        `SELECT AVG(composite) as avg FROM runs WHERE skipped = 0 ${vis}`
      );
      const clawhubCats = await query<{ n: number }>(
        `SELECT COUNT(*) as n FROM clawhub_skills`
      );
      res.json({
        totalRuns: runs,
        totalSkills: skillCount[0]?.n ?? 0,
        totalMetadata: skills,
        avgComposite: avgComposite[0]?.avg ?? 0,
        firstRunAt: dateRange[0]?.first_run ?? null,
        lastRunAt: dateRange[0]?.last_run ?? null,
        dbPath: dbPath(),
        clawhubCatalogSkills: clawhubCats[0]?.n ?? 0,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Runs ───────────────────────────────────────────────────────────────

  app.get("/api/runs", async (_req: Request, res: Response) => {
    try {
      const vis = runsVisibilitySql();
      const runs = await query(
        `SELECT * FROM runs WHERE 1=1 ${vis} ORDER BY benchmarked_at DESC`
      );
      res.json({ runs, total: runs.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/runs/:id", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const rows = await query(
        `SELECT * FROM runs WHERE id = ?`,
        [parseInt(id)]
      );
      if (rows.length === 0) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      if (hideExampleRunsFromDashboard() && isTestRunRow(rows[0] as { skill_name: string; skill_path: string })) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Skills ─────────────────────────────────────────────────────────────

  app.get("/api/skills", async (_req: Request, res: Response) => {
    try {
      const visR = runsVisibilitySql("r");
      const visR2 = runsVisibilitySql("r2");
      const skills = await query(
        `SELECT
           skill_name,
           skill_type,
           COUNT(*) as run_count,
           MAX(benchmarked_at) as last_benchmarked_at,
           MAX(composite) as best_composite,
           MIN(composite) as worst_composite,
           (SELECT r2.composite FROM runs r2
            WHERE r2.skill_name = r.skill_name AND r2.skipped = 0 ${visR2}
            ORDER BY r2.benchmarked_at DESC LIMIT 1) as latest_composite,
           (SELECT r2.score_type FROM runs r2
            WHERE r2.skill_name = r.skill_name AND r2.skipped = 0 ${visR2}
            ORDER BY r2.benchmarked_at DESC LIMIT 1) as latest_score_type
         FROM runs r
         WHERE skipped = 0 ${visR}
         GROUP BY skill_name
         ORDER BY latest_composite DESC`
      );
      res.json(skills);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Skill drift ────────────────────────────────────────────────────────

  app.get("/api/skills/:name/drift", async (req: Request, res: Response) => {
    try {
      const drift = await scoreDrift(String(req.params.name));
      if (!drift) {
        res.status(404).json({ error: "No data for this skill" });
        return;
      }
      res.json(drift);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── All drift ──────────────────────────────────────────────────────────

  app.get("/api/drift", async (_req: Request, res: Response) => {
    try {
      const drift = await allDrift();
      res.json(drift);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Distributions ──────────────────────────────────────────────────────

  app.get("/api/distributions", async (_req: Request, res: Response) => {
    try {
      const dist = await scoreDistributions();
      res.json(dist);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Compare ────────────────────────────────────────────────────────────

  app.get("/api/compare", async (req: Request, res: Response) => {
    try {
      const skillsParam = (req.query.skills as string) ?? "";
      const names = skillsParam.split(",").map((s) => s.trim()).filter(Boolean);
      if (names.length < 2) {
        res.status(400).json({ error: "Provide at least 2 skill names via ?skills=a,b" });
        return;
      }
      const placeholders = names.map(() => "?").join(",");
      const vis = runsVisibilitySql();
      const visR2 = runsVisibilitySql("r2");
      const runs = await query(
        `SELECT * FROM runs
         WHERE skipped = 0 AND skill_name IN (${placeholders})
           AND benchmarked_at = (
             SELECT MAX(benchmarked_at) FROM runs r2
             WHERE r2.skill_name = runs.skill_name AND r2.skipped = 0 ${visR2}
           ) ${vis}
         ORDER BY composite DESC`,
        names
      );
      res.json(runs);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Import ─────────────────────────────────────────────────────────────

  app.post("/api/import", async (req: Request, res: Response) => {
    try {
      const report = req.body as BenchmarkReport;
      if (!report.skillName || !report.score || !report.dimensions) {
        res.status(400).json({ error: "Invalid benchmark report" });
        return;
      }
      const id = await storeRun(report);
      res.json({ success: true, id });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Catalog: list all ClawHub skills ──────────────────────────────────

  app.get("/api/catalog", async (req: Request, res: Response) => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
      const limit = Math.min(
        200,
        Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50)
      );
      const sortRaw = String(req.query.sort ?? "overall");
      const sort =
        sortRaw === "name" ||
        sortRaw === "downloads" ||
        sortRaw === "stars"
          ? sortRaw
          : "overall";
      const q = String(req.query.q ?? "").trim();
      const analyzedOnly =
        req.query.analyzed === "1" || req.query.analyzed === "true";
      const withScripts =
        req.query.scripts === "1" || req.query.scripts === "true";

      const { rows, total } = await getClawHubSkillsPaged({
        page,
        limit,
        sort: sort as "overall" | "name" | "downloads" | "stars",
        q: q || undefined,
        analyzedOnly,
        withScripts,
      });
      const totalPages = Math.max(1, Math.ceil(total / limit));
      res.json({
        skills: rows,
        total,
        page,
        limit,
        totalPages,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Catalog: stats ──────────────────────────────────────────────────────

  app.get("/api/catalog/stats", async (_req: Request, res: Response) => {
    try {
      const stats = await getClawHubCatalogStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Catalog: single skill detail ────────────────────────────────────────

  app.get("/api/catalog/:slug", async (req: Request, res: Response) => {
    try {
      const slug = String(req.params.slug);
      const skill = await getClawHubSkillDetail(slug);
      if (!skill) {
        res.status(404).json({ error: "Skill not found in catalog" });
        return;
      }

      // Read SKILL.md content and file list if extracted
      let skillMdContent: string | null = null;
      let files: string[] = [];
      const extractedPath = skill.extracted_path as string | null;
      if (extractedPath && fs.existsSync(extractedPath)) {
        const skillMdPath = path.join(extractedPath, "SKILL.md");
        if (fs.existsSync(skillMdPath)) {
          skillMdContent = fs.readFileSync(skillMdPath, "utf-8");
        }
        files = listFilesRecursive(extractedPath, extractedPath);
      }

      res.json({ ...skill, skill_md_content: skillMdContent, files });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Serve dashboard static files ───────────────────────────────────────

  const clientDir = path.resolve(__dirname, "..", "dashboard", "dist");
  if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(clientDir, "index.html"));
    });
  } else {
    app.get("/", (_req: Request, res: Response) => {
      res.send(
        "<h2>Dashboard not built</h2>" +
        "<p>Run <code>npm run dashboard:build</code> then restart.</p>" +
        "<p>Or use <code>npm run dashboard:dev</code> for development (port 5173).</p>"
      );
    });
  }

  // Bind all interfaces so Docker / published ports work (not only 127.0.0.1).
  const bind =
    process.env.CLAW_BENCH_BIND?.trim() || "0.0.0.0";
  app.listen(opts.port, bind, () => {
    console.log(
      `\n  claw-bench dashboard at http://localhost:${opts.port} (listening on ${bind}:${opts.port})\n`
    );
  });
}
