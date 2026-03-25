import { useParams } from "react-router-dom";
import { useSkillDrift, useRuns } from "../api";
import { pct, scoreColor } from "../types";
import ScoreBar from "../components/ScoreBar";
import SkillRadarChart from "../components/RadarChart";
import DriftChart from "../components/DriftChart";
import RunsTable from "../components/RunsTable";

export default function SkillDetail() {
  const { name } = useParams<{ name: string }>();
  const decodedName = decodeURIComponent(name ?? "");
  const drift = useSkillDrift(decodedName);
  const runs = useRuns();

  const skillRuns = (runs.data?.runs ?? []).filter(
    (r) => r.skill_name === decodedName
  );
  const latestRun = skillRuns[0];

  if (drift.isLoading || runs.isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-slate-400 animate-pulse">Loading...</p>
      </div>
    );
  }

  if (!latestRun) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-slate-400">No data found for "{decodedName}"</p>
      </div>
    );
  }

  const d = drift.data;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
          {decodedName}
        </h2>
        <div className="flex items-center gap-3 mt-2">
          <span className="px-2 py-0.5 rounded-full text-xs bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
            {latestRun.skill_type}
          </span>
          <span
            className={`px-2 py-0.5 rounded-full text-xs ${
              latestRun.score_type === "authored"
                ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"
                : "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400"
            }`}
          >
            {latestRun.score_type}
          </span>
          <span className="text-sm text-slate-500">
            {skillRuns.length} run{skillRuns.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* Score summary + radar */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
          <div className="mb-6">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">
              Composite Score
            </p>
            <p className={`text-4xl font-bold mt-1 ${scoreColor(latestRun.composite)}`}>
              {pct(latestRun.composite)}
            </p>
          </div>
          <div className="space-y-3">
            {latestRun.score_correctness !== null && (
              <ScoreBar score={latestRun.score_correctness} label="Correctness" />
            )}
            <ScoreBar score={latestRun.score_consistency} label="Consistency" />
            <ScoreBar score={latestRun.score_robustness} label="Robustness" />
            <ScoreBar score={latestRun.score_latency} label="Latency" />
          </div>
        </div>

        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
            Dimension Radar
          </h3>
          <SkillRadarChart
            scores={[
              {
                label: decodedName,
                correctness: latestRun.score_correctness,
                consistency: latestRun.score_consistency,
                robustness: latestRun.score_robustness,
                latency: latestRun.score_latency,
                color: "#3b82f6",
              },
            ]}
          />
        </div>
      </div>

      {/* Drift chart */}
      {d && d.timeline.length > 1 && (
        <section>
          <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200 mb-4">
            Score Drift
          </h3>
          <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 shadow-sm">
            <DriftChart timeline={d.timeline} />
            {d.version_deltas.length > 0 && (
              <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800">
                <h4 className="text-xs font-semibold text-slate-500 uppercase mb-2">
                  Version Deltas
                </h4>
                <div className="space-y-1 text-sm">
                  {d.version_deltas.map((vd) => (
                    <div key={`${vd.from_version}-${vd.to_version}`} className="flex gap-2">
                      <span className="text-slate-500">
                        {vd.from_version} → {vd.to_version}
                      </span>
                      <span
                        className={
                          vd.composite_delta >= 0
                            ? "text-emerald-500"
                            : "text-red-500"
                        }
                      >
                        {vd.composite_delta >= 0 ? "+" : ""}
                        {vd.composite_delta}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Run history */}
      <section>
        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200 mb-4">
          Run History
        </h3>
        <RunsTable runs={skillRuns} compact />
      </section>
    </div>
  );
}
