import {
  Radar,
  RadarChart as ReRadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface ScoreSet {
  label: string;
  correctness: number | null;
  consistency: number;
  robustness: number;
  latency: number;
  color: string;
}

interface Props {
  scores: ScoreSet[];
}

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444"];

export default function SkillRadarChart({ scores }: Props) {
  const dims = ["Correctness", "Consistency", "Robustness", "Latency"];
  const data = dims.map((dim) => {
    const entry: Record<string, unknown> = { dimension: dim };
    scores.forEach((s) => {
      const key = dim.toLowerCase() as keyof ScoreSet;
      const val = s[key];
      entry[s.label] = typeof val === "number" ? Math.round(val * 100) : 0;
    });
    return entry;
  });

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ReRadarChart data={data}>
        <PolarGrid stroke="#475569" />
        <PolarAngleAxis
          dataKey="dimension"
          tick={{ fill: "#94a3b8", fontSize: 12 }}
        />
        <PolarRadiusAxis
          angle={90}
          domain={[0, 100]}
          tick={{ fill: "#64748b", fontSize: 10 }}
        />
        {scores.map((s, i) => (
          <Radar
            key={s.label}
            name={s.label}
            dataKey={s.label}
            stroke={s.color || COLORS[i % COLORS.length]}
            fill={s.color || COLORS[i % COLORS.length]}
            fillOpacity={0.15}
          />
        ))}
        {scores.length > 1 && <Legend />}
      </ReRadarChart>
    </ResponsiveContainer>
  );
}
