import { useParams } from "react-router-dom";
import { useCatalogSkill } from "../api";
import { type SkillAnalysisDetail, pct, scoreColor } from "../types";
import ScoreBar from "../components/ScoreBar";
import AnalysisRadar from "../components/AnalysisRadar";
import StatCard from "../components/StatCard";

export default function SkillAnalysis() {
  const { slug } = useParams<{ slug: string }>();
  const { data, isLoading, error } = useCatalogSkill(slug ?? "");

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-slate-400 animate-pulse">Loading...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-slate-400">Skill not found</p>
      </div>
    );
  }

  const skill = data as SkillAnalysisDetail;
  const hasLLM = skill.llm_composite != null;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
            {skill.name}
          </h2>
          <span className="text-sm text-slate-400">{skill.version}</span>
        </div>
        <div className="flex items-center gap-3 mt-2">
          <span className="text-sm text-slate-500 dark:text-slate-400">
            @{skill.author}
          </span>
          <a
            href={`https://clawhub.ai/${skill.author}/${skill.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-500 hover:underline"
          >
            View on ClawHub
          </a>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard label="Downloads" value={skill.downloads} />
        <StatCard label="Stars" value={skill.stars} />
        <StatCard label="Versions" value={skill.version_count} />
        <StatCard label="Files" value={skill.file_count} />
        <StatCard
          label="Size"
          value={
            skill.total_size_bytes > 1024
              ? `${Math.round(skill.total_size_bytes / 1024)}KB`
              : `${skill.total_size_bytes}B`
          }
        />
        <StatCard
          label="Scripts"
          value={skill.has_scripts ? "Yes" : "No"}
        />
      </div>

      {/* Overall Score */}
      {skill.overall_composite != null && (
        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">
                Overall Composite Score
              </p>
              <p className={`text-5xl font-bold mt-2 ${scoreColor(skill.overall_composite)}`}>
                {pct(skill.overall_composite)}
              </p>
              <p className="text-xs text-slate-400 mt-2">
                {hasLLM ? "60% static + 40% LLM" : "100% static analysis"}
              </p>
            </div>
            {skill.analyzed_at && (
              <p className="text-xs text-slate-400">
                Analyzed: {new Date(skill.analyzed_at).toLocaleDateString()}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Analysis Charts + Bars */}
      {skill.static_composite != null && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Static Analysis */}
          <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">
              Static Analysis
              <span className={`ml-3 text-lg font-bold ${scoreColor(skill.static_composite)}`}>
                {pct(skill.static_composite)}
              </span>
            </h3>
            <div className="space-y-3">
              {skill.doc_quality != null && (
                <ScoreBar score={skill.doc_quality} label="Doc Quality" />
              )}
              {skill.completeness_score != null && (
                <ScoreBar score={skill.completeness_score} label="Completeness" />
              )}
              {skill.security != null && (
                <ScoreBar score={skill.security} label="Security" />
              )}
              {skill.code_quality != null && (
                <ScoreBar score={skill.code_quality} label="Code Quality" />
              )}
              {skill.maintainability != null && (
                <ScoreBar score={skill.maintainability} label="Maintainability" />
              )}
            </div>
          </div>

          {/* LLM Evaluation or Radar */}
          {hasLLM ? (
            <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">
                LLM Evaluation
                <span className={`ml-3 text-lg font-bold ${scoreColor(skill.llm_composite!)}`}>
                  {pct(skill.llm_composite!)}
                </span>
              </h3>
              <div className="space-y-3">
                {skill.llm_clarity != null && (
                  <ScoreBar score={skill.llm_clarity} label="Clarity" />
                )}
                {skill.llm_usefulness != null && (
                  <ScoreBar score={skill.llm_usefulness} label="Usefulness" />
                )}
                {skill.llm_safety != null && (
                  <ScoreBar score={skill.llm_safety} label="Safety" />
                )}
                {skill.llm_completeness != null && (
                  <ScoreBar score={skill.llm_completeness} label="Completeness" />
                )}
              </div>
              {skill.llm_reasoning && (
                <p className="mt-4 text-xs text-slate-500 dark:text-slate-400 italic border-t border-slate-200 dark:border-slate-700 pt-3">
                  {skill.llm_reasoning}
                </p>
              )}
              {skill.llm_model && (
                <p className="mt-2 text-[10px] text-slate-400">Model: {skill.llm_model}</p>
              )}
            </div>
          ) : (
            <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                Dimension Radar
              </h3>
              <AnalysisRadar
                staticScores={{
                  docQuality: skill.doc_quality ?? 0,
                  completeness: skill.completeness_score ?? 0,
                  security: skill.security ?? 0,
                  codeQuality: skill.code_quality,
                  maintainability: skill.maintainability ?? 0,
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* Radar when both static + LLM are present */}
      {hasLLM && skill.static_composite != null && (
        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
            Static vs LLM Radar
          </h3>
          <AnalysisRadar
            staticScores={{
              docQuality: skill.doc_quality ?? 0,
              completeness: skill.completeness_score ?? 0,
              security: skill.security ?? 0,
              codeQuality: skill.code_quality,
              maintainability: skill.maintainability ?? 0,
            }}
            llmScores={{
              clarity: skill.llm_clarity ?? 0,
              usefulness: skill.llm_usefulness ?? 0,
              safety: skill.llm_safety ?? 0,
              completeness: skill.llm_completeness ?? 0,
            }}
          />
        </div>
      )}

      {/* SKILL.md preview */}
      {skill.skill_md_content && (
        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">
            SKILL.md Preview
          </h3>
          <pre className="text-xs text-slate-600 dark:text-slate-400 whitespace-pre-wrap max-h-96 overflow-y-auto font-mono bg-slate-50 dark:bg-slate-800 p-4 rounded-lg">
            {skill.skill_md_content.slice(0, 5000)}
            {skill.skill_md_content.length > 5000 && "\n\n... (truncated)"}
          </pre>
        </div>
      )}

      {/* File tree */}
      {skill.files && skill.files.length > 0 && (
        <div className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">
            Files ({skill.files.length})
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1">
            {skill.files.map((f) => (
              <div
                key={f}
                className="text-xs text-slate-600 dark:text-slate-400 font-mono py-0.5 truncate"
                title={f}
              >
                {f}
              </div>
            ))}
          </div>
        </div>
      )}

      {!skill.analyzed && (
        <div className="text-center py-8 text-slate-400">
          <p className="text-lg">Not yet analyzed</p>
          <p className="text-sm mt-2">
            Run{" "}
            <code className="bg-slate-800 px-2 py-0.5 rounded text-slate-300">
              claw-bench clawhub analyze {skill.slug}
            </code>{" "}
            to generate analysis scores.
          </p>
        </div>
      )}
    </div>
  );
}
