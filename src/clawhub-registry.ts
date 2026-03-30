/**
 * Fetch the public ClawHub skill catalog via the official Convex HTTP API.
 *
 * The SPA at https://clawhub.ai/skills uses the same backend; you do not need
 * to scrape HTML or run a headless browser.
 *
 * @see https://github.com/openclaw/clawhub — `listPublicPageV4` in convex/skills.ts
 */

import type { ClawHubSkillEntry } from "./types.js";

const DEFAULT_CONVEX_URL = "https://wry-manatee-359.convex.cloud";

export type RegistrySort =
  | "newest"
  | "updated"
  | "downloads"
  | "installs"
  | "stars"
  | "name";

export interface ListPublicPageV4Args {
  cursor?: string;
  numItems?: number;
  sort?: RegistrySort;
  dir?: "asc" | "desc";
  highlightedOnly?: boolean;
  nonSuspiciousOnly?: boolean;
}

interface RawPage {
  hasMore: boolean;
  nextCursor: string | null;
  page: RawPageItem[];
}

interface RawPageItem {
  skill?: {
    slug?: string;
    displayName?: string;
    summary?: string | null;
    stats?: {
      downloads?: number;
      stars?: number;
      versions?: number;
    };
  };
  ownerHandle?: string | null;
  latestVersion?: {
    parsed?: { version?: string } | null;
  } | null;
}

export function convexUrl(): string {
  return (
    process.env.CLAWHUB_CONVEX_URL?.replace(/\/$/, "") ?? DEFAULT_CONVEX_URL
  );
}

/**
 * POST to Convex `/api/query` and return the successful `value` payload.
 * Used by catalog crawl and by richer per-skill metadata collection.
 */
export async function convexQueryValue<T>(
  path: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const res = await fetch(`${convexUrl()}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, format: "json", args }),
  });

  if (!res.ok) {
    throw new Error(
      `Convex query failed: HTTP ${res.status} ${await res.text().catch(() => "")}`
    );
  }

  const json = (await res.json()) as {
    status: string;
    value?: T;
    errorMessage?: string;
  };

  if (json.status !== "success" || json.value === undefined) {
    throw new Error(json.errorMessage ?? "Convex query returned no value");
  }

  return json.value;
}

/** Compact number like the ClawHub UI (e.g. 295000 → "295k"). */
export function formatStat(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v >= 10 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 10_000) {
    return `${Math.round(n / 1000)}k`;
  }
  if (n >= 1000) {
    const v = n / 1000;
    return `${v.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(Math.round(n));
}

function versionLabel(latestVersion: RawPageItem["latestVersion"]): string {
  const v = latestVersion?.parsed?.version;
  if (typeof v === "string" && v.length > 0) {
    return v.startsWith("v") ? v : `v${v}`;
  }
  return "v0.0.0";
}

function mapItem(item: RawPageItem): ClawHubSkillEntry | null {
  const skill = item.skill;
  const slug = skill?.slug;
  if (!slug) return null;

  const stats = skill.stats ?? {};
  const downloads = formatStat(stats.downloads ?? 0);
  const stars = formatStat(stats.stars ?? 0);
  const versionCount = Math.max(
    0,
    Math.round(stats.versions ?? 0)
  );

  return {
    slug,
    name: skill.displayName ?? slug,
    author: item.ownerHandle ?? "unknown",
    version: versionLabel(item.latestVersion),
    summary: skill.summary ?? "",
    downloads,
    stars,
    versionCount,
  };
}

/**
 * One page from `skills:listPublicPageV4` (max 200 rows per request).
 */
export async function fetchRegistryPage(
  args: ListPublicPageV4Args = {}
): Promise<{ entries: ClawHubSkillEntry[]; nextCursor: string | null; hasMore: boolean }> {
  const body = {
    path: "skills:listPublicPageV4",
    format: "json" as const,
    args: {
      numItems: Math.min(args.numItems ?? 200, 200),
      sort: args.sort ?? "downloads",
      dir: args.dir ?? "desc",
      ...(args.cursor ? { cursor: args.cursor } : {}),
      ...(args.highlightedOnly !== undefined
        ? { highlightedOnly: args.highlightedOnly }
        : {}),
      ...(args.nonSuspiciousOnly !== undefined
        ? { nonSuspiciousOnly: args.nonSuspiciousOnly }
        : {}),
    },
  };

  const { page, hasMore, nextCursor } = await convexQueryValue<RawPage>(body.path, body.args);
  const entries: ClawHubSkillEntry[] = [];
  for (const row of page ?? []) {
    const e = mapItem(row);
    if (e) entries.push(e);
  }

  return { entries, nextCursor, hasMore };
}

/**
 * Walk every page until the registry is exhausted.
 */
export async function fetchFullRegistry(options: {
  sort?: RegistrySort;
  dir?: "asc" | "desc";
  onPage?: (n: number, totalSoFar: number) => void;
} = {}): Promise<ClawHubSkillEntry[]> {
  const sort = options.sort ?? "downloads";
  const dir = options.dir ?? "desc";

  const all: ClawHubSkillEntry[] = [];
  let cursor: string | undefined;
  let pageNum = 0;
  const maxPages = 5000;

  for (;;) {
    if (pageNum >= maxPages) {
      throw new Error(
        `Stopped after ${maxPages} pages (safety limit). Partial list has ${all.length} skills.`
      );
    }
    const { entries, nextCursor, hasMore } = await fetchRegistryPage({
      numItems: 200,
      sort,
      dir,
      cursor,
    });
    pageNum++;

    if (entries.length === 0) {
      break;
    }
    all.push(...entries);
    options.onPage?.(pageNum, all.length);

    if (!hasMore || !nextCursor) {
      break;
    }
    cursor = nextCursor;
  }

  return all;
}
