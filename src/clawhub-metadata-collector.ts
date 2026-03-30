/**
 * Build {@link SkillMetadata} from public ClawHub Convex queries (`skills:getBySlug`,
 * `skills:listVersionsPage`). See README: some fields are only partially available
 * from the public API (tags, star averages, historical install series, skill-to-skill deps).
 */

import type { SkillMetadata } from "./types.js";
import { convexQueryValue } from "./clawhub-registry.js";

// ── Convex response shapes (best-effort; API may evolve) ───────────────────

export interface ClawHubSkillStats {
  downloads?: number;
  stars?: number;
  versions?: number;
  installsAllTime?: number;
  installsCurrent?: number;
  comments?: number;
}

export interface ClawHubPublicSkill {
  _id?: string;
  slug?: string;
  displayName?: string;
  summary?: string | null;
  createdAt?: number;
  updatedAt?: number;
  stats?: ClawHubSkillStats;
  tags?: unknown;
  badges?: Record<string, unknown> | null;
}

export interface ClawHubPublicPublisher {
  handle?: string | null;
}

export interface ClawHubVersionRow {
  version?: string;
  createdAt?: number;
  parsed?: { clawdis?: unknown; license?: unknown } | null;
}

export interface ClawHubGetBySlugValue {
  resolvedSlug?: string;
  skill?: ClawHubPublicSkill | null;
  latestVersion?: ClawHubVersionRow | null;
  owner?: ClawHubPublicPublisher | null;
}

export interface ClawHubListVersionsPageValue {
  items?: ClawHubVersionRow[];
  nextCursor?: string | null;
}

function msToIso(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/** Public list responses often use `{ latest: versionId }` instead of string tags. */
export function normalizeSkillTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((t): t is string => typeof t === "string" && t.length > 0);
  }
  return [];
}

function isSlugLike(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,127}$/.test(s);
}

/** Best-effort: ClawHub does not expose a stable public field for cross-skill edges yet. */
export function dependencyNamesFromParsedClawdis(clawdis: unknown): string[] {
  const out = new Set<string>();
  if (!clawdis || typeof clawdis !== "object") return [];

  const walk = (node: unknown) => {
    if (typeof node === "string") {
      if (isSlugLike(node)) out.add(node);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    const o = node as Record<string, unknown>;
    for (const k of ["skills", "skillSlugs", "dependsOn", "dependencies"]) {
      walk(o[k]);
    }
    if (o.requires && typeof o.requires === "object") {
      walk((o.requires as Record<string, unknown>).skills);
    }
    if (o.install && Array.isArray(o.install)) {
      for (const inst of o.install) {
        if (!inst || typeof inst !== "object") continue;
        const row = inst as Record<string, unknown>;
        if (row.kind === "skill") {
          if (typeof row.slug === "string" && isSlugLike(row.slug)) out.add(row.slug);
          if (typeof row.id === "string" && isSlugLike(row.id)) out.add(row.id);
        }
      }
    }
  };

  walk(clawdis);
  return [...out];
}

function collectDepsFromVersions(versions: ClawHubVersionRow[]): string[] {
  const s = new Set<string>();
  for (const v of versions) {
    const cd = v.parsed?.clawdis;
    for (const d of dependencyNamesFromParsedClawdis(cd)) s.add(d);
  }
  return [...s];
}

/**
 * Map one `getBySlug` payload plus all version rows into {@link SkillMetadata}.
 * `recordedAt` is used for the single install-history snapshot (public API has no time series).
 */
export function mapClawHubDetailToSkillMetadata(
  detail: ClawHubGetBySlugValue,
  versions: ClawHubVersionRow[],
  recordedAt: string
): SkillMetadata | null {
  const skill = detail.skill;
  const slug =
    (typeof detail.resolvedSlug === "string" && detail.resolvedSlug) ||
    (typeof skill?.slug === "string" && skill.slug) ||
    null;
  if (!slug) return null;

  const stats = skill?.stats ?? {};
  const installTotal = Math.max(
    0,
    Math.round(
      typeof stats.installsAllTime === "number"
        ? stats.installsAllTime
        : typeof stats.downloads === "number"
          ? stats.downloads
          : 0
    )
  );
  const starCount = Math.max(0, Math.round(stats.stars ?? 0));

  const sorted = [...versions].filter((v) => typeof v.version === "string");
  sorted.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

  const latestVer =
    (typeof detail.latestVersion?.version === "string" && detail.latestVersion.version) ||
    (sorted.length > 0 ? sorted[sorted.length - 1]!.version! : null);

  const lastIdx = sorted.length - 1;
  const versionHistory = sorted.map((v, i) => ({
    version: v.version!,
    publishedAt: msToIso(v.createdAt),
    isLatest: i === lastIdx,
  }));

  // If only latest was returned empty but we have latestVersion, still emit one row
  if (versionHistory.length === 0 && latestVer) {
    versionHistory.push({
      version: latestVer,
      publishedAt: msToIso(detail.latestVersion?.createdAt),
      isLatest: true,
    });
  }

  const official =
    skill?.badges &&
    typeof skill.badges === "object" &&
    skill.badges.official != null;

  const author =
    (typeof detail.owner?.handle === "string" && detail.owner.handle) || "unknown";

  return {
    skillName: slug,
    author,
    verifiedAuthor: Boolean(official),
    tags: normalizeSkillTags(skill?.tags),
    starRating: null,
    starCount,
    latestVersion: latestVer,
    firstPublishedAt: msToIso(skill?.createdAt),
    lastUpdatedAt: msToIso(skill?.updatedAt),
    dependencyNames: collectDepsFromVersions(versions.length ? versions : [detail.latestVersion ?? {}]),
    installHistory:
      installTotal > 0
        ? [{ recordedAt, installCount: installTotal }]
        : [],
    versionHistory,
  };
}

async function fetchAllVersions(skillId: string): Promise<ClawHubVersionRow[]> {
  const all: ClawHubVersionRow[] = [];
  let cursor: string | undefined;
  const limit = 50;
  for (;;) {
    const args: Record<string, unknown> = { skillId, limit };
    if (cursor) args.cursor = cursor;
    const page = await convexQueryValue<ClawHubListVersionsPageValue>(
      "skills:listVersionsPage",
      args
    );
    const items = page.items ?? [];
    all.push(...items);
    const next = page.nextCursor;
    if (!next || items.length === 0) break;
    cursor = next;
  }
  return all;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function withRetries<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const wait = 400 * 2 ** attempt;
      await sleep(wait);
    }
  }
  throw new Error(`${label}: ${last instanceof Error ? last.message : String(last)}`);
}

/**
 * Fetch Convex detail + paginated versions for one slug.
 */
export async function fetchSkillMetadataForSlug(
  slug: string,
  recordedAt: string
): Promise<SkillMetadata | null> {
  const detail = await withRetries(
    () => convexQueryValue<ClawHubGetBySlugValue | null>("skills:getBySlug", { slug }),
    `getBySlug(${slug})`
  );
  if (!detail?.skill?._id) return null;

  const versions = await withRetries(
    () => fetchAllVersions(detail.skill!._id!),
    `listVersionsPage(${slug})`
  );

  return mapClawHubDetailToSkillMetadata(detail, versions, recordedAt);
}

export interface CollectClawHubMetadataOptions {
  concurrency?: number;
  delayMs?: number;
  onSkill?: (info: {
    slug: string;
    index: number;
    total: number;
    ok: boolean;
    error?: string;
  }) => void;
  /**
   * With `onFlush`, flush after every N successful records (default **1** = each slug). Also flushes once at the end.
   */
  flushEvery?: number;
  onFlush?: (records: readonly SkillMetadata[]) => void;
}

/**
 * Bounded parallel fetch for many slugs (respectful defaults: low concurrency).
 */
export async function collectClawHubMetadataForSlugs(
  slugs: string[],
  recordedAt: string,
  opts: CollectClawHubMetadataOptions = {}
): Promise<{ records: SkillMetadata[]; errors: Array<{ slug: string; message: string }> }> {
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const delayMs = Math.max(0, opts.delayMs ?? 0);
  const unique = [...new Set(slugs.map((s) => s.trim()).filter(Boolean))];
  const records: SkillMetadata[] = [];
  const errors: Array<{ slug: string; message: string }> = [];
  const flushEvery = Math.max(1, opts.flushEvery ?? (opts.onFlush ? 1 : 25));

  function maybeFlushAfterPush() {
    if (!opts.onFlush) return;
    if (records.length > 0 && records.length % flushEvery === 0) {
      opts.onFlush(records.slice());
    }
  }

  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const i = nextIndex++;
      if (i >= unique.length) return;
      const slug = unique[i]!;
      try {
        const meta = await fetchSkillMetadataForSlug(slug, recordedAt);
        if (meta) {
          records.push(meta);
          maybeFlushAfterPush();
          opts.onSkill?.({ slug, index: i, total: unique.length, ok: true });
        } else {
          errors.push({ slug, message: "not found or not public" });
          opts.onSkill?.({ slug, index: i, total: unique.length, ok: false, error: "not found" });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ slug, message });
        opts.onSkill?.({ slug, index: i, total: unique.length, ok: false, error: message });
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()));
  if (opts.onFlush) opts.onFlush(records.slice());
  return { records, errors };
}
