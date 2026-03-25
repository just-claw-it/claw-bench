import { pct, scoreBg } from "../types";

interface Props {
  score: number;
  label?: string;
  showPct?: boolean;
}

export default function ScoreBar({ score, label, showPct = true }: Props) {
  const clampedScore = Math.max(0, Math.min(1, score));
  return (
    <div className="flex items-center gap-3">
      {label && (
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400 w-24 shrink-0">
          {label}
        </span>
      )}
      <div className="flex-1 h-2.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${scoreBg(score)}`}
          style={{ width: `${clampedScore * 100}%` }}
        />
      </div>
      {showPct && (
        <span className="text-xs font-mono font-medium text-slate-600 dark:text-slate-300 w-10 text-right">
          {pct(score)}
        </span>
      )}
    </div>
  );
}
