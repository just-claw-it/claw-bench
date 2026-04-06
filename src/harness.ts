import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { BenchConfig, BenchJson, BenchSandboxMode, SkillManifest } from "./types.js";
import { mockWebhookPayload, mockCronTrigger, shapeInput } from "./harness-inputs.js";
import { invokeSkillEntrypoint, type RunResult } from "./skill-invoke.js";
import { runSkillDocker, runSkillSubprocess } from "./sandbox.js";

const SkillManifestSchema = z.object({
  name: z.string(),
  description: z.string(),
  type: z.enum(["linear", "webhook", "cron"]),
  entrypoint: z.string(),
  credentialVars: z.array(z.string()).optional(),
});

const BenchJsonSchema = z.object({
  skillName: z.string(),
  pairs: z.array(
    z.object({
      description: z.string(),
      input: z.record(z.unknown()),
      expectedOutput: z.record(z.unknown()),
    })
  ),
});

// ── Credential detection ───────────────────────────────────────────────────

const CREDENTIAL_ALLOWLIST = new Set([
  "NODE_ENV", "PORT", "HOST", "LOG_LEVEL", "DEBUG", "HOME", "PATH",
  "TMPDIR", "TMP", "TEMP", "USER", "SHELL", "PWD", "LANG", "TERM",
  "CI", "VERBOSE", "TIMEOUT", "MAX_RETRIES", "CONCURRENCY",
  "BENCH_EMBED_MODEL",
]);

const CREDENTIAL_SUFFIXES = [
  "_API_KEY", "_SECRET", "_TOKEN", "_PASSWORD", "_PRIVATE_KEY",
  "_ACCESS_KEY", "_AUTH_KEY", "_CLIENT_SECRET", "_SIGNING_KEY",
  "_WEBHOOK_SECRET", "_BEARER",
];

const CREDENTIAL_USAGE_PATTERNS = [
  /Authorization[^\n]*process\.env/i,
  /(?:apiKey|api_key|authToken|auth_token|bearerToken|bearer_token|clientSecret|client_secret)\s*[:=]\s*process\.env/i,
  /apiKey\s*:\s*process\.env\.[A-Z_]+/,
  /secret\s*:\s*process\.env\.[A-Z_]+/i,
  /password\s*:\s*process\.env\.[A-Z_]+/i,
];

function hasCredentialSuffix(name: string): boolean {
  const upper = name.toUpperCase();
  return CREDENTIAL_SUFFIXES.some((s) => upper.endsWith(s));
}

function extractEnvVarNames(src: string): string[] {
  return [...src.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]);
}

function scanFileForCredentials(src: string): boolean {
  if (CREDENTIAL_USAGE_PATTERNS.some((p) => p.test(src))) return true;
  return extractEnvVarNames(src).some(
    (name) => !CREDENTIAL_ALLOWLIST.has(name) && hasCredentialSuffix(name)
  );
}

export function requiresCredentials(
  skillDir: string,
  manifest?: SkillManifest
): boolean {
  if (manifest?.credentialVars !== undefined) {
    return manifest.credentialVars.length > 0;
  }
  const MAX_SCAN_DEPTH = 10;
  const scan = (dir: string, depth: number): boolean => {
    if (depth > MAX_SCAN_DEPTH) return false;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (scan(full, depth + 1)) return true;
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
        if (scanFileForCredentials(fs.readFileSync(full, "utf-8"))) return true;
      }
    }
    return false;
  };
  return scan(skillDir, 0);
}

// ── Manifest + bench.json loading ─────────────────────────────────────────

export function loadManifest(skillDir: string): SkillManifest {
  const p = path.join(skillDir, "skill.json");
  if (!fs.existsSync(p)) throw new Error(`No skill.json found in ${skillDir}`);
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  const result = SkillManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid skill.json in ${skillDir}: ${result.error.issues.map((i) => i.message).join(", ")}`
    );
  }
  return result.data;
}

export function loadBenchJson(skillDir: string): BenchJson | null {
  const p = path.join(skillDir, "bench.json");
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  const result = BenchJsonSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid bench.json in ${skillDir}: ${result.error.issues.map((i) => i.message).join(", ")}`
    );
  }
  return result.data;
}

// Re-export for tests and callers that imported mocks from harness.
export { mockWebhookPayload, mockCronTrigger, shapeInput };

// ── Skill executor ─────────────────────────────────────────────────────────

export type { RunResult };

function resolveSandbox(mode: BenchSandboxMode | undefined): BenchSandboxMode {
  return mode ?? "none";
}

export async function runSkill(
  skillDir: string,
  manifest: SkillManifest,
  input: Record<string, unknown>,
  sandbox?: BenchSandboxMode
): Promise<RunResult> {
  const mode = resolveSandbox(sandbox);
  if (mode === "subprocess") {
    return runSkillSubprocess(skillDir, manifest, input);
  }
  if (mode === "docker") {
    return runSkillDocker(skillDir, manifest, input);
  }
  return invokeSkillEntrypoint(skillDir, manifest, input);
}

// ── Synthetic malformed inputs ─────────────────────────────────────────────

export function syntheticMalformedInputs(
  _config: BenchConfig,
  type: SkillManifest["type"] = "linear"
): Record<string, unknown>[] {
  const base: Record<string, unknown>[] = [
    {},
    { input: null },
    { input: "" },
    { input: -1 },
    { input: Array(1000).fill("x").join("") },
    { input: { deeply: { nested: true } } },
    { "": "" },
  ];

  if (type === "webhook") {
    return [
      ...base,
      { headers: {}, body: {}, query: {}, params: {} },
      mockWebhookPayload({
        body: null as unknown as Record<string, unknown>,
      }) as unknown as Record<string, unknown>,
      mockWebhookPayload({ method: "INVALID" as "POST" }) as unknown as Record<string, unknown>,
      mockWebhookPayload({
        body: { payload: Array(5000).fill("x").join("") },
      }) as unknown as Record<string, unknown>,
    ];
  }

  if (type === "cron") {
    return [
      ...base,
      {
        scheduledTime: new Date().toISOString(),
        cronExpression: "not-a-cron",
        timezone: "UTC",
        jobName: "test",
      },
      { cronExpression: "0 9 * * *", timezone: "UTC", jobName: "test" },
      mockCronTrigger({ timezone: "Mars/Olympus" }) as unknown as Record<string, unknown>,
    ];
  }

  return base;
}

// ── Consistency run helper ─────────────────────────────────────────────────

export async function collectConsistencyOutputs(
  skillDir: string,
  manifest: SkillManifest,
  benchJson: BenchJson | null,
  config: BenchConfig
): Promise<string[]> {
  let input: Record<string, unknown>;
  if (benchJson?.pairs[0]?.input) {
    input = benchJson.pairs[0].input;
  } else if (manifest.type === "webhook") {
    input = mockWebhookPayload() as unknown as Record<string, unknown>;
  } else if (manifest.type === "cron") {
    input = mockCronTrigger() as unknown as Record<string, unknown>;
  } else {
    input = { input: "benchmark-consistency-probe" };
  }

  const runs = config.consistencyRuns;
  const sandbox = config.sandbox;
  const outputs: string[] = [];
  for (let i = 0; i < runs; i++) {
    const result = await runSkill(skillDir, manifest, input, sandbox);
    outputs.push(
      result.output !== null ? JSON.stringify(result.output) : result.error ?? "crash"
    );
  }
  return outputs;
}
