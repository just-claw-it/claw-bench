import { useState } from "react";
import { useSkills, useCompare } from "../api";
import { pct, scoreColor } from "../types";
import SkillRadarChart from "../components/RadarChart";
import ScoreBar from "../components/ScoreBar";

const COMPARE_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444"];

export default function Compare() {
  const skills = useSkills();
  const [selected, setSelected] = useState<string[]>([]);
  const comparison = useCompare(selected);

  const toggleSkill = (name: string) => {
    setSelected((prev) =>
      prev.includes(name)
        ? prev.filter((s) => s !== name)
        : prev.length < 4
        ? [...prev, name]
        : prev
    );
  };

  const allSkills = skills.data ?? [];

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
          Compare Skills
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Select 2-4 skills to compare side by side
        </p>
      </div>

      {/* Skill selector */}
      <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 shadow-sm">
        <div className="flex flex-wrap gap-2">
          {allSkills.map((sk) => {
            const isSelected = selected.includes(sk.skill_name);
            return (
              <button
                key={sk.skill_name}
                onClick={() => toggleSkill(sk.skill_name)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  isSelected
                    ? "bg-blue-600 text-white"
                    : "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
                }`}
              >
                {sk.skill_name}
                {isSelected && " ✓"}
              </button>
            );
          })}
          {allSkills.length === 0 && (
            <p className="text-sm text-slate-400">
              No skills found. Run some benchmarks first.
            </p>
          )}
        </div>
        {selected.length > 0 && selected.length < 2 && (
          <p className="text-xs text-amber-500 mt-2">
            Select at least 2 skills to compare
          </p>
        )}
      </div>

      {/* Comparison results */}
      {comparison.data && comparison.data.length >= 2 && (
        <>
          {/* Radar overlay */}
          <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
              Dimension Comparison
            </h3>
            <SkillRadarChart
              scores={comparison.data.map((r, i) => ({
                label: r.skill_name,
                correctness: r.score_correctness,
                consistency: r.score_consistency,
                robustness: r.score_robustness,
                latency: r.score_latency,
                color: COMPARE_COLORS[i % COMPARE_COLORS.length],
              }))}
            />
          </div>

          {/* Side-by-side bars */}
          <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">
              Score Breakdown
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 uppercase">
                      Skill
                    </th>
                    <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 uppercase">
                      Composite
                    </th>
                    <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 uppercase">
                      Correctness
                    </th>
                    <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 uppercase">
                      Consistency
                    </th>
                    <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 uppercase">
                      Robustness
                    </th>
                    <th className="text-left py-2 px-3 text-xs font-medium text-slate-500 uppercase">
                      Latency
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {comparison.data.map((r, i) => (
                    <tr key={r.skill_name}>
                      <td className="py-3 px-3">
                        <div className="flex items-center gap-2">
                          <span
                            className="w-3 h-3 rounded-full shrink-0"
                            style={{
                              backgroundColor:
                                COMPARE_COLORS[i % COMPARE_COLORS.length],
                            }}
                          />
                          <span className="font-medium text-slate-800 dark:text-slate-200">
                            {r.skill_name}
                          </span>
                        </div>
                      </td>
                      <td className={`py-3 px-3 font-mono font-bold ${scoreColor(r.composite)}`}>
                        {pct(r.composite)}
                      </td>
                      <td className="py-3 px-3">
                        {r.score_correctness !== null ? (
                          <ScoreBar score={r.score_correctness} showPct />
                        ) : (
                          <span className="text-xs text-slate-400">N/A</span>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        <ScoreBar score={r.score_consistency} showPct />
                      </td>
                      <td className="py-3 px-3">
                        <ScoreBar score={r.score_robustness} showPct />
                      </td>
                      <td className="py-3 px-3">
                        <ScoreBar score={r.score_latency} showPct />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Winner */}
          {comparison.data.length >= 2 && (() => {
            const sorted = [...comparison.data].sort(
              (a, b) => b.composite - a.composite
            );
            const best = sorted[0];
            const second = sorted[1];
            if (best.composite === second.composite) return null;
            return (
              <div className="rounded-xl bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-800 p-4 text-center">
                <p className="text-emerald-700 dark:text-emerald-400 font-medium">
                  <span className="font-bold">{best.skill_name}</span> scores{" "}
                  {Math.round((best.composite - second.composite) * 100)} percentage
                  points higher overall
                </p>
              </div>
            );
          })()}
        </>
      )}

      {comparison.isLoading && (
        <div className="flex items-center justify-center h-32">
          <p className="text-slate-400 animate-pulse">Loading comparison...</p>
        </div>
      )}
    </div>
  );
}
