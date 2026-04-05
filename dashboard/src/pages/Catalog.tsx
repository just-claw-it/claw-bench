import { useState, useMemo, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCatalog, useCatalogStats, prefetchCatalogNeighbors } from "../api";
import { type CatalogSkill, pct, scoreColor } from "../types";
import ScoreBar from "../components/ScoreBar";
import { LlmBreakdownInline, parseLlmModelsJson } from "../components/LlmMultiModelHint";

type SortKey = "overall" | "name" | "downloads" | "stars";
type ViewMode = "table" | "grid";

const PAGE_SIZES = [10, 50, 100] as const;

export default function Catalog() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(50);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("overall");
  const [view, setView] = useState<ViewMode>("grid");
  const [filterAnalyzed, setFilterAnalyzed] = useState(false);
  const [filterScripts, setFilterScripts] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(searchInput), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ, sortKey, filterAnalyzed, filterScripts, pageSize]);

  const queryClient = useQueryClient();
  const { data, isLoading, error, isFetching, isPlaceholderData } = useCatalog({
    page,
    limit: pageSize,
    sort: sortKey,
    q: debouncedQ,
    analyzedOnly: filterAnalyzed,
    withScripts: filterScripts,
    includeStats: false,
  });
  const { data: catalogStats } = useCatalogStats();

  const skills = data?.skills ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;
  const limit = data?.limit ?? pageSize;

  useEffect(() => {
    if (!data || totalPages <= 1) return;
    prefetchCatalogNeighbors(queryClient, {
      page,
      totalPages,
      limit: pageSize,
      sort: sortKey,
      q: debouncedQ,
      analyzedOnly: filterAnalyzed,
      withScripts: filterScripts,
      includeStats: false,
    });
  }, [
    queryClient,
    data,
    page,
    totalPages,
    pageSize,
    sortKey,
    debouncedQ,
    filterAnalyzed,
    filterScripts,
  ]);

  const rangeLabel = useMemo(() => {
    if (total === 0) return "0 results";
    const start = (page - 1) * limit + 1;
    const end = Math.min(page * limit, total);
    return `${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`;
  }, [page, limit, total]);

  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-slate-400 animate-pulse">Loading catalog...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-red-500 font-medium">Failed to load catalog</p>
          <p className="text-sm text-slate-400 mt-2">
            Check that the API is running and the SQLite catalog is seeded (
            <code className="bg-slate-800 px-1 rounded">clawhub crawl --seed-only</code>).
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
          ClawHub Catalog
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          {rangeLabel}
          {isFetching && !isPlaceholderData ? (
            <span className="ml-2 text-slate-400">(updating…)</span>
          ) : null}
        </p>
        <p
          className="text-xs text-slate-500 dark:text-slate-500 mt-2 font-mono break-all"
          title="Set CLAW_BENCH_DB to the same file you used for clawhub analyze / crawl."
        >
          SQLite: {catalogStats?.dbPath ?? "—"}
        </p>
      </div>

      {totalPages > 1 && (
        <CatalogPaginationBar
          page={page}
          totalPages={totalPages}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
          className="pb-4 border-b border-slate-200 dark:border-slate-800"
        />
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search skills..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-slate-100 w-64 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />

        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-slate-100"
        >
          <option value="overall">Sort: Score</option>
          <option value="downloads">Sort: Downloads</option>
          <option value="stars">Sort: Stars</option>
          <option value="name">Sort: Name</option>
        </select>

        <label
          className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400 cursor-pointer"
          title="Only skills that have at least one clawhub_analysis row in this database. The list is still paginated (see “Per page” and page controls); the subtitle shows total matches, e.g. 1–50 of 40,000."
        >
          <input
            type="checkbox"
            checked={filterAnalyzed}
            onChange={(e) => setFilterAnalyzed(e.target.checked)}
            className="rounded"
          />
          Analyzed only
        </label>

        <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
          <input
            type="checkbox"
            checked={filterScripts}
            onChange={(e) => setFilterScripts(e.target.checked)}
            className="rounded"
          />
          With scripts
        </label>

        <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
          <span className="text-slate-500">Per page</span>
          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <div className="ml-auto flex rounded-lg border border-slate-300 dark:border-slate-700 overflow-hidden">
          <button
            type="button"
            onClick={() => setView("grid")}
            className={`px-3 py-1.5 text-sm ${view === "grid" ? "bg-blue-600 text-white" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400"}`}
          >
            Grid
          </button>
          <button
            type="button"
            onClick={() => setView("table")}
            className={`px-3 py-1.5 text-sm ${view === "table" ? "bg-blue-600 text-white" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400"}`}
          >
            Table
          </button>
        </div>
      </div>

      {/* Content */}
      {view === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {skills.map((skill) => (
            <SkillCard key={skill.slug} skill={skill} />
          ))}
        </div>
      ) : (
        <SkillTable skills={skills} startIndex={(page - 1) * limit} />
      )}

      {skills.length === 0 && !isLoading && (
        <div className="text-center py-16 text-slate-400">
          No skills match your filters.
        </div>
      )}

      {totalPages > 1 && (
        <CatalogPaginationBar
          page={page}
          totalPages={totalPages}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
          className="pt-4 border-t border-slate-200 dark:border-slate-800"
        />
      )}
    </div>
  );
}

function CatalogPaginationBar({
  page,
  totalPages,
  onPrev,
  onNext,
  className = "",
}: {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-wrap items-center justify-center gap-2 ${className}`.trim()}
    >
      <button
        type="button"
        disabled={page <= 1}
        onClick={onPrev}
        className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 dark:hover:bg-slate-800"
      >
        Previous
      </button>
      <span className="text-sm text-slate-600 dark:text-slate-400 px-2 tabular-nums">
        Page {page} / {totalPages}
      </span>
      <button
        type="button"
        disabled={page >= totalPages}
        onClick={onNext}
        className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 dark:hover:bg-slate-800"
      >
        Next
      </button>
    </div>
  );
}

function SkillCard({ skill }: { skill: CatalogSkill }) {
  return (
    <a
      href={`/catalog/${encodeURIComponent(skill.slug)}`}
      className="block rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 shadow-sm hover:shadow-md hover:border-blue-400 dark:hover:border-blue-600 transition-all"
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">
            {skill.name}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            @{skill.author} &middot; {skill.version}
          </p>
        </div>
        {skill.overall_composite != null && (
          <span
            className={`text-lg font-bold ${scoreColor(skill.overall_composite)}`}
            title={
              (skill.llm_model_count ?? 0) > 1
                ? "Weighted static + LLM (see README); LLM term aggregates multiple models."
                : undefined
            }
          >
            {pct(skill.overall_composite)}
            {(skill.llm_model_count ?? 0) > 1 ? (
              <span className="ml-1 text-[10px] font-normal text-slate-400">multi-LLM</span>
            ) : null}
          </span>
        )}
      </div>

      <p className="text-sm text-slate-600 dark:text-slate-400 line-clamp-2 mb-4">
        {skill.description ?? "No description"}
      </p>

      <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400 mb-3">
        <span title="Downloads">{skill.downloads} dl</span>
        <span title="Stars">{skill.stars} stars</span>
        <span title="Versions">{skill.version_count}v</span>
        {skill.has_scripts ? (
          <span className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 text-[10px] font-medium">
            scripts
          </span>
        ) : null}
      </div>

      {skill.analyzed && skill.static_composite != null && (
        <div className="space-y-1.5">
          <ScoreBar score={skill.static_composite} label="Static" />
          {skill.llm_composite != null && (
            <div>
              <ScoreBar score={skill.llm_composite} label="LLM" />
              {(skill.llm_model_count ?? 0) > 1 ? (
                <details className="mt-1.5 text-[10px] text-slate-400">
                  <summary className="cursor-pointer select-none hover:text-slate-500">
                    Avg of {skill.llm_model_count} models (hover score for detail)
                  </summary>
                  <ul className="mt-1 pl-3 list-disc space-y-0.5 text-slate-500 dark:text-slate-400">
                    {parseLlmModelsJson(skill.llm_models_json).map((m) => (
                      <li key={`${m.model}-${m.analyzed_at}`}>
                        <span className="font-medium text-slate-600 dark:text-slate-300">
                          {m.model}
                        </span>
                        {": "}
                        {pct(m.llm_composite)}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          )}
        </div>
      )}

      {!skill.analyzed && (
        <div className="text-xs text-slate-400 italic">Not yet analyzed</div>
      )}
      {skill.analyzed && skill.pipeline_ms != null && (
        <p className="text-[10px] text-slate-400 mt-2 tabular-nums">
          Pipeline {Math.round(skill.pipeline_ms)} ms
        </p>
      )}
    </a>
  );
}

function SkillTable({
  skills,
  startIndex = 0,
}: {
  skills: CatalogSkill[];
  startIndex?: number;
}) {
  return (
    <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-100 dark:bg-slate-800/50">
          <tr>
            <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">#</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">Skill</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">Author</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">Downloads</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">Stars</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">Static</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">LLM</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">Overall</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase" title="Wall time from latest analyze run">
              Pipeline
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
          {skills.map((sk, i) => (
            <tr key={sk.slug} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
              <td className="px-4 py-2 text-slate-400 font-mono text-xs">{startIndex + i + 1}</td>
              <td className="px-4 py-2">
                <a
                  href={`/catalog/${encodeURIComponent(sk.slug)}`}
                  className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                >
                  {sk.name}
                </a>
                <span className="ml-2 text-xs text-slate-400">{sk.version}</span>
              </td>
              <td className="px-4 py-2 text-slate-500">@{sk.author}</td>
              <td className="px-4 py-2 text-slate-500">{sk.downloads}</td>
              <td className="px-4 py-2 text-slate-500">{sk.stars}</td>
              <td className="px-4 py-2 font-mono">
                {sk.static_composite != null ? (
                  <span className={scoreColor(sk.static_composite)}>{pct(sk.static_composite)}</span>
                ) : (
                  <span className="text-slate-400">--</span>
                )}
              </td>
              <td className="px-4 py-2 font-mono align-top">
                <LlmBreakdownInline
                  llmComposite={sk.llm_composite}
                  llmModelCount={sk.llm_model_count}
                  llmModelsJson={sk.llm_models_json}
                  scoreClassName={
                    sk.llm_composite != null ? scoreColor(sk.llm_composite) : "text-slate-400"
                  }
                  expandable
                />
              </td>
              <td className="px-4 py-2 font-mono font-semibold align-top">
                {sk.overall_composite != null ? (
                  <span
                    className={scoreColor(sk.overall_composite)}
                    title={
                      (sk.llm_model_count ?? 0) > 1
                        ? "Weighted static + LLM; LLM term aggregated across models (README)."
                        : undefined
                    }
                  >
                    {pct(sk.overall_composite)}
                    {(sk.llm_model_count ?? 0) > 1 ? (
                      <span className="ml-1 text-[10px] font-normal text-slate-400">*</span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-slate-400">--</span>
                )}
              </td>
              <td className="px-4 py-2 font-mono text-xs text-slate-500 tabular-nums">
                {sk.pipeline_ms != null ? `${Math.round(sk.pipeline_ms)} ms` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
