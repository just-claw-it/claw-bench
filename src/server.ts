import express, { type Application, type Request, type Response } from "express";
import * as path from "path";
import * as fs from "fs";
import {
  query,
  storeRun,
  dbPath,
  withSerializedDb,
  dbQueryAll,
  getClawHubSkillsPaged,
  getClawHubSkillDetail,
  getClawHubCatalogStats,
  getClawHubCatalogStatsOnDb,
  getClawHubCatalogPeekTopOnDb,
  getClawHubSkillsPagedOnDb,
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

/** Overview skills table: full leaderboard stays on /api/skills. */
const OVERVIEW_SKILLS_LIMIT = 100;

/** Express app with all dashboard API routes (used by `startDashboard` and tests). */
export function createDashboardApp(): Application {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // ── Stats ──────────────────────────────────────────────────────────────

  app.get("/api/stats", async (_req: Request, res: Response) => {
    try {
      const vis = runsVisibilitySql();
      const rows = await query<{
        totalRuns: number;
        totalSkills: number;
        totalMetadata: number;
        avgComposite: number | null;
        firstRunAt: string | null;
        lastRunAt: string | null;
        clawhubCatalogSkills: number;
      }>(
        `SELECT
          (SELECT COUNT(*) FROM runs WHERE 1=1 ${vis}) AS totalRuns,
          (SELECT COUNT(DISTINCT skill_name) FROM runs WHERE skipped = 0 ${vis}) AS totalSkills,
          (SELECT COUNT(*) FROM skill_metadata) AS totalMetadata,
          (SELECT AVG(composite) FROM runs WHERE skipped = 0 ${vis}) AS avgComposite,
          (SELECT MIN(benchmarked_at) FROM runs WHERE skipped = 0 ${vis}) AS firstRunAt,
          (SELECT MAX(benchmarked_at) FROM runs WHERE skipped = 0 ${vis}) AS lastRunAt,
          (SELECT COUNT(*) FROM clawhub_skills) AS clawhubCatalogSkills`
      );
      const r = rows[0];
      res.json({
        totalRuns: r?.totalRuns ?? 0,
        totalSkills: r?.totalSkills ?? 0,
        totalMetadata: r?.totalMetadata ?? 0,
        avgComposite: r?.avgComposite ?? 0,
        firstRunAt: r?.firstRunAt ?? null,
        lastRunAt: r?.lastRunAt ?? null,
        dbPath: dbPath(),
        clawhubCatalogSkills: r?.clawhubCatalogSkills ?? 0,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** One DB open for Overview (replaces several parallel /api/* calls that each reloaded SQLite). */
  app.get("/api/dashboard/overview", async (_req: Request, res: Response) => {
    try {
      const vis = runsVisibilitySql();
      const visR = runsVisibilitySql("r");
      const visR2 = runsVisibilitySql("r2");
      const payload = await withSerializedDb((db) => {
        if (!db) {
          const emptyHist = [
            { bucket: "0-20%", count: 0 },
            { bucket: "20-40%", count: 0 },
            { bucket: "40-60%", count: 0 },
            { bucket: "60-80%", count: 0 },
            { bucket: "80-100%", count: 0 },
          ];
          return {
            stats: {
              totalRuns: 0,
              totalSkills: 0,
              totalMetadata: 0,
              avgComposite: 0,
              firstRunAt: null as string | null,
              lastRunAt: null as string | null,
              dbPath: dbPath(),
              clawhubCatalogSkills: 0,
            },
            runs: { recent: [] as Record<string, unknown>[], total: 0 },
            scoreHistogram: emptyHist,
            skills: [] as Record<string, unknown>[],
            catalogStats: {
              totalSkills: 0,
              analyzedCount: 0,
              avgOverallComposite: 0,
              avgStaticComposite: 0,
              withScripts: 0,
              dbPath: dbPath(),
            },
            catalogPeek: {
              skills: [] as Record<string, unknown>[],
              total: 0,
              page: 1,
              limit: 5,
              totalPages: 1,
            },
          };
        }

        const statsRow = dbQueryAll<{
          totalRuns: number;
          totalSkills: number;
          totalMetadata: number;
          avgComposite: number | null;
          firstRunAt: string | null;
          lastRunAt: string | null;
          clawhubCatalogSkills: number;
        }>(
          db,
          `SELECT
            (SELECT COUNT(*) FROM runs WHERE 1=1 ${vis}) AS totalRuns,
            (SELECT COUNT(DISTINCT skill_name) FROM runs WHERE skipped = 0 ${vis}) AS totalSkills,
            (SELECT COUNT(*) FROM skill_metadata) AS totalMetadata,
            (SELECT AVG(composite) FROM runs WHERE skipped = 0 ${vis}) AS avgComposite,
            (SELECT MIN(benchmarked_at) FROM runs WHERE skipped = 0 ${vis}) AS firstRunAt,
            (SELECT MAX(benchmarked_at) FROM runs WHERE skipped = 0 ${vis}) AS lastRunAt,
            (SELECT COUNT(*) FROM clawhub_skills) AS clawhubCatalogSkills`
        )[0];

        const totalRunCount =
          dbQueryAll<{ n: number }>(
            db,
            `SELECT COUNT(*) as n FROM runs WHERE 1=1 ${vis}`
          )[0]?.n ?? 0;

        const recent = dbQueryAll(
          db,
          `SELECT * FROM runs WHERE 1=1 ${vis} ORDER BY benchmarked_at DESC LIMIT 10`
        );

        const histRow = dbQueryAll<{
          b0: number | null;
          b1: number | null;
          b2: number | null;
          b3: number | null;
          b4: number | null;
        }>(
          db,
          `SELECT
            SUM(CASE WHEN composite IS NOT NULL AND composite >= 0 AND composite < 0.2 THEN 1 ELSE 0 END) AS b0,
            SUM(CASE WHEN composite >= 0.2 AND composite < 0.4 THEN 1 ELSE 0 END) AS b1,
            SUM(CASE WHEN composite >= 0.4 AND composite < 0.6 THEN 1 ELSE 0 END) AS b2,
            SUM(CASE WHEN composite >= 0.6 AND composite < 0.8 THEN 1 ELSE 0 END) AS b3,
            SUM(CASE WHEN composite >= 0.8 AND composite <= 1.000001 THEN 1 ELSE 0 END) AS b4
           FROM runs WHERE skipped = 0 ${vis}`
        )[0];
        const scoreHistogram = [
          { bucket: "0-20%", count: Math.round(histRow?.b0 ?? 0) },
          { bucket: "20-40%", count: Math.round(histRow?.b1 ?? 0) },
          { bucket: "40-60%", count: Math.round(histRow?.b2 ?? 0) },
          { bucket: "60-80%", count: Math.round(histRow?.b3 ?? 0) },
          { bucket: "80-100%", count: Math.round(histRow?.b4 ?? 0) },
        ];

        const skills = dbQueryAll(
          db,
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
           ORDER BY latest_composite DESC
           LIMIT ${OVERVIEW_SKILLS_LIMIT}`
        );

        const catBase = getClawHubCatalogStatsOnDb(db);
        const peek = getClawHubCatalogPeekTopOnDb(db, 5);
        const catTotal = catBase.totalSkills;
        const totalPages = Math.max(1, Math.ceil(catTotal / 5));

        return {
          stats: {
            totalRuns: statsRow?.totalRuns ?? 0,
            totalSkills: statsRow?.totalSkills ?? 0,
            totalMetadata: statsRow?.totalMetadata ?? 0,
            avgComposite: statsRow?.avgComposite ?? 0,
            firstRunAt: statsRow?.firstRunAt ?? null,
            lastRunAt: statsRow?.lastRunAt ?? null,
            dbPath: dbPath(),
            clawhubCatalogSkills: statsRow?.clawhubCatalogSkills ?? 0,
          },
          runs: { recent, total: statsRow?.totalRuns ?? 0 },
          scoreHistogram,
          skills,
          catalogStats: { ...catBase, dbPath: dbPath() },
          catalogPeek: {
            skills: peek.rows,
            total: catTotal,
            page: 1,
            limit: 5,
            totalPages,
          },
        };
      });
      res.json(payload);
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
      const includeStats =
        req.query.stats === "1" || req.query.stats === "true";

      if (includeStats) {
        const body = await withSerializedDb((db) => {
          if (!db) {
            const totalPages = 1;
            return {
              skills: [] as Record<string, unknown>[],
              total: 0,
              page,
              limit,
              totalPages,
              stats: {
                totalSkills: 0,
                analyzedCount: 0,
                avgOverallComposite: 0,
                avgStaticComposite: 0,
                withScripts: 0,
                dbPath: dbPath(),
              },
            };
          }
          const { rows, total } = getClawHubSkillsPagedOnDb(db, {
            page,
            limit,
            sort: sort as "overall" | "name" | "downloads" | "stars",
            q: q || undefined,
            analyzedOnly,
            withScripts,
          });
          const totalPages = Math.max(1, Math.ceil(total / limit));
          const catBase = getClawHubCatalogStatsOnDb(db);
          return {
            skills: rows,
            total,
            page,
            limit,
            totalPages,
            stats: { ...catBase, dbPath: dbPath() },
          };
        });
        res.json(body);
        return;
      }

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

  return app;
}

export function startDashboard(opts: DashboardOptions): void {
  const app = createDashboardApp();
  // Bind all interfaces so Docker / published ports work (not only 127.0.0.1).
  const bind =
    process.env.CLAW_BENCH_BIND?.trim() || "0.0.0.0";
  app.listen(opts.port, bind, () => {
    console.log(
      `\n  claw-bench dashboard at http://localhost:${opts.port} (listening on ${bind}:${opts.port})\n`
    );
  });
}
