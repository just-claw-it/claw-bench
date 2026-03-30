/**
 * clawhub.ts — Scrape, download, and extract ClawHub skills.
 *
 * Skills are fetched as zip archives from the Convex download API
 * and extracted locally for analysis.
 */

import * as fs from "fs";
import * as path from "path";
import { ClawHubSkillEntry } from "./types.js";
import { dbPath, upsertClawHubSkill, upsertClawHubSkillsBatch } from "./store.js";

const DOWNLOAD_BASE = "https://wry-manatee-359.convex.site/api/v1/download";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
/** Parallel downloads; default 1 to avoid HTTP 429 from bulk fetches. Override: CLAWHUB_DOWNLOAD_CONCURRENCY */
const CONCURRENCY = Math.max(
  1,
  parseInt(process.env.CLAWHUB_DOWNLOAD_CONCURRENCY ?? "1", 10) || 1
);
const ZIP_SUBDIR = "zip";

/** Parse Retry-After (delay-seconds or HTTP-date). Returns ms to wait, or null if absent/invalid. */
function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const trimmed = raw.trim();
  const secMatch = /^(\d+)$/.exec(trimmed);
  if (secMatch) {
    return parseInt(secMatch[1], 10) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

async function drainResponseBody(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    // ignore
  }
}

/** Wait duration after a failed HTTP response before retrying. */
function delayMsAfterHttpError(res: Response, status: number, attempt: number): number {
  const fromHeader = parseRetryAfterMs(res);
  if (fromHeader !== null) {
    return Math.min(300_000, Math.max(1_000, fromHeader));
  }
  if (status === 429 || status === 503) {
    return Math.min(120_000, 5_000 * 2 ** (attempt - 1));
  }
  return RETRY_DELAY_MS * attempt;
}

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

function getZipDir(clawhubDir: string): string {
  return path.join(clawhubDir, ZIP_SUBDIR);
}

function ensureZipDir(clawhubDir: string): string {
  const zipDir = getZipDir(clawhubDir);
  if (!fs.existsSync(zipDir)) {
    fs.mkdirSync(zipDir, { recursive: true });
  }
  return zipDir;
}

function isValidZipFile(filePath: string): boolean {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function moveLegacyZipsToSubdir(clawhubDir: string): number {
  if (!fs.existsSync(clawhubDir)) return 0;
  const zipDir = ensureZipDir(clawhubDir);
  let moved = 0;

  for (const file of fs.readdirSync(clawhubDir, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.toLowerCase().endsWith(".zip")) continue;
    const src = path.join(clawhubDir, file.name);
    const dst = path.join(zipDir, file.name);

    try {
      if (!fs.existsSync(dst)) {
        fs.renameSync(src, dst);
        moved++;
        continue;
      }

      const srcValid = isValidZipFile(src);
      const dstValid = isValidZipFile(dst);
      if (srcValid && !dstValid) {
        fs.unlinkSync(dst);
        fs.renameSync(src, dst);
        moved++;
      } else {
        fs.unlinkSync(src);
      }
    } catch {
      // ignore migration errors; download flow can continue
    }
  }

  return moved;
}

export async function downloadSkill(
  slug: string,
  destDir: string
): Promise<{ zipPath: string; downloaded: boolean; skipped?: boolean }> {
  const existing = findExistingZip(slug, destDir);
  if (existing) {
    return { zipPath: existing, downloaded: true, skipped: true };
  }

  const url = `${DOWNLOAD_BASE}?slug=${encodeURIComponent(slug)}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const waitMs = delayMsAfterHttpError(res, res.status, attempt);
        await drainResponseBody(res);
        if (attempt < MAX_RETRIES) {
          const sec = Math.round(waitMs / 1000);
          console.log(
            `  Retry ${attempt}/${MAX_RETRIES} for ${slug} (HTTP ${res.status}, waiting ${sec}s)`
          );
          await sleep(waitMs);
          continue;
        }
        console.warn(`  Failed to download ${slug}: HTTP ${res.status}`);
        return { zipPath: "", downloaded: false };
      }

      const zipDir = ensureZipDir(destDir);

      const buffer = Buffer.from(await res.arrayBuffer());
      const zipPath = path.join(zipDir, `${slug}.zip`);
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
  fs.mkdirSync(extractDir, { recursive: true });

  const rootResolved = path.resolve(extractDir);
  const entries = zip.getEntries();
  const sanitize = (entryName: string): string => {
    // Fix malformed "dir:/file" style paths and normalize separators.
    let s = entryName.replace(/\\/g, "/").replace(/:\/+/g, "/");
    // Remove drive prefix if present in archive entry.
    s = s.replace(/^[A-Za-z]:\//, "");
    // Normalize and strip leading slash segments.
    s = path.posix.normalize(s).replace(/^\/+/, "");
    return s;
  };

  for (const e of entries) {
    const rel = sanitize(e.entryName);
    if (!rel || rel === ".") continue;

    const out = path.resolve(extractDir, rel);
    // Zip-slip guard: never allow escaping extract root.
    if (out !== rootResolved && !out.startsWith(rootResolved + path.sep)) {
      console.warn(`  Skipping suspicious zip entry outside root: ${e.entryName}`);
      continue;
    }

    if (e.isDirectory) {
      fs.mkdirSync(out, { recursive: true });
      continue;
    }

    fs.mkdirSync(path.dirname(out), { recursive: true });
    const data = e.getData();
    fs.writeFileSync(out, data);
  }
  return extractDir;
}

// ── File stats ─────────────────────────────────────────────────────────────

const SCRIPT_EXTENSIONS = new Set([
  ".sh", ".py", ".js", ".ts", ".tsx", ".jsx",
  ".rb", ".pl", ".go", ".java", ".rs", ".php",
  ".cs", ".cpp", ".c", ".swift", ".kt", ".kts",
  ".scala", ".lua", ".r", ".ps1", ".mjs", ".cjs",
]);

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
            ".sh": "shell",
            ".ps1": "powershell",
            ".py": "python",
            ".js": "javascript",
            ".jsx": "javascript",
            ".mjs": "javascript",
            ".cjs": "javascript",
            ".ts": "typescript",
            ".tsx": "typescript",
            ".rb": "ruby",
            ".pl": "perl",
            ".go": "go",
            ".java": "java",
            ".rs": "rust",
            ".php": "php",
            ".cs": "csharp",
            ".cpp": "cpp",
            ".c": "c",
            ".swift": "swift",
            ".kt": "kotlin",
            ".kts": "kotlin",
            ".scala": "scala",
            ".lua": "lua",
            ".r": "r",
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

/** True if a non-empty `${slug}.zip` exists (exact name; case-insensitive fallback on same dir). */
export function findExistingZip(
  slug: string,
  clawhubDir: string
): string | null {
  if (!fs.existsSync(clawhubDir)) return null;
  const zipDir = getZipDir(clawhubDir);

  const exactPath = path.join(zipDir, `${slug}.zip`);
  if (isValidZipFile(exactPath)) {
    return exactPath;
  }

  const target = `${slug}.zip`.toLowerCase();
  if (fs.existsSync(zipDir)) {
    for (const file of fs.readdirSync(zipDir)) {
      if (!file.toLowerCase().endsWith(".zip")) continue;
      if (file.toLowerCase() !== target) continue;
      const full = path.join(zipDir, file);
      if (isValidZipFile(full)) return full;
    }
  }

  for (const file of fs.readdirSync(clawhubDir)) {
    if (!file.toLowerCase().endsWith(".zip")) continue;
    if (file.toLowerCase() !== target) continue;
    const legacy = path.join(clawhubDir, file);
    if (!isValidZipFile(legacy)) continue;
    try {
      const zipOutDir = ensureZipDir(clawhubDir);
      const migratedPath = path.join(zipOutDir, `${slug}.zip`);
      if (!fs.existsSync(migratedPath)) {
        fs.renameSync(legacy, migratedPath);
      } else if (!isValidZipFile(migratedPath)) {
        fs.unlinkSync(migratedPath);
        fs.renameSync(legacy, migratedPath);
      } else {
        fs.unlinkSync(legacy);
      }
      return migratedPath;
    } catch {
      return legacy;
    }
  }
  return null;
}

// ── Batch download ─────────────────────────────────────────────────────────

export async function downloadAll(
  slugs: string[],
  destDir: string,
  onProgress?: (
    slug: string,
    idx: number,
    total: number,
    ok: boolean,
    skipped?: boolean
  ) => void
): Promise<{ succeeded: string[]; failed: string[]; skipped: number }> {
  const moved = moveLegacyZipsToSubdir(destDir);
  if (moved > 0) {
    console.log(`Moved ${moved} legacy zip(s) into ${path.join("clawhub", ZIP_SUBDIR)}`);
  }

  const succeeded: string[] = [];
  const failed: string[] = [];
  let skippedCount = 0;

  const queue = [...slugs];
  let idx = 0;

  const worker = async () => {
    while (queue.length > 0) {
      const slug = queue.shift()!;
      const currentIdx = ++idx;

      const existing = findExistingZip(slug, destDir);
      if (existing) {
        skippedCount++;
        onProgress?.(slug, currentIdx, slugs.length, true, true);
        succeeded.push(slug);
        continue;
      }

      const { downloaded, skipped } = await downloadSkill(slug, destDir);
      if (skipped) skippedCount++;
      if (downloaded) {
        succeeded.push(slug);
      } else {
        failed.push(slug);
      }
      onProgress?.(slug, currentIdx, slugs.length, downloaded, skipped);
    }
  };

  const workers = Array.from({ length: Math.min(CONCURRENCY, slugs.length) }, () => worker());
  await Promise.all(workers);

  return { succeeded, failed, skipped: skippedCount };
}

// ── Seed into DB ───────────────────────────────────────────────────────────

export async function seedSkillsToDB(
  projectRoot: string,
  options?: { quiet?: boolean }
): Promise<{ seeded: number }> {
  const skills = loadSeedList(projectRoot);
  const total = skills.length;
  const quiet = options?.quiet ?? false;
  const isTTY = process.stdout.isTTY;
  const showProgress = !quiet && total > 0;
  const clawhubDir = path.join(projectRoot, "clawhub");

  const rows: Array<{ entry: ClawHubSkillEntry; extra: { zipPath?: string } }> = [];
  let resolved = 0;
  for (const skill of skills) {
    const zipPath = findExistingZip(skill.slug, clawhubDir);
    rows.push({ entry: skill, extra: { zipPath: zipPath ?? undefined } });
    resolved++;
    if (!showProgress) continue;
    const pct = ((resolved / total) * 100).toFixed(1);
    if (isTTY) {
      process.stdout.write(`\r  Preparing ${resolved}/${total} (${pct}%)…`);
    } else if (resolved % 500 === 0 || resolved === total) {
      console.log(`  Preparing ${resolved}/${total} (${pct}%)…`);
    }
  }

  if (showProgress && isTTY) {
    process.stdout.write("\n");
  }

  if (!quiet && total > 0) {
    console.log(
      `  Applying ${total} rows to SQLite (${dbPath()})…`
    );
    console.log(
      "  If nothing follows: wait for the DB lock (another claw-bench), or delete bench.db.lock beside the DB file."
    );
  }

  await upsertClawHubSkillsBatch(rows, {
    onBatchBegin:
      !quiet && total > 0
        ? () => {
            console.log("  SQLite: loading engine and opening database…");
          }
        : undefined,
    onProgress: showProgress
      ? (current, n) => {
          const pct = ((current / n) * 100).toFixed(1);
          if (isTTY) {
            const step = n > 5000 ? 50 : 1;
            if (current !== 1 && current !== n && current % step !== 0) return;
            process.stdout.write(`\r  Writing ${current}/${n} (${pct}%) to SQLite…`);
          } else if (current % 500 === 0 || current === 1 || current === n) {
            console.log(`  Writing ${current}/${n} (${pct}%) to SQLite…`);
          }
        }
      : undefined,
    beforeFlush:
      !quiet && total > 0
        ? () => {
            if (isTTY) process.stdout.write("\n");
            console.log(
              "  Saving database to disk (sql.js full export — can take minutes on large catalogs)…"
            );
          }
        : undefined,
  });

  if (showProgress && isTTY) {
    process.stdout.write("\n");
  }

  return { seeded: total };
}
