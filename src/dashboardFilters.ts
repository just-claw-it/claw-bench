/**
 * Hide local example runs (e.g. examples/echo-skill) from dashboard API responses when
 * NODE_ENV=production. Set CLAW_BENCH_SHOW_TEST_RUNS=1 to include them.
 */

export function hideExampleRunsFromDashboard(): boolean {
  if (process.env.CLAW_BENCH_SHOW_TEST_RUNS === "1") return false;
  return process.env.NODE_ENV === "production";
}

export function isTestRunRow(row: { skill_name: string; skill_path: string }): boolean {
  const norm = row.skill_path.toLowerCase().replace(/\\/g, "/");
  return row.skill_name === "echo-skill" || norm.includes("examples/echo-skill");
}

/** SQL fragment: ` AND NOT (...)` — empty when example runs should be visible. */
export function runsVisibilitySql(alias = ""): string {
  if (!hideExampleRunsFromDashboard()) return "";
  const p = alias ? `${alias}.` : "";
  return ` AND NOT (${p}skill_name = 'echo-skill' OR INSTR(LOWER(REPLACE(${p}skill_path, CHAR(92), '/')), 'examples/echo-skill') > 0)`;
}
