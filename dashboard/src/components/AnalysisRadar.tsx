import {
  Radar,
  RadarChart as ReRadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface Props {
  staticScores: {
    docQuality: number;
    completeness: number;
    security: number;
    codeQuality: number | null;
    maintainability: number;
  };
  llmScores?: {
    clarity: number;
    usefulness: number;
    safety: number;
    completeness: number;
  } | null;
}

export default function AnalysisRadar({ staticScores, llmScores }: Props) {
  const dims = [
    { key: "docQuality", label: "Doc Quality", staticVal: staticScores.docQuality, llmKey: null },
    { key: "completeness", label: "Completeness", staticVal: staticScores.completeness, llmKey: "completeness" as const },
    { key: "security", label: "Security", staticVal: staticScores.security, llmKey: "safety" as const },
    { key: "codeQuality", label: "Code Quality", staticVal: staticScores.codeQuality ?? 0, llmKey: null },
    { key: "maintainability", label: "Maintainability", staticVal: staticScores.maintainability, llmKey: null },
    ...(llmScores
      ? [
          { key: "clarity", label: "Clarity", staticVal: 0, llmKey: "clarity" as const },
          { key: "usefulness", label: "Usefulness", staticVal: 0, llmKey: "usefulness" as const },
        ]
      : []),
  ];

  const data = dims.map((d) => ({
    dimension: d.label,
    Static: Math.round(d.staticVal * 100),
    ...(llmScores && d.llmKey ? { LLM: Math.round(llmScores[d.llmKey] * 100) } : {}),
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ReRadarChart data={data}>
        <PolarGrid stroke="#475569" />
        <PolarAngleAxis
          dataKey="dimension"
          tick={{ fill: "#94a3b8", fontSize: 11 }}
        />
        <PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fill: "#64748b", fontSize: 10 }} />
        <Radar
          name="Static"
          dataKey="Static"
          stroke="#3b82f6"
          fill="#3b82f6"
          fillOpacity={0.2}
        />
        {llmScores && (
          <Radar
            name="LLM"
            dataKey="LLM"
            stroke="#10b981"
            fill="#10b981"
            fillOpacity={0.2}
          />
        )}
        {llmScores && <Legend />}
      </ReRadarChart>
    </ResponsiveContainer>
  );
}
