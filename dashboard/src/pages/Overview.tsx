import { useStats, useRuns, useSkills, useCatalog, useCatalogStats } from "../api";
import StatCard from "../components/StatCard";
import RunsTable from "../components/RunsTable";
import { pct, scoreColor } from "../types";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

export default function Overview() {
  const stats = useStats();
  const runs = useRuns();
  const skills = useSkills();
  const catalog = useCatalog({ page: 1, limit: 5, sort: "overall" });
  const catalogStats = useCatalogStats();

  if (stats.isLoading || runs.isLoading) {
    return <Loading />;
  }

  if (stats.error) {
    return <ErrorBox message="Could not connect to API. Is the server running?" />;
  }

  const s = stats.data!;
  const allRuns = runs.data?.runs ?? [];
  const recentRuns = allRuns.slice(0, 10);

  const histogram = buildHistogram(allRuns.map((r) => r.composite));

  const chCats = s.clawhubCatalogSkills ?? 0;
  const benchEmpty = s.totalRuns === 0 && allRuns.length === 0;

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

      {histogram.length > 0 && (
        <section>
          <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200 mb-4">
            Score Distribution
          </h3>
          <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 shadow-sm">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={histogram}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="bucket" tick={{ fill: "#94a3b8", fontSize: 11 }} />
                <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#1e293b",
                    border: "1px solid #334155",
                    borderRadius: 8,
                    color: "#e2e8f0",
                  }}
                />
                <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      {skills.data && skills.data.length > 0 && (
        <section>
          <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200 mb-4">
            Skills Leaderboard
          </h3>
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
                {skills.data.map((sk, i) => (
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
      {catalogStats.data && catalogStats.data.totalSkills > 0 && (
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
            <StatCard label="Catalog Skills" value={catalogStats.data.totalSkills} />
            <StatCard label="Analyzed" value={catalogStats.data.analyzedCount} />
            <StatCard
              label="Avg Score"
              value={catalogStats.data.analyzedCount > 0 ? pct(catalogStats.data.avgOverallComposite) : "--"}
            />
            <StatCard label="With Scripts" value={catalogStats.data.withScripts} />
          </div>
          {catalog.data?.skills && catalog.data.skills.length > 0 && (
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
                  {catalog.data.skills.map((sk, i) => (
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

function buildHistogram(composites: number[]) {
  const buckets = [
    { bucket: "0-20%", min: 0, max: 0.2, count: 0 },
    { bucket: "20-40%", min: 0.2, max: 0.4, count: 0 },
    { bucket: "40-60%", min: 0.4, max: 0.6, count: 0 },
    { bucket: "60-80%", min: 0.6, max: 0.8, count: 0 },
    { bucket: "80-100%", min: 0.8, max: 1.01, count: 0 },
  ];
  for (const c of composites) {
    const b = buckets.find((b) => c >= b.min && c < b.max);
    if (b) b.count++;
  }
  return buckets.map(({ bucket, count }) => ({ bucket, count }));
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
