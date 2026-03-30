/**
 * Renders `analysis_insights` JSON from clawhub_analysis (same shape as server ClawHubSourceInsights).
 */
interface SourceInsights {
  complexity?: string;
  scriptFiles?: number;
  totalLoc?: number;
  maxFileLoc?: number;
  primaryLanguage?: string | null;
  languageBreakdown?: Array<{ language: string; files: number }>;
  describedLanguages?: string[];
  undocumentedLanguages?: string[];
  missingFromCode?: string[];
  credentialHygiene?: {
    declaredCredentialVars: string[];
    observedCredentialVars: string[];
    undeclaredCredentialVars: string[];
    declaredButUnusedCredentialVars: string[];
    hasEnvExample: boolean;
    envExampleCoverage: number;
    hygieneScore: number;
    hygieneLevel: string;
  };
  securityFindings?: {
    filesScanned: number;
    dangerousMatches: number;
    secretMatches: number;
    exfiltrationMatches: number;
    flaggedFiles: string[];
    potentialDataLeakage: boolean;
  };
  llmAssistedAudit?: {
    alignment: number;
    security: number;
    privacy: number;
    leakageRisk: number;
    notes: string;
  };
}

export function parseAnalysisInsights(raw: string | null | undefined): SourceInsights | null {
  if (raw == null || raw === "") return null;
  try {
    return JSON.parse(raw) as SourceInsights;
  } catch {
    return null;
  }
}

function fmtMs(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${Math.round(n)} ms`;
}

export function PipelineTimingsCard(props: {
  extract_ms?: number | null;
  static_analysis_ms?: number | null;
  llm_ms?: number | null;
  file_stats_ms?: number | null;
  pipeline_ms?: number | null;
}) {
  const { extract_ms, static_analysis_ms, llm_ms, file_stats_ms, pipeline_ms } = props;
  const any =
    extract_ms != null ||
    static_analysis_ms != null ||
    llm_ms != null ||
    file_stats_ms != null ||
    pipeline_ms != null;
  if (!any) return null;

  const rows: [string, number | null | undefined][] = [
    ["Extract", extract_ms],
    ["Static analysis", static_analysis_ms],
    ["LLM", llm_ms],
    ["File stats", file_stats_ms],
    ["Pipeline (total)", pipeline_ms],
  ];

  return (
    <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">
        Pipeline timings
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 text-sm">
        {rows.map(([label, v]) => (
          <div key={label} className="rounded-lg bg-slate-50 dark:bg-slate-800/60 px-3 py-2">
            <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">{label}</p>
            <p className="font-mono text-slate-800 dark:text-slate-200 tabular-nums mt-0.5">
              {fmtMs(v ?? null)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChipList({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="text-xs text-slate-400">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((x) => (
        <span
          key={x}
          className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-mono"
        >
          {x}
        </span>
      ))}
    </div>
  );
}

export default function SourceInsightsPanel({
  insights,
  rawJson,
}: {
  insights: SourceInsights | null;
  rawJson?: string | null;
}) {
  if (!insights && !rawJson) return null;

  if (!insights) {
    return (
      <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Source insights</h3>
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-500">Raw JSON (parse failed)</summary>
          <pre className="mt-2 p-3 rounded bg-slate-50 dark:bg-slate-800 overflow-x-auto max-h-96 whitespace-pre-wrap font-mono text-slate-600 dark:text-slate-400">
            {rawJson ?? ""}
          </pre>
        </details>
      </div>
    );
  }

  const ch = insights.credentialHygiene;
  const sec = insights.securityFindings;
  const audit = insights.llmAssistedAudit;

  return (
    <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm space-y-6">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
        Source insights
      </h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div>
          <p className="text-[10px] font-medium text-slate-500 uppercase">Complexity</p>
          <p className="text-slate-800 dark:text-slate-200 capitalize">
            {insights.complexity ?? "—"}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-medium text-slate-500 uppercase">Script files</p>
          <p className="font-mono text-slate-800 dark:text-slate-200">
            {insights.scriptFiles ?? "—"}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-medium text-slate-500 uppercase">Total LOC</p>
          <p className="font-mono text-slate-800 dark:text-slate-200">
            {insights.totalLoc ?? "—"}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-medium text-slate-500 uppercase">Primary language</p>
          <p className="text-slate-800 dark:text-slate-200">
            {insights.primaryLanguage ?? "—"}
          </p>
        </div>
      </div>

      {insights.languageBreakdown && insights.languageBreakdown.length > 0 && (
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase mb-2">Language breakdown</p>
          <div className="overflow-x-auto">
            <table className="text-xs w-full border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th className="text-left py-1 pr-4 font-medium text-slate-500">Language</th>
                  <th className="text-right py-1 font-medium text-slate-500">Files</th>
                </tr>
              </thead>
              <tbody>
                {insights.languageBreakdown.map((row) => (
                  <tr key={row.language} className="border-b border-slate-100 dark:border-slate-800/80">
                    <td className="py-1 pr-4 font-mono text-slate-700 dark:text-slate-300">
                      {row.language}
                    </td>
                    <td className="py-1 text-right tabular-nums text-slate-600 dark:text-slate-400">
                      {row.files}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase mb-1">Described in SKILL.md</p>
          <ChipList items={insights.describedLanguages ?? []} empty="None" />
        </div>
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase mb-1">Undocumented in code</p>
          <ChipList items={insights.undocumentedLanguages ?? []} empty="None" />
        </div>
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase mb-1">Missing from code</p>
          <ChipList items={insights.missingFromCode ?? []} empty="None" />
        </div>
      </div>

      {ch && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-4 bg-slate-50/80 dark:bg-slate-800/40">
          <p className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">
            Credential hygiene
            <span
              className={`ml-2 px-1.5 py-0.5 rounded text-[10px] uppercase ${
                ch.hygieneLevel === "good"
                  ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300"
                  : ch.hygieneLevel === "warn"
                    ? "bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300"
                    : "bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300"
              }`}
            >
              {ch.hygieneLevel}
            </span>
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-400 mb-2">
            Score {Math.round((ch.hygieneScore ?? 0) * 100)}% · env example{" "}
            {ch.hasEnvExample ? "yes" : "no"} · coverage{" "}
            {Math.round((ch.envExampleCoverage ?? 0) * 100)}%
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
            <div>
              <span className="text-slate-500">Declared:</span>{" "}
              <span className="font-mono text-slate-700 dark:text-slate-300">
                {ch.declaredCredentialVars?.join(", ") || "—"}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Observed:</span>{" "}
              <span className="font-mono text-slate-700 dark:text-slate-300">
                {ch.observedCredentialVars?.join(", ") || "—"}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Undeclared:</span>{" "}
              <span className="font-mono text-amber-700 dark:text-amber-400">
                {ch.undeclaredCredentialVars?.join(", ") || "—"}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Unused declared:</span>{" "}
              <span className="font-mono text-slate-700 dark:text-slate-300">
                {ch.declaredButUnusedCredentialVars?.join(", ") || "—"}
              </span>
            </div>
          </div>
        </div>
      )}

      {sec && (
        <div>
          <p className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">
            Security scan (heuristic)
          </p>
          <div className="flex flex-wrap gap-3 text-xs text-slate-600 dark:text-slate-400">
            <span>Files scanned: {sec.filesScanned}</span>
            <span>Dangerous: {sec.dangerousMatches}</span>
            <span>Secrets: {sec.secretMatches}</span>
            <span>Exfiltration: {sec.exfiltrationMatches}</span>
            {sec.potentialDataLeakage ? (
              <span className="text-amber-600 dark:text-amber-400 font-medium">
                Potential data leakage flagged
              </span>
            ) : null}
          </div>
          {sec.flaggedFiles && sec.flaggedFiles.length > 0 && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-slate-500">Flagged files ({sec.flaggedFiles.length})</summary>
              <ul className="mt-1 pl-4 list-disc font-mono text-slate-500">
                {sec.flaggedFiles.slice(0, 40).map((f) => (
                  <li key={f}>{f}</li>
                ))}
                {sec.flaggedFiles.length > 40 ? (
                  <li className="text-slate-400">…and {sec.flaggedFiles.length - 40} more</li>
                ) : null}
              </ul>
            </details>
          )}
        </div>
      )}

      {audit && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-4">
          <p className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">
            LLM-assisted source audit
          </p>
          <div className="flex flex-wrap gap-3 text-xs mb-2">
            <span>Alignment {Math.round(audit.alignment * 100)}%</span>
            <span>Security {Math.round(audit.security * 100)}%</span>
            <span>Privacy {Math.round(audit.privacy * 100)}%</span>
            <span>Leakage risk {Math.round(audit.leakageRisk * 100)}%</span>
          </div>
          {audit.notes ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 italic whitespace-pre-wrap">
              {audit.notes}
            </p>
          ) : null}
        </div>
      )}

      {rawJson ? (
        <details className="text-xs border-t border-slate-200 dark:border-slate-700 pt-4">
          <summary className="cursor-pointer text-slate-500 select-none">Raw analysis_insights JSON</summary>
          <pre className="mt-2 p-3 rounded bg-slate-50 dark:bg-slate-800 overflow-x-auto max-h-64 font-mono text-slate-600 dark:text-slate-400">
            {rawJson.length > 120_000 ? `${rawJson.slice(0, 120_000)}\n… (truncated)` : rawJson}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

export function ImportedMetadataCard(props: {
  import_meta_recorded_at?: string | null;
  import_meta_author?: string | null;
  import_meta_verified_author?: number | null;
  import_meta_tags?: string | null;
  import_meta_star_rating?: number | null;
  import_meta_star_count?: number | null;
  import_meta_latest_version?: string | null;
  import_meta_total_versions?: number | null;
  import_meta_dependency_count?: number | null;
  import_meta_first_published_at?: string | null;
  import_meta_last_updated_at?: string | null;
}) {
  if (!props.import_meta_recorded_at) return null;

  let tags: string[] = [];
  try {
    tags = props.import_meta_tags ? (JSON.parse(props.import_meta_tags) as string[]) : [];
  } catch {
    tags = [];
  }

  return (
    <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">
        Imported metadata
      </h3>
      <p className="text-xs text-slate-500 mb-4">
        From <code className="text-[10px] bg-slate-100 dark:bg-slate-800 px-1 rounded">import-metadata</code>{" "}
        when <code className="text-[10px] bg-slate-100 dark:bg-slate-800 px-1 rounded">skill_name</code> matches
        this slug. Recorded {new Date(props.import_meta_recorded_at).toLocaleString()}.
      </p>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div>
          <dt className="text-[10px] uppercase text-slate-500">Author (import)</dt>
          <dd className="text-slate-800 dark:text-slate-200">{props.import_meta_author ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase text-slate-500">Verified author</dt>
          <dd className="text-slate-800 dark:text-slate-200">
            {props.import_meta_verified_author === 1 ? "Yes" : "No"}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase text-slate-500">Star rating / count</dt>
          <dd className="text-slate-800 dark:text-slate-200">
            {props.import_meta_star_rating != null
              ? `${props.import_meta_star_rating.toFixed(1)} / ${props.import_meta_star_count ?? 0}`
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase text-slate-500">Versions</dt>
          <dd className="text-slate-800 dark:text-slate-200">
            {props.import_meta_latest_version ?? "—"} ({props.import_meta_total_versions ?? 0} total)
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase text-slate-500">Dependencies</dt>
          <dd className="text-slate-800 dark:text-slate-200">{props.import_meta_dependency_count ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase text-slate-500">Published / updated</dt>
          <dd className="text-slate-800 dark:text-slate-200 text-xs">
            {props.import_meta_first_published_at ?? "—"} → {props.import_meta_last_updated_at ?? "—"}
          </dd>
        </div>
      </dl>
      {tags.length > 0 && (
        <div className="mt-3">
          <p className="text-[10px] uppercase text-slate-500 mb-1">Tags</p>
          <div className="flex flex-wrap gap-1">
            {tags.map((t) => (
              <span
                key={t}
                className="px-1.5 py-0.5 rounded text-[10px] bg-indigo-100 dark:bg-indigo-900/40 text-indigo-800 dark:text-indigo-200"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
