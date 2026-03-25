import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  Run, Skill, Stats, DriftAnalysis,
  CatalogPage, SkillAnalysisDetail, CatalogStats,
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
}

export function useCatalog(opts: UseCatalogOpts = {}) {
  const page = opts.page ?? 1;
  const limit = opts.limit ?? 50;
  const sort = opts.sort ?? "overall";
  const q = opts.q ?? "";
  const analyzedOnly = opts.analyzedOnly ?? false;
  const withScripts = opts.withScripts ?? false;

  return useQuery<CatalogPage>({
    queryKey: ["catalog", page, limit, sort, q, analyzedOnly, withScripts],
    queryFn: () => {
      const sp = new URLSearchParams();
      sp.set("page", String(page));
      sp.set("limit", String(limit));
      sp.set("sort", sort);
      if (q.trim()) sp.set("q", q.trim());
      if (analyzedOnly) sp.set("analyzed", "1");
      if (withScripts) sp.set("scripts", "1");
      return fetchJson<CatalogPage>(`/api/catalog?${sp.toString()}`);
    },
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
    },
  });
}
