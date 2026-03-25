import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import type { DriftPoint } from "../types";

interface Props {
  timeline: DriftPoint[];
}

export default function DriftChart({ timeline }: Props) {
  const data = timeline.map((p) => ({
    date: p.benchmarked_at.slice(0, 10),
    version: p.skill_version ?? "",
    Composite: Math.round(p.composite * 100),
    Consistency: Math.round(p.score_consistency * 100),
    Robustness: Math.round(p.score_robustness * 100),
    Latency: Math.round(p.score_latency * 100),
    Correctness:
      p.score_correctness !== null
        ? Math.round(p.score_correctness * 100)
        : null,
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
        <XAxis dataKey="date" tick={{ fill: "#94a3b8", fontSize: 11 }} />
        <YAxis
          domain={[0, 100]}
          tick={{ fill: "#94a3b8", fontSize: 11 }}
          tickFormatter={(v) => `${v}%`}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "#1e293b",
            border: "1px solid #334155",
            borderRadius: 8,
            color: "#e2e8f0",
          }}
          formatter={(v: number) => `${v}%`}
        />
        <Legend />
        <Line
          type="monotone"
          dataKey="Composite"
          stroke="#3b82f6"
          strokeWidth={2}
          dot={{ r: 3 }}
        />
        <Line
          type="monotone"
          dataKey="Consistency"
          stroke="#10b981"
          strokeWidth={1}
          strokeDasharray="4 2"
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="Robustness"
          stroke="#f59e0b"
          strokeWidth={1}
          strokeDasharray="4 2"
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="Latency"
          stroke="#8b5cf6"
          strokeWidth={1}
          strokeDasharray="4 2"
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
