import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { Run } from "../types";
import { pct, scoreColor } from "../types";
import ScoreBar from "./ScoreBar";

interface Props {
  runs: Run[];
  compact?: boolean;
}

type SortKey = "skill_name" | "composite" | "benchmarked_at" | "skill_type" | "score_type";

export default function RunsTable({ runs, compact = false }: Props) {
  const navigate = useNavigate();
  const [sortKey, setSortKey] = useState<SortKey>("benchmarked_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [scoreTypeFilter, setScoreTypeFilter] = useState("");

  const filtered = useMemo(() => {
    let result = [...runs];
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((r) => r.skill_name.toLowerCase().includes(q));
    }
    if (typeFilter) result = result.filter((r) => r.skill_type === typeFilter);
    if (scoreTypeFilter)
      result = result.filter((r) => r.score_type === scoreTypeFilter);
    result.sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return result;
  }, [runs, search, typeFilter, scoreTypeFilter, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const sortIcon = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  const headerCls =
    "px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider cursor-pointer select-none hover:text-slate-700 dark:hover:text-slate-200";

  return (
    <div>
      {!compact && (
        <div className="flex flex-wrap gap-3 mb-4">
          <input
            type="text"
            placeholder="Search skills..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 outline-none focus:ring-2 focus:ring-blue-500 w-64"
          />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100"
          >
            <option value="">All types</option>
            <option value="linear">linear</option>
            <option value="webhook">webhook</option>
            <option value="cron">cron</option>
          </select>
          <select
            value={scoreTypeFilter}
            onChange={(e) => setScoreTypeFilter(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100"
          >
            <option value="">All score types</option>
            <option value="authored">authored</option>
            <option value="automated">automated</option>
          </select>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 dark:bg-slate-800/50">
            <tr>
              <th className={headerCls} style={{ width: 32 }} />
              <th className={headerCls} onClick={() => toggleSort("skill_name")}>
                Skill{sortIcon("skill_name")}
              </th>
              <th className={headerCls} onClick={() => toggleSort("skill_type")}>
                Type{sortIcon("skill_type")}
              </th>
              <th className={headerCls} onClick={() => toggleSort("score_type")}>
                Score{sortIcon("score_type")}
              </th>
              <th className={headerCls} onClick={() => toggleSort("composite")}>
                Composite{sortIcon("composite")}
              </th>
              {!compact && (
                <>
                  <th className={headerCls}>Cons</th>
                  <th className={headerCls}>Rob</th>
                  <th className={headerCls}>Lat</th>
                </>
              )}
              <th
                className={headerCls}
                onClick={() => toggleSort("benchmarked_at")}
              >
                Date{sortIcon("benchmarked_at")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {filtered.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                compact={compact}
                isExpanded={expanded.has(run.id)}
                onToggle={() => toggleExpand(run.id)}
                onSkillClick={() => navigate(`/skills/${encodeURIComponent(run.skill_name)}`)}
              />
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={compact ? 6 : 9}
                  className="px-4 py-8 text-center text-slate-400"
                >
                  No runs found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        {filtered.length} of {runs.length} runs
      </p>
    </div>
  );
}

function RunRow({
  run,
  compact,
  isExpanded,
  onToggle,
  onSkillClick,
}: {
  run: Run;
  compact: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onSkillClick: () => void;
}) {
  const cellCls = "px-3 py-2.5 whitespace-nowrap";
  return (
    <>
      <tr className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
        <td className={cellCls}>
          <button
            onClick={onToggle}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xs"
          >
            {isExpanded ? "▾" : "▸"}
          </button>
        </td>
        <td className={cellCls}>
          <button
            onClick={onSkillClick}
            className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
          >
            {run.skill_name}
          </button>
        </td>
        <td className={cellCls}>
          <span className="px-2 py-0.5 rounded-full text-xs bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
            {run.skill_type}
          </span>
        </td>
        <td className={cellCls}>
          <span
            className={`px-2 py-0.5 rounded-full text-xs ${
              run.score_type === "authored"
                ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"
                : "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400"
            }`}
          >
            {run.score_type}
          </span>
        </td>
        <td className={`${cellCls} font-mono font-semibold ${scoreColor(run.composite)}`}>
          {pct(run.composite)}
        </td>
        {!compact && (
          <>
            <td className={`${cellCls} font-mono text-xs ${scoreColor(run.score_consistency)}`}>
              {pct(run.score_consistency)}
            </td>
            <td className={`${cellCls} font-mono text-xs ${scoreColor(run.score_robustness)}`}>
              {pct(run.score_robustness)}
            </td>
            <td className={`${cellCls} font-mono text-xs ${scoreColor(run.score_latency)}`}>
              {pct(run.score_latency)}
            </td>
          </>
        )}
        <td className={`${cellCls} text-slate-500 dark:text-slate-400 text-xs`}>
          {run.benchmarked_at.slice(0, 10)}
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={compact ? 6 : 9} className="px-6 py-4 bg-slate-50 dark:bg-slate-800/30">
            <ExpandedDetail run={run} />
          </td>
        </tr>
      )}
    </>
  );
}

function ExpandedDetail({ run }: { run: Run }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
      <div className="space-y-2">
        <h4 className="font-semibold text-slate-700 dark:text-slate-300 text-sm">
          Dimensions
        </h4>
        {run.score_correctness !== null && (
          <ScoreBar score={run.score_correctness} label="Correctness" />
        )}
        <ScoreBar score={run.score_consistency} label="Consistency" />
        <ScoreBar score={run.score_robustness} label="Robustness" />
        <ScoreBar score={run.score_latency} label="Latency" />
      </div>
      <div className="space-y-1 text-slate-600 dark:text-slate-400">
        <h4 className="font-semibold text-slate-700 dark:text-slate-300 text-sm">
          Details
        </h4>
        <p>Embed model: {run.embed_model}</p>
        <p>Consistency: min_sim={run.consistency_min_sim.toFixed(4)}, avg={run.consistency_avg_sim.toFixed(4)}, {run.consistency_stable ? "stable" : "unstable"}</p>
        <p>Robustness: {run.robustness_crashes} crashes</p>
        <p>Latency: p50={run.latency_p50_ms}ms, p95={run.latency_p95_ms}ms (threshold: {run.latency_threshold_ms}ms)</p>
        <p>Config: {run.consistency_runs} runs, threshold={run.consistency_threshold}</p>
        {run.skill_version && <p>Version: {run.skill_version}</p>}
        {run.skipped_reason && (
          <p className="text-amber-600">Skipped: {run.skipped_reason}</p>
        )}
      </div>
    </div>
  );
}
