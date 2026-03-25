/**
 * clawhub.ts — Scrape, download, and extract ClawHub skills.
 *
 * Skills are fetched as zip archives from the Convex download API
 * and extracted locally for analysis.
 */

import * as fs from "fs";
import * as path from "path";
import { ClawHubSkillEntry } from "./types.js";
import { upsertClawHubSkill } from "./store.js";

const DOWNLOAD_BASE = "https://wry-manatee-359.convex.site/api/v1/download";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const CONCURRENCY = 3;

// ── Seed list ──────────────────────────────────────────────────────────────

export function loadSeedList(projectRoot: string): ClawHubSkillEntry[] {
  const seedPath = path.join(projectRoot, "clawhub", "skills-seed.json");
  if (!fs.existsSync(seedPath)) {
    throw new Error(`Seed file not found: ${seedPath}`);
  }
  return JSON.parse(fs.readFileSync(seedPath, "utf-8"));
}

// ── Download ───────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function downloadSkill(
  slug: string,
  destDir: string
): Promise<{ zipPath: string; downloaded: boolean }> {
  const url = `${DOWNLOAD_BASE}?slug=${encodeURIComponent(slug)}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (attempt < MAX_RETRIES) {
          console.log(`  Retry ${attempt}/${MAX_RETRIES} for ${slug} (HTTP ${res.status})`);
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        console.warn(`  Failed to download ${slug}: HTTP ${res.status}`);
        return { zipPath: "", downloaded: false };
      }

      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      const zipPath = path.join(destDir, `${slug}.zip`);
      fs.writeFileSync(zipPath, buffer);
      return { zipPath, downloaded: true };
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        console.log(`  Retry ${attempt}/${MAX_RETRIES} for ${slug}: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      console.warn(`  Failed to download ${slug}: ${err instanceof Error ? err.message : String(err)}`);
      return { zipPath: "", downloaded: false };
    }
  }

  return { zipPath: "", downloaded: false };
}

// ── Extract ────────────────────────────────────────────────────────────────

export async function extractSkill(
  zipPath: string,
  destDir: string
): Promise<string> {
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip(zipPath);
  const slug = path.basename(zipPath, ".zip");
  const extractDir = path.join(destDir, slug);

  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true });
  }

  zip.extractAllTo(extractDir, true);
  return extractDir;
}

// ── File stats ─────────────────────────────────────────────────────────────

const SCRIPT_EXTENSIONS = new Set([".sh", ".py", ".js", ".ts", ".rb", ".pl"]);

export function collectFileStats(dir: string): {
  fileCount: number;
  totalSizeBytes: number;
  hasScripts: boolean;
  skillMdLength: number;
  languages: string[];
} {
  let fileCount = 0;
  let totalSizeBytes = 0;
  let hasScripts = false;
  let skillMdLength = 0;
  const langSet = new Set<string>();

  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        fileCount++;
        const stat = fs.statSync(full);
        totalSizeBytes += stat.size;
        const ext = path.extname(entry.name).toLowerCase();
        if (SCRIPT_EXTENSIONS.has(ext)) {
          hasScripts = true;
          const langMap: Record<string, string> = {
            ".sh": "shell", ".py": "python", ".js": "javascript",
            ".ts": "typescript", ".rb": "ruby", ".pl": "perl",
          };
          if (langMap[ext]) langSet.add(langMap[ext]);
        }
        if (entry.name === "SKILL.md") {
          skillMdLength = stat.size;
        }
        if (ext === ".md") langSet.add("markdown");
        if (ext === ".json") langSet.add("json");
      }
    }
  };

  walk(dir);
  return { fileCount, totalSizeBytes, hasScripts, skillMdLength, languages: [...langSet] };
}

// ── Find existing zips ─────────────────────────────────────────────────────

export function findExistingZip(
  slug: string,
  clawhubDir: string
): string | null {
  if (!fs.existsSync(clawhubDir)) return null;
  for (const file of fs.readdirSync(clawhubDir)) {
    if (file.endsWith(".zip") && file.startsWith(slug)) {
      return path.join(clawhubDir, file);
    }
  }
  return null;
}

// ── Batch download ─────────────────────────────────────────────────────────

export async function downloadAll(
  slugs: string[],
  destDir: string,
  onProgress?: (slug: string, idx: number, total: number, ok: boolean) => void
): Promise<{ succeeded: string[]; failed: string[] }> {
  const succeeded: string[] = [];
  const failed: string[] = [];

  const queue = [...slugs];
  let idx = 0;

  const worker = async () => {
    while (queue.length > 0) {
      const slug = queue.shift()!;
      const currentIdx = ++idx;

      const existing = findExistingZip(slug, destDir);
      if (existing) {
        onProgress?.(slug, currentIdx, slugs.length, true);
        succeeded.push(slug);
        continue;
      }

      const { downloaded } = await downloadSkill(slug, destDir);
      if (downloaded) {
        succeeded.push(slug);
      } else {
        failed.push(slug);
      }
      onProgress?.(slug, currentIdx, slugs.length, downloaded);
    }
  };

  const workers = Array.from({ length: Math.min(CONCURRENCY, slugs.length) }, () => worker());
  await Promise.all(workers);

  return { succeeded, failed };
}

// ── Seed into DB ───────────────────────────────────────────────────────────

export async function seedSkillsToDB(
  projectRoot: string,
  options?: { quiet?: boolean }
): Promise<{ seeded: number }> {
  const skills = loadSeedList(projectRoot);
  const total = skills.length;
  let seeded = 0;
  const quiet = options?.quiet ?? false;
  const isTTY = process.stdout.isTTY;
  const showProgress = !quiet && total > 0;

  for (const skill of skills) {
    const clawhubDir = path.join(projectRoot, "clawhub");
    const zipPath = findExistingZip(skill.slug, clawhubDir);

    await upsertClawHubSkill(skill, { zipPath: zipPath ?? undefined });
    seeded++;

    if (!showProgress) continue;
    const pct = ((seeded / total) * 100).toFixed(1);
    if (isTTY) {
      process.stdout.write(`\r  Seeding ${seeded}/${total} (${pct}%)…`);
    } else if (seeded % 500 === 0 || seeded === total) {
      console.log(`  Seeding ${seeded}/${total} (${pct}%)…`);
    }
  }

  if (showProgress && isTTY) {
    process.stdout.write("\n");
  }

  return { seeded };
}
