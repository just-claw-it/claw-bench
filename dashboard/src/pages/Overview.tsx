import { lazy, Suspense } from "react";
import { useDashboardOverview } from "../api";
import StatCard from "../components/StatCard";
import RunsTable from "../components/RunsTable";
import { pct, scoreColor, type Skill, type CatalogSkill } from "../types";

const OverviewScoreChart = lazy(() => import("../components/OverviewScoreChart"));

export default function Overview() {
  const overview = useDashboardOverview();

  if (overview.isLoading) {
    return <Loading />;
  }

  if (overview.error) {
    return <ErrorBox message="Could not connect to API. Is the server running?" />;
  }

  const s = overview.data!.stats;
  const recentRuns = overview.data!.runs.recent;
  const histogram = overview.data!.scoreHistogram;

  const chCats = s.clawhubCatalogSkills ?? 0;
  const benchEmpty = s.totalRuns === 0 && overview.data!.runs.total === 0;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
          Overview
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Benchmark results at a glance
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-500 mt-2 font-mono break-all">
          DB: {s.dbPath}
        </p>
      </div>

      {benchEmpty && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-900 dark:text-amber-100/90">
          <strong className="font-semibold">No benchmark runs yet.</strong> The cards above count
          scored runs (import a <code className="text-xs bg-amber-100 dark:bg-amber-900/50 px-1 rounded">benchmark-report.json</code> on{" "}
          <a href="/import" className="underline">Import</a>
          , or run <code className="text-xs bg-amber-100 dark:bg-amber-900/50 px-1 rounded">claw-bench run …</code>
          ).{chCats > 0 ? (
            <>
              {" "}
              Your ClawHub catalog has <strong>{chCats.toLocaleString()}</strong> skills — open{" "}
              <a href="/catalog" className="underline">Catalog</a> to browse them (separate from benchmarks).
            </>
          ) : (
            <>
              {" "}
              Run <code className="text-xs bg-amber-100 dark:bg-amber-900/50 px-1 rounded">claw-bench clawhub crawl --seed-only</code> (same CLI and{" "}
              <code className="text-xs bg-amber-100 dark:bg-amber-900/50 px-1 rounded">CLAW_BENCH_DB</code> as this server) if the catalog looks empty.
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Runs" value={s.totalRuns} />
        <StatCard label="Skills" value={s.totalSkills} />
        <StatCard
          label="Avg Score"
          value={s.totalRuns > 0 ? pct(s.avgComposite) : "—"}
        />
        <StatCard
          label="Last Run"
          value={s.lastRunAt ? timeAgo(s.lastRunAt) : "Never"}
          sub={s.lastRunAt?.slice(0, 10)}
        />
      </div>

      {histogram.some((h) => h.count > 0) && (
        <section>
          <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200 mb-4">
            Score Distribution
          </h3>
          <Suspense
            fallback={
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 h-[220px] animate-pulse bg-slate-100 dark:bg-slate-800/50" />
            }
          >
            <OverviewScoreChart histogram={histogram} />
          </Suspense>
        </section>
      )}

      {overview.data!.skills.length > 0 && (
        <section>
          <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
            Skills Leaderboard
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
            Top {overview.data!.skills.length} skills by latest score (preview; full aggregation is heavier).
          </p>
          <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 dark:bg-slate-800/50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">#</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">Skill</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">Type</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">Score</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">Runs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {overview.data!.skills.map((sk: Skill, i: number) => (
                  <tr key={sk.skill_name} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="px-4 py-2 text-slate-400 font-mono text-xs">{i + 1}</td>
                    <td className="px-4 py-2">
                      <a
                        href={`/skills/${encodeURIComponent(sk.skill_name)}`}
                        className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                      >
                        {sk.skill_name}
                      </a>
                    </td>
                    <td className="px-4 py-2">
                      <span className="px-2 py-0.5 rounded-full text-xs bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                        {sk.skill_type}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono font-semibold">
                      {pct(sk.latest_composite)}
                    </td>
                    <td className="px-4 py-2 text-slate-500">{sk.run_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ClawHub Catalog section */}
      {overview.data!.catalogStats.totalSkills > 0 && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
              ClawHub Catalog
            </h3>
            <a
              href="/catalog"
              className="text-sm text-blue-500 hover:underline"
            >
              View all
            </a>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <StatCard label="Catalog Skills" value={overview.data!.catalogStats.totalSkills} />
            <StatCard label="Analyzed" value={overview.data!.catalogStats.analyzedCount} />
            <StatCard
              label="Avg Score"
              value={overview.data!.catalogStats.analyzedCount > 0 ? pct(overview.data!.catalogStats.avgOverallComposite) : "--"}
            />
            <StatCard label="With Scripts" value={overview.data!.catalogStats.withScripts} />
          </div>
          {overview.data!.catalogPeek.skills.length > 0 && (
            <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 dark:bg-slate-800/50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">#</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">Skill</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">Author</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-slate-500 uppercase">Score</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {overview.data!.catalogPeek.skills.map((sk: CatalogSkill, i: number) => (
                    <tr key={sk.slug} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="px-4 py-2 text-slate-400 font-mono text-xs">{i + 1}</td>
                      <td className="px-4 py-2">
                        <a
                          href={`/catalog/${encodeURIComponent(sk.slug)}`}
                          className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                        >
                          {sk.name}
                        </a>
                      </td>
                      <td className="px-4 py-2 text-slate-500">@{sk.author}</td>
                      <td className="px-4 py-2 font-mono font-semibold">
                        {sk.overall_composite != null ? (
                          <span className={scoreColor(sk.overall_composite)}>{pct(sk.overall_composite)}</span>
                        ) : (
                          <span className="text-slate-400">--</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {recentRuns.length > 0 && (
        <section>
          <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200 mb-4">
            Recent Runs
          </h3>
          <RunsTable runs={recentRuns} compact />
        </section>
      )}
    </div>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function Loading() {
  return (
    <div className="flex items-center justify-center h-64">
      <p className="text-slate-400 animate-pulse">Loading...</p>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="text-center">
        <p className="text-red-500 font-medium">Connection Error</p>
        <p className="text-sm text-slate-400 mt-2">{message}</p>
      </div>
    </div>
  );
}
