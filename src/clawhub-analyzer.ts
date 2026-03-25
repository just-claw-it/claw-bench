/**
 * clawhub-analyzer.ts — Static analysis and LLM evaluation for ClawHub skills.
 *
 * Static analysis checks documentation quality, completeness, security,
 * code quality, and maintainability. LLM evaluation scores SKILL.md via
 * Anthropic, Ollama, or an OpenAI-compatible API (`CLAWHUB_LLM_PROVIDER`).
 */

import * as fs from "fs";
import * as path from "path";
import {
  StaticAnalysisResult,
  LLMEvalResult,
  ClawHubAnalysis,
  ClawHubSkillEntry,
} from "./types.js";
import { collectFileStats } from "./clawhub.js";

// ── YAML frontmatter parsing ───────────────────────────────────────────────

interface SkillFrontmatter {
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

function parseFrontmatter(md: string): { data: SkillFrontmatter; content: string } {
  const match = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { data: {}, content: md };

  const yamlBlock = match[1];
  const content = match[2];
  const data: SkillFrontmatter = {};

  for (const line of yamlBlock.split("\n")) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (kv) {
      const key = kv[1];
      let val: string | boolean | number = kv[2].trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      data[key] = val;
    }
  }

  return { data, content };
}

// ── Documentation Quality (0–1) ────────────────────────────────────────────

export function analyzeDocQuality(skillDir: string): number {
  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) return 0;

  const raw = fs.readFileSync(skillMdPath, "utf-8");
  const { data, content } = parseFrontmatter(raw);
  let score = 0;
  const maxPoints = 10;

  // YAML frontmatter with name
  if (data.name) score += 1;
  // YAML frontmatter with description
  if (data.description) score += 1;

  // Adequate length (>200 chars of content)
  if (content.length > 200) score += 1;
  if (content.length > 1000) score += 0.5;

  // Has section headers (## headings)
  const headers = content.match(/^#{1,3}\s+.+$/gm) ?? [];
  if (headers.length >= 2) score += 1;
  if (headers.length >= 4) score += 0.5;

  // Has code examples (``` blocks)
  const codeBlocks = content.match(/```[\s\S]*?```/g) ?? [];
  if (codeBlocks.length >= 1) score += 1;
  if (codeBlocks.length >= 3) score += 0.5;

  // Has usage or installation section
  const lowerContent = content.toLowerCase();
  if (lowerContent.includes("## usage") || lowerContent.includes("## how to use")) score += 1;
  if (lowerContent.includes("## install") || lowerContent.includes("installation")) score += 1;

  // Has examples section or reference to examples
  if (lowerContent.includes("example") || lowerContent.includes("## quick")) score += 0.5;

  // Has table (pipe syntax)
  if (content.includes("|") && content.includes("---")) score += 0.5;

  return Math.min(score / maxPoints, 1);
}

// ── Completeness (0–1) ─────────────────────────────────────────────────────

export function analyzeCompleteness(
  skillDir: string,
  entry?: ClawHubSkillEntry
): number {
  let score = 0;
  const maxPoints = 6;

  // Has SKILL.md
  if (fs.existsSync(path.join(skillDir, "SKILL.md"))) score += 2;

  // Has _meta.json
  if (fs.existsSync(path.join(skillDir, "_meta.json"))) score += 1;

  // Proper semver version
  if (entry?.version) {
    const semverish = /^v?\d+\.\d+\.\d+/.test(entry.version);
    if (semverish) score += 1;
  }

  // Has scripts/hooks if referenced in SKILL.md
  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (fs.existsSync(skillMdPath)) {
    const content = fs.readFileSync(skillMdPath, "utf-8");
    const referencesScripts = /scripts\/|hooks\/|\.sh|\.py|\.js/.test(content);
    if (referencesScripts) {
      const hasScriptDir = fs.existsSync(path.join(skillDir, "scripts")) ||
        fs.existsSync(path.join(skillDir, "hooks"));
      score += hasScriptDir ? 1 : 0;
    } else {
      score += 1;
    }
  }

  // Has references or assets
  const hasExtras = fs.existsSync(path.join(skillDir, "references")) ||
    fs.existsSync(path.join(skillDir, "assets"));
  if (hasExtras) score += 0.5;

  // Multiple file types suggest completeness
  const stats = collectFileStats(skillDir);
  if (stats.languages.length >= 2) score += 0.5;

  return Math.min(score / maxPoints, 1);
}

// ── Security (0–1) ─────────────────────────────────────────────────────────

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\/(?!\w)/,
  /sudo\s+/,
  /curl\s+.*\|\s*(?:bash|sh|zsh)/,
  /wget\s+.*\|\s*(?:bash|sh|zsh)/,
  /eval\s*\(/,
  /exec\s*\(/,
  /Function\s*\(/,
  /child_process/,
  /\.exec\s*\(/,
];

const SECRET_PATTERNS = [
  /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9+/=]{20,}["']/i,
  /(?:AKIA|AIza|sk-)[A-Za-z0-9]{20,}/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
];

const EXFILTRATION_PATTERNS = [
  /fetch\s*\(\s*["']https?:\/\/(?!api\.|www\.|github\.com)/,
  /XMLHttpRequest/,
  /navigator\.sendBeacon/,
];

export function analyzeSecurity(skillDir: string): number {
  let issues = 0;
  let filesScanned = 0;
  const scanExtensions = new Set([".sh", ".py", ".js", ".ts", ".rb", ".pl", ".md"]);

  const walk = (dir: string, depth = 0) => {
    if (depth > 10) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (!scanExtensions.has(ext)) continue;
        filesScanned++;
        const content = fs.readFileSync(full, "utf-8");

        for (const pattern of DANGEROUS_PATTERNS) {
          if (pattern.test(content)) issues++;
        }
        for (const pattern of SECRET_PATTERNS) {
          if (pattern.test(content)) issues += 2;
        }
        for (const pattern of EXFILTRATION_PATTERNS) {
          if (pattern.test(content)) issues++;
        }
      }
    }
  };

  walk(skillDir);

  if (filesScanned === 0) return 1.0;
  // Deduct 0.15 per issue, floor at 0
  return Math.max(0, 1 - issues * 0.15);
}

// ── Code Quality (0–1 or null) ─────────────────────────────────────────────

export function analyzeCodeQuality(skillDir: string): number | null {
  const scriptFiles: string[] = [];
  const scriptExtensions = new Set([".sh", ".py", ".js", ".ts"]);

  const walk = (dir: string, depth = 0) => {
    if (depth > 10) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (scriptExtensions.has(ext)) scriptFiles.push(full);
      }
    }
  };

  walk(skillDir);
  if (scriptFiles.length === 0) return null;

  let score = 0;
  const maxPoints = 6;

  for (const file of scriptFiles) {
    const content = fs.readFileSync(file, "utf-8");
    const ext = path.extname(file).toLowerCase();

    // Shebang for shell scripts
    if (ext === ".sh" && content.startsWith("#!")) score += 0.5;

    // Error handling
    if (ext === ".py" && /try\s*:/.test(content)) score += 0.5;
    if (ext === ".js" || ext === ".ts") {
      if (/try\s*\{/.test(content) || /\.catch\s*\(/.test(content)) score += 0.5;
    }
    if (ext === ".sh") {
      if (/set\s+-e/.test(content) || /\|\|\s*{/.test(content)) score += 0.5;
    }

    // Has comments
    if (/^[#\/].*\w/m.test(content)) score += 0.3;

    // Reasonable length (not too short, not bloated)
    if (content.length > 50 && content.length < 50000) score += 0.3;
  }

  // Has --help or usage
  const allContent = scriptFiles.map((f) => fs.readFileSync(f, "utf-8")).join("\n");
  if (/--help|argparse|ArgumentParser|usage|commander/i.test(allContent)) score += 1;

  // Clean structure (files in scripts/ or hooks/ rather than root)
  const hasStructuredDirs = fs.existsSync(path.join(skillDir, "scripts")) ||
    fs.existsSync(path.join(skillDir, "hooks"));
  if (hasStructuredDirs) score += 0.5;

  return Math.min(score / maxPoints, 1);
}

// ── Maintainability (0–1) ──────────────────────────────────────────────────

export function analyzeMaintainability(
  skillDir: string,
  entry?: ClawHubSkillEntry
): number {
  let score = 0;
  const maxPoints = 5;

  // Multiple versions indicate active maintenance
  const versionCount = entry?.versionCount ?? 1;
  if (versionCount >= 2) score += 1;
  if (versionCount >= 5) score += 0.5;
  if (versionCount >= 10) score += 0.5;

  // Reasonable file count (not bloated)
  const stats = collectFileStats(skillDir);
  if (stats.fileCount >= 2 && stats.fileCount <= 50) score += 1;
  else if (stats.fileCount === 1) score += 0.5;

  // Clean directory structure
  const entries = fs.readdirSync(skillDir);
  const hasCleanRoot = entries.includes("SKILL.md") && entries.length <= 15;
  if (hasCleanRoot) score += 1;

  // Has references or documentation beyond SKILL.md
  if (fs.existsSync(path.join(skillDir, "references")) ||
      fs.existsSync(path.join(skillDir, "assets"))) {
    score += 0.5;
  }

  // Popularity as proxy for maintainability
  if (entry?.downloads) {
    const dl = parseDownloads(entry.downloads);
    if (dl >= 100000) score += 0.5;
    else if (dl >= 50000) score += 0.3;
  }

  return Math.min(score / maxPoints, 1);
}

function parseDownloads(s: string): number {
  const match = s.match(/^([\d.]+)(k)?$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  return match[2] ? num * 1000 : num;
}

// ── Static composite ──────────────────────────────────────────────────────

export function computeStaticComposite(result: StaticAnalysisResult): number {
  if (result.codeQuality === null) {
    // Redistribute code quality weight (15%) proportionally
    return (
      result.docQuality * 0.35 +
      result.completeness * 0.24 +
      result.security * 0.29 +
      result.maintainability * 0.12
    );
  }
  return (
    result.docQuality * 0.30 +
    result.completeness * 0.20 +
    result.security * 0.25 +
    result.codeQuality * 0.15 +
    result.maintainability * 0.10
  );
}

// ── LLM Evaluation ─────────────────────────────────────────────────────────

/** `CLAWHUB_LLM_PROVIDER`: `anthropic` | `ollama` | `openai`. If unset, uses Anthropic when `ANTHROPIC_API_KEY` is set. */
function llmProvider(): "anthropic" | "ollama" | "openai" {
  const p = (process.env.CLAWHUB_LLM_PROVIDER ?? "").toLowerCase().trim();
  if (p === "ollama" || p === "openai") return p;
  if (p === "anthropic") return "anthropic";
  if (!p && process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "anthropic";
}

function buildLlmPrompt(skillMdContent: string, slug: string): string {
  return `You are evaluating an AI agent skill package. The skill is identified by slug "${slug}".
Below is the SKILL.md content — the primary documentation and instruction file for this skill.

<skill_md>
${skillMdContent.slice(0, 8000)}
</skill_md>

Evaluate this skill on 4 dimensions, each scored 0.0 to 1.0:

1. **clarity** — How clear, well-structured, and understandable are the instructions? Consider readability, logical organization, and whether an AI agent could follow them without confusion.
2. **usefulness** — How practical and valuable is this skill? Does it solve a real problem? Would developers/agents benefit from it?
3. **safety** — Are there any security concerns? Does it handle credentials properly? Any dangerous operations without safeguards?
4. **completeness** — Does it cover all necessary information? Are there gaps in installation, usage, error handling, or edge cases?

Respond with ONLY valid JSON in this exact format:
{
  "clarity": 0.0,
  "usefulness": 0.0,
  "safety": 0.0,
  "completeness": 0.0,
  "reasoning": "Brief 2-3 sentence explanation of the scores."
}`;
}

function parseLlmJsonResponse(text: string, slug: string, model: string): LLMEvalResult | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn(`  LLM evaluation returned non-JSON for ${slug}`);
    return null;
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    clarity: number;
    usefulness: number;
    safety: number;
    completeness: number;
    reasoning: string;
  };

  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const c = clamp(parsed.clarity);
  const u = clamp(parsed.usefulness);
  const s = clamp(parsed.safety);
  const comp = clamp(parsed.completeness);

  return {
    clarity: c,
    usefulness: u,
    safety: s,
    completeness: comp,
    llmComposite: (c + u + s + comp) / 4,
    model,
    reasoning: parsed.reasoning ?? "",
  };
}

async function llmEvaluateAnthropic(
  prompt: string,
  slug: string
): Promise<LLMEvalResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    console.warn(`  LLM evaluation failed for ${slug}: HTTP ${res.status}`);
    return null;
  }

  const json = await res.json() as {
    content: Array<{ type: string; text: string }>;
  };
  const text = json.content?.[0]?.text ?? "";
  return parseLlmJsonResponse(text, slug, model);
}

/** Ollama: same host as embeddings (`OLLAMA_HOST`), model from `OLLAMA_ANALYSIS_MODEL` or `OLLAMA_MODEL`. */
async function llmEvaluateOllama(prompt: string, slug: string): Promise<LLMEvalResult | null> {
  const host = (process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  const model =
    process.env.OLLAMA_ANALYSIS_MODEL ?? process.env.OLLAMA_MODEL ?? "llama3.2";

  const res = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });

  if (!res.ok) {
    console.warn(`  Ollama LLM failed for ${slug}: HTTP ${res.status}`);
    return null;
  }

  const data = (await res.json()) as { message?: { content?: string } };
  const text = data.message?.content ?? "";
  return parseLlmJsonResponse(text, slug, model);
}

/** OpenAI-compatible `POST /v1/chat/completions` (OpenAI, LM Studio, vLLM, etc.). */
async function llmEvaluateOpenAICompatible(
  prompt: string,
  slug: string
): Promise<LLMEvalResult | null> {
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  if (!apiKey) {
    console.warn(`  OPENAI_API_KEY not set for ${slug}`);
    return null;
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    console.warn(`  OpenAI-compatible LLM failed for ${slug}: HTTP ${res.status}`);
    return null;
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  return parseLlmJsonResponse(text, slug, model);
}

export async function llmEvaluate(
  skillMdContent: string,
  slug: string
): Promise<LLMEvalResult | null> {
  const prompt = buildLlmPrompt(skillMdContent, slug);

  try {
    const provider = llmProvider();
    if (provider === "ollama") {
      return await llmEvaluateOllama(prompt, slug);
    }
    if (provider === "openai") {
      return await llmEvaluateOpenAICompatible(prompt, slug);
    }
    return await llmEvaluateAnthropic(prompt, slug);
  } catch (err) {
    console.warn(`  LLM evaluation error for ${slug}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Full analysis pipeline ─────────────────────────────────────────────────

export async function analyzeSkill(
  skillDir: string,
  slug: string,
  entry?: ClawHubSkillEntry,
  options: { llm?: boolean } = {}
): Promise<ClawHubAnalysis> {
  const docQuality = analyzeDocQuality(skillDir);
  const completeness = analyzeCompleteness(skillDir, entry);
  const security = analyzeSecurity(skillDir);
  const codeQuality = analyzeCodeQuality(skillDir);
  const maintainability = analyzeMaintainability(skillDir, entry);

  const staticAnalysis: StaticAnalysisResult = {
    docQuality,
    completeness,
    security,
    codeQuality,
    maintainability,
    staticComposite: 0,
  };
  staticAnalysis.staticComposite = computeStaticComposite(staticAnalysis);

  let llmEval: LLMEvalResult | null = null;
  if (options.llm) {
    const skillMdPath = path.join(skillDir, "SKILL.md");
    if (fs.existsSync(skillMdPath)) {
      const skillMdContent = fs.readFileSync(skillMdPath, "utf-8");
      llmEval = await llmEvaluate(skillMdContent, slug);
    }
  }

  const fileStats = collectFileStats(skillDir);

  // Overall composite: 60% static + 40% LLM (or 100% static if no LLM)
  const overallComposite = llmEval
    ? staticAnalysis.staticComposite * 0.6 + llmEval.llmComposite * 0.4
    : staticAnalysis.staticComposite;

  return {
    slug,
    analyzedAt: new Date().toISOString(),
    staticAnalysis,
    llmEval,
    overallComposite,
    fileStats,
  };
}
