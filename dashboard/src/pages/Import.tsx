import { useState } from "react";
import { useImportReport } from "../api";
import FileDropZone from "../components/FileDropZone";

interface ImportResult {
  name: string;
  success: boolean;
  error?: string;
}

export default function Import() {
  const importMutation = useImportReport();
  const [results, setResults] = useState<ImportResult[]>([]);
  const [pending, setPending] = useState<unknown[]>([]);

  const handleFiles = (reports: unknown[]) => {
    setPending(reports);
    setResults([]);
  };

  const handleImport = async () => {
    const newResults: ImportResult[] = [];
    for (const report of pending) {
      const name = (report as { skillName?: string }).skillName ?? "unknown";
      try {
        await importMutation.mutateAsync(report);
        newResults.push({ name, success: true });
      } catch (err) {
        newResults.push({
          name,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    setResults(newResults);
    setPending([]);
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
          Import Reports
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Import benchmark-report.json files into the database
        </p>
      </div>

      <FileDropZone onFilesAccepted={handleFiles} />

      {/* Pending preview */}
      {pending.length > 0 && (
        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">
            Ready to import ({pending.length} report{pending.length !== 1 ? "s" : ""})
          </h3>
          <ul className="space-y-2 mb-4">
            {pending.map((r, i) => {
              const report = r as {
                skillName?: string;
                scoreType?: string;
                score?: { composite?: number };
              };
              return (
                <li
                  key={i}
                  className="flex items-center gap-3 text-sm text-slate-600 dark:text-slate-400"
                >
                  <span className="w-2 h-2 rounded-full bg-blue-500" />
                  <span className="font-medium text-slate-800 dark:text-slate-200">
                    {report.skillName ?? "unknown"}
                  </span>
                  {report.score?.composite !== undefined && (
                    <span className="text-xs text-slate-400">
                      {Math.round(report.score.composite * 100)}%
                    </span>
                  )}
                  <span className="text-xs text-slate-400">
                    {report.scoreType}
                  </span>
                </li>
              );
            })}
          </ul>
          <button
            onClick={handleImport}
            disabled={importMutation.isPending}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {importMutation.isPending ? "Importing..." : "Import All"}
          </button>
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">
            Import Results
          </h3>
          <ul className="space-y-2">
            {results.map((r, i) => (
              <li
                key={i}
                className={`flex items-center gap-2 text-sm ${
                  r.success ? "text-emerald-600" : "text-red-500"
                }`}
              >
                <span>{r.success ? "✓" : "✗"}</span>
                <span className="font-medium">{r.name}</span>
                {r.error && (
                  <span className="text-xs text-slate-400">— {r.error}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
