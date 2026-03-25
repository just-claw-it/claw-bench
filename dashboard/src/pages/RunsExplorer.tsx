import { useRuns } from "../api";
import RunsTable from "../components/RunsTable";

export default function RunsExplorer() {
  const { data, isLoading, error } = useRuns();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
          Runs Explorer
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Browse, search, and filter all benchmark runs
        </p>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center h-64">
          <p className="text-slate-400 animate-pulse">Loading...</p>
        </div>
      )}

      {error && (
        <p className="text-red-500">Failed to load runs: {String(error)}</p>
      )}

      {data && <RunsTable runs={data.runs} />}
    </div>
  );
}
