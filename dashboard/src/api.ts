import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  Run, Skill, Stats, DriftAnalysis,
  CatalogPage, SkillAnalysisDetail, CatalogStats, DashboardOverview,
} from "./types";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

export function useStats() {
  return useQuery<Stats>({
    queryKey: ["stats"],
    queryFn: () => fetchJson("/api/stats"),
  });
}

export function useRuns() {
  return useQuery<{ runs: Run[]; total: number }>({
    queryKey: ["runs"],
    queryFn: () => fetchJson("/api/runs"),
  });
}

export function useSkills() {
  return useQuery<Skill[]>({
    queryKey: ["skills"],
    queryFn: () => fetchJson("/api/skills"),
  });
}

export function useSkillDrift(name: string) {
  return useQuery<DriftAnalysis>({
    queryKey: ["drift", name],
    queryFn: () => fetchJson(`/api/skills/${encodeURIComponent(name)}/drift`),
    enabled: !!name,
  });
}

export function useDistributions() {
  return useQuery({
    queryKey: ["distributions"],
    queryFn: () => fetchJson("/api/distributions"),
  });
}

export function useCompare(skills: string[]) {
  return useQuery<Run[]>({
    queryKey: ["compare", skills],
    queryFn: () => fetchJson(`/api/compare?skills=${skills.map(encodeURIComponent).join(",")}`),
    enabled: skills.length >= 2,
  });
}

// ── Catalog hooks ────────────────────────────────────────────────────────

export interface UseCatalogOpts {
  page?: number;
  limit?: number;
  sort?: "overall" | "name" | "downloads" | "stars";
  q?: string;
  analyzedOnly?: boolean;
  withScripts?: boolean;
  /** When true, server bundles `/api/catalog/stats` into the same response (one HTTP + one DB pass). */
  includeStats?: boolean;
}

function normalizedCatalogOpts(opts: UseCatalogOpts) {
  return {
    page: opts.page ?? 1,
    limit: opts.limit ?? 50,
    sort: opts.sort ?? "overall",
    q: opts.q ?? "",
    analyzedOnly: opts.analyzedOnly ?? false,
    withScripts: opts.withScripts ?? false,
    includeStats: opts.includeStats ?? false,
  };
}

/** Plain fetch for prefetching / tooling. */
export async function fetchCatalogPage(opts: UseCatalogOpts = {}): Promise<CatalogPage> {
  const { page, limit, sort, q, analyzedOnly, withScripts, includeStats } =
    normalizedCatalogOpts(opts);
  const sp = new URLSearchParams();
  sp.set("page", String(page));
  sp.set("limit", String(limit));
  sp.set("sort", sort);
  if (q.trim()) sp.set("q", q.trim());
  if (analyzedOnly) sp.set("analyzed", "1");
  if (withScripts) sp.set("scripts", "1");
  if (includeStats) sp.set("stats", "1");
  return fetchJson<CatalogPage>(`/api/catalog?${sp.toString()}`);
}

export function catalogListQueryOptions(opts: UseCatalogOpts = {}) {
  const { page, limit, sort, q, analyzedOnly, withScripts, includeStats } =
    normalizedCatalogOpts(opts);
  return {
    queryKey: [
      "catalog",
      page,
      limit,
      sort,
      q,
      analyzedOnly,
      withScripts,
      includeStats,
    ] as const,
    queryFn: () => fetchCatalogPage(opts),
    staleTime: 60_000,
  };
}

/** Warm next/prev pages so pagination often hits the React Query cache. */
export function prefetchCatalogNeighbors(
  qc: QueryClient,
  opts: UseCatalogOpts & { totalPages: number }
): void {
  const page = opts.page ?? 1;
  const { totalPages, ...rest } = opts;
  if (totalPages <= 1) return;
  const prefetchOpts = { ...rest, includeStats: false };
  if (page < totalPages) {
    void qc.prefetchQuery(catalogListQueryOptions({ ...prefetchOpts, page: page + 1 }));
  }
  if (page > 1) {
    void qc.prefetchQuery(catalogListQueryOptions({ ...prefetchOpts, page: page - 1 }));
  }
}

export function useCatalog(opts: UseCatalogOpts = {}) {
  return useQuery<CatalogPage>({
    ...catalogListQueryOptions(opts),
    placeholderData: keepPreviousData,
  });
}

export function useCatalogSkill(slug: string) {
  return useQuery<SkillAnalysisDetail>({
    queryKey: ["catalog", slug],
    queryFn: () => fetchJson(`/api/catalog/${encodeURIComponent(slug)}`),
    enabled: !!slug,
  });
}

export function useCatalogStats() {
  return useQuery<CatalogStats>({
    queryKey: ["catalogStats"],
    queryFn: () => fetchJson("/api/catalog/stats"),
    /** Global counts — independent of catalog page/filters; avoid refetching on every list navigation. */
    staleTime: 300_000,
  });
}

export function useDashboardOverview() {
  return useQuery<DashboardOverview>({
    queryKey: ["dashboardOverview"],
    queryFn: () => fetchJson<DashboardOverview>("/api/dashboard/overview"),
    staleTime: 60_000,
  });
}

// ── Import ───────────────────────────────────────────────────────────────

export function useImportReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (report: unknown) => {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
      });
      if (!res.ok) throw new Error(`Import failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.invalidateQueries({ queryKey: ["catalog"] });
      qc.invalidateQueries({ queryKey: ["catalogStats"] });
      qc.invalidateQueries({ queryKey: ["dashboardOverview"] });
    },
  });
}
