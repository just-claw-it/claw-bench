import type { LlmModelBreakdown } from "../types";
import { pct } from "../types";

export function parseLlmModelsJson(raw: string | null | undefined): LlmModelBreakdown[] {
  if (raw == null || typeof raw !== "string") return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v as LlmModelBreakdown[];
  } catch {
    return [];
  }
}

function llmHoverTitle(models: LlmModelBreakdown[]): string {
  return models
    .map(
      (m) =>
        `${m.model}: ${pct(m.llm_composite)} (clarity ${pct(m.llm_clarity)}, useful ${pct(
          m.llm_usefulness
        )}, safety ${pct(m.llm_safety)}, complete ${pct(m.llm_completeness)})`
    )
    .join("\n");
}

interface LlmBreakdownInlineProps {
  llmComposite: number | null;
  llmModelCount: number | null | undefined;
  llmModelsJson: string | null | undefined;
  scoreClassName: string;
  /** If true, show a compact <details> list (table cells). */
  expandable?: boolean;
}

/**
 * Shows averaged LLM composite when the API aggregated multiple models; hover title + optional per-model list.
 */
export function LlmBreakdownInline({
  llmComposite,
  llmModelCount,
  llmModelsJson,
  scoreClassName,
  expandable = false,
}: LlmBreakdownInlineProps) {
  if (llmComposite == null) {
    return <span className="text-slate-400">--</span>;
  }

  const models = parseLlmModelsJson(llmModelsJson ?? null);
  const n = Math.max(llmModelCount ?? 0, models.length);
  const multi = n > 1;
  const title = multi && models.length > 0 ? llmHoverTitle(models) : undefined;

  return (
    <div className={expandable ? "min-w-[7rem]" : undefined}>
      <span className={scoreClassName} title={title}>
        {pct(llmComposite)}
        {multi ? (
          <span className="ml-1 text-[10px] font-normal text-slate-400 align-middle">
            avg×{n}
          </span>
        ) : null}
      </span>
      {multi && expandable && models.length > 0 ? (
        <details className="mt-1">
          <summary className="text-[10px] text-slate-400 cursor-pointer select-none hover:text-slate-500">
            Per model
          </summary>
          <ul className="mt-1 pl-3 text-[10px] text-slate-500 dark:text-slate-400 space-y-1 list-disc">
            {models.map((m) => (
              <li key={`${m.model}-${m.analyzed_at}`}>
                <span className="font-medium text-slate-600 dark:text-slate-300">{m.model}</span>
                {": "}
                <span className="tabular-nums">{pct(m.llm_composite)}</span>
                <span className="text-slate-400">
                  {" "}
                  (c {pct(m.llm_clarity)} · u {pct(m.llm_usefulness)} · s {pct(m.llm_safety)} · comp{" "}
                  {pct(m.llm_completeness)})
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
