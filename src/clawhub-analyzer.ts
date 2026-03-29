/**
 * clawhub-analyzer.ts — Static analysis and LLM evaluation for ClawHub skills.
 *
 * Static analysis checks documentation quality, completeness, security,
 * code quality, and maintainability. LLM evaluation scores SKILL.md via
 * Anthropic, Ollama, or an OpenAI-compatible API (`CLAWHUB_LLM_PROVIDER`).
 */

import * as fs from "fs";
import * as path from "path";
import { performance } from "node:perf_hooks";
import {
  StaticAnalysisResult,
  LLMEvalResult,
  ClawHubAnalysis,
  ClawHubSkillEntry,
  ClawHubSourceInsights,
} from "./types.js";
import { collectFileStats } from "./clawhub.js";
import { computeOverallComposite } from "./clawhub-scoring.js";

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

interface SecurityScanResult {
  filesScanned: number;
  dangerousMatches: number;
  secretMatches: number;
  exfiltrationMatches: number;
  flaggedFiles: string[];
  score: number;
}

function scanSecurity(skillDir: string): SecurityScanResult {
  let dangerousMatches = 0;
  let secretMatches = 0;
  let exfiltrationMatches = 0;
  let filesScanned = 0;
  const scanExtensions = new Set([".sh", ".py", ".js", ".ts", ".rb", ".pl", ".md"]);
  const flaggedFiles = new Set<string>();

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
          if (pattern.test(content)) {
            dangerousMatches++;
            flaggedFiles.add(path.relative(skillDir, full));
          }
        }
        for (const pattern of SECRET_PATTERNS) {
          if (pattern.test(content)) {
            secretMatches++;
            flaggedFiles.add(path.relative(skillDir, full));
          }
        }
        for (const pattern of EXFILTRATION_PATTERNS) {
          if (pattern.test(content)) {
            exfiltrationMatches++;
            flaggedFiles.add(path.relative(skillDir, full));
          }
        }
      }
    }
  };

  walk(skillDir);

  if (filesScanned === 0) {
    return {
      filesScanned: 0,
      dangerousMatches: 0,
      secretMatches: 0,
      exfiltrationMatches: 0,
      flaggedFiles: [],
      score: 1.0,
    };
  }
  const issues = dangerousMatches + exfiltrationMatches + secretMatches * 2;
  // Deduct 0.15 per issue, floor at 0
  return {
    filesScanned,
    dangerousMatches,
    secretMatches,
    exfiltrationMatches,
    flaggedFiles: [...flaggedFiles].sort(),
    score: Math.max(0, 1 - issues * 0.15),
  };
}

export function analyzeSecurity(skillDir: string): number {
  return scanSecurity(skillDir).score;
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

// ── Source insights (complexity, language fit, security findings) ──────────

function inferLanguageFromExt(ext: string): string | null {
  const map: Record<string, string> = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".jsx": "javascript",
    ".sh": "shell",
    ".rb": "ruby",
    ".go": "go",
    ".java": "java",
    ".rs": "rust",
    ".php": "php",
    ".cs": "csharp",
    ".cpp": "cpp",
    ".c": "c",
    ".swift": "swift",
    ".kt": "kotlin",
    ".sql": "sql",
  };
  return map[ext] ?? null;
}

function sourceInsights(skillDir: string): ClawHubSourceInsights {
  const languageCounts = new Map<string, number>();
  let scriptFiles = 0;
  let totalLoc = 0;
  let maxFileLoc = 0;
  const envVarsUsed = new Set<string>();
  const textExt = new Set([
    ".py", ".js", ".ts", ".tsx", ".jsx", ".sh", ".rb", ".go", ".java", ".rs", ".php", ".cs",
    ".cpp", ".c", ".swift", ".kt", ".sql", ".md", ".yml", ".yaml", ".json", ".toml", ".ini",
  ]);

  const walk = (dir: string, depth = 0) => {
    if (depth > 10) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const lang = inferLanguageFromExt(ext);
      if (lang) {
        languageCounts.set(lang, (languageCounts.get(lang) ?? 0) + 1);
        if (["python", "javascript", "typescript", "shell", "ruby"].includes(lang)) {
          scriptFiles++;
        }
      }
      if (!textExt.has(ext)) continue;
      try {
        const content = fs.readFileSync(full, "utf-8");
        const loc = content.length > 0 ? content.split(/\r?\n/).length : 0;
        totalLoc += loc;
        if (loc > maxFileLoc) maxFileLoc = loc;
        for (const m of content.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
          envVarsUsed.add(m[1]);
        }
        for (const m of content.matchAll(/(?:\$\{|\$)([A-Z_][A-Z0-9_]*)/g)) {
          envVarsUsed.add(m[1]);
        }
      } catch {
        // Ignore unreadable/binary edge cases for insight heuristics.
      }
    }
  };
  walk(skillDir);

  const languageBreakdown = [...languageCounts.entries()]
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));
  const primaryLanguage = languageBreakdown[0]?.language ?? null;

  const complexity: ClawHubSourceInsights["complexity"] =
    scriptFiles === 0
      ? "unknown"
      : totalLoc < 200 && scriptFiles <= 3
      ? "simple"
      : totalLoc < 1200 && scriptFiles <= 15
      ? "moderate"
      : "complex";

  const skillMdPath = path.join(skillDir, "SKILL.md");
  const md = fs.existsSync(skillMdPath) ? fs.readFileSync(skillMdPath, "utf-8").toLowerCase() : "";
  const detectIfMentioned = (lang: string): boolean => {
    const aliases: Record<string, string[]> = {
      javascript: ["javascript", "node", "node.js", "js"],
      typescript: ["typescript", "ts", "tsx"],
      python: ["python", "py"],
      shell: ["shell", "bash", "sh"],
      csharp: ["c#", "csharp", ".net", "dotnet"],
      cpp: ["c++", "cpp"],
    };
    const words = aliases[lang] ?? [lang];
    return words.some((w) => md.includes(w));
  };

  const describedLanguages = languageBreakdown
    .map((x) => x.language)
    .filter((lang) => detectIfMentioned(lang));
  const undocumentedLanguages = languageBreakdown
    .map((x) => x.language)
    .filter((lang) => !detectIfMentioned(lang));
  const mentionedCandidates = [
    "python", "javascript", "typescript", "shell", "ruby", "go", "java", "rust",
    "php", "csharp", "cpp", "sql",
  ].filter((lang) => detectIfMentioned(lang));
  const missingFromCode = mentionedCandidates.filter((lang) => !languageCounts.has(lang));

  const credentialSuffixes = [
    "_API_KEY", "_SECRET", "_TOKEN", "_PASSWORD", "_PRIVATE_KEY",
    "_ACCESS_KEY", "_AUTH_KEY", "_CLIENT_SECRET", "_SIGNING_KEY",
    "_WEBHOOK_SECRET", "_BEARER",
  ];
  const isLikelyCredential = (name: string): boolean =>
    credentialSuffixes.some((s) => name.toUpperCase().endsWith(s));
  const observedCredentialVars = [...envVarsUsed]
    .filter((v) => isLikelyCredential(v))
    .sort();

  const skillJsonPath = path.join(skillDir, "skill.json");
  let declaredCredentialVars: string[] = [];
  if (fs.existsSync(skillJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(skillJsonPath, "utf-8")) as {
        credentialVars?: unknown;
      };
      if (Array.isArray(parsed.credentialVars)) {
        declaredCredentialVars = parsed.credentialVars
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => x.toUpperCase())
          .sort();
      }
    } catch {
      // ignore invalid skill.json; other analyzers already capture quality signals
    }
  }
  const observedUpper = observedCredentialVars.map((v) => v.toUpperCase());
  const undeclaredCredentialVars = observedCredentialVars
    .filter((v) => !declaredCredentialVars.includes(v.toUpperCase()))
    .sort();
  const declaredButUnusedCredentialVars = declaredCredentialVars
    .filter((v) => !observedUpper.includes(v))
    .sort();

  const envExampleCandidates = [
    path.join(skillDir, ".env.example"),
    path.join(skillDir, ".env.sample"),
    path.join(skillDir, ".env.template"),
  ];
  const envExamplePath = envExampleCandidates.find((p) => fs.existsSync(p));
  let hasEnvExample = false;
  let envExampleVars = new Set<string>();
  if (envExamplePath) {
    hasEnvExample = true;
    try {
      const envTxt = fs.readFileSync(envExamplePath, "utf-8");
      envExampleVars = new Set(
        [...envTxt.matchAll(/^\s*([A-Z_][A-Z0-9_]*)\s*=/gm)].map((m) => m[1].toUpperCase())
      );
    } catch {
      // ignore unreadable env template
    }
  }
  const coverageBase = new Set([...declaredCredentialVars, ...observedUpper]);
  let covered = 0;
  for (const v of coverageBase) {
    if (envExampleVars.has(v)) covered++;
  }
  const envExampleCoverage =
    coverageBase.size === 0 ? 1 : covered / coverageBase.size;

  const sec = scanSecurity(skillDir);
  // Credential hygiene composite (0..1; higher is better).
  const undeclaredPenalty = Math.min(1, undeclaredCredentialVars.length * 0.25);
  const declaredUnusedPenalty = Math.min(1, declaredButUnusedCredentialVars.length * 0.15);
  const envCoveragePenalty = 1 - envExampleCoverage;
  const leakPenalty = Math.min(1, sec.secretMatches * 0.2 + sec.exfiltrationMatches * 0.25);
  const hygieneScoreRaw =
    1 -
    (undeclaredPenalty * 0.35 +
      declaredUnusedPenalty * 0.15 +
      envCoveragePenalty * 0.25 +
      leakPenalty * 0.25);
  const hygieneScore = Math.max(0, Math.min(1, hygieneScoreRaw));
  const hygieneLevel: "good" | "warn" | "risk" =
    hygieneScore >= 0.75 ? "good" : hygieneScore >= 0.5 ? "warn" : "risk";

  return {
    complexity,
    scriptFiles,
    totalLoc,
    maxFileLoc,
    primaryLanguage,
    languageBreakdown,
    describedLanguages,
    undocumentedLanguages,
    missingFromCode,
    credentialHygiene: {
      declaredCredentialVars,
      observedCredentialVars,
      undeclaredCredentialVars,
      declaredButUnusedCredentialVars,
      hasEnvExample,
      envExampleCoverage,
      hygieneScore,
      hygieneLevel,
    },
    securityFindings: {
      filesScanned: sec.filesScanned,
      dangerousMatches: sec.dangerousMatches,
      secretMatches: sec.secretMatches,
      exfiltrationMatches: sec.exfiltrationMatches,
      flaggedFiles: sec.flaggedFiles,
      potentialDataLeakage: sec.secretMatches > 0 || sec.exfiltrationMatches > 0,
    },
  };
}

function sourceSummaryForLlm(insights: ClawHubSourceInsights): string {
  const langs = insights.languageBreakdown
    .slice(0, 6)
    .map((x) => `${x.language}:${x.files}`)
    .join(", ");
  return [
    `complexity=${insights.complexity}`,
    `scriptFiles=${insights.scriptFiles}`,
    `totalLoc=${insights.totalLoc}`,
    `maxFileLoc=${insights.maxFileLoc}`,
    `primaryLanguage=${insights.primaryLanguage ?? "n/a"}`,
    `languageBreakdown=${langs || "n/a"}`,
    `undocumentedLanguages=${insights.undocumentedLanguages.join(",") || "none"}`,
    `missingFromCode=${insights.missingFromCode.join(",") || "none"}`,
    `credentialHygiene: score=${Math.round(insights.credentialHygiene.hygieneScore * 100)}% level=${insights.credentialHygiene.hygieneLevel} declared=${insights.credentialHygiene.declaredCredentialVars.join(",") || "none"} observed=${insights.credentialHygiene.observedCredentialVars.join(",") || "none"} undeclared=${insights.credentialHygiene.undeclaredCredentialVars.join(",") || "none"} envExampleCoverage=${Math.round(insights.credentialHygiene.envExampleCoverage * 100)}%`,
    `security: scanned=${insights.securityFindings.filesScanned} dangerous=${insights.securityFindings.dangerousMatches} secrets=${insights.securityFindings.secretMatches} exfiltration=${insights.securityFindings.exfiltrationMatches}`,
  ].join("\n");
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

/**
 * Model id stored in `clawhub_analysis.llm_model` for the current env.
 * Must stay in sync with `llmEvaluateAnthropic` / `llmEvaluateOllama` / `llmEvaluateOpenAICompatible`.
 */
export function resolvedCatalogLlmModel(): string {
  const p = llmProvider();
  if (p === "ollama") {
    return process.env.OLLAMA_ANALYSIS_MODEL ?? process.env.OLLAMA_MODEL ?? "llama3.2";
  }
  if (p === "openai") {
    return process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  }
  return process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";
}

function buildLlmPrompt(skillMdContent: string, slug: string, sourceContext: string): string {
  return `You are evaluating an AI agent skill package. The skill is identified by slug "${slug}".
Below is the SKILL.md content — the primary documentation and instruction file for this skill.

<skill_md>
${skillMdContent.slice(0, 8000)}
</skill_md>

Below is a static source-code summary for context.

<source_summary>
${sourceContext}
</source_summary>

Evaluate this skill on 4 core dimensions, each scored 0.0 to 1.0:

1. **clarity** — How clear, well-structured, and understandable are the instructions? Consider readability, logical organization, and whether an AI agent could follow them without confusion.
2. **usefulness** — How practical and valuable is this skill? Does it solve a real problem? Would developers/agents benefit from it?
3. **safety** — Are there any security concerns? Does it handle credentials properly? Any dangerous operations without safeguards?
4. **completeness** — Does it cover all necessary information? Are there gaps in installation, usage, error handling, or edge cases?

Also provide an OPTIONAL source-audit block (0.0 to 1.0):
- alignment: how well SKILL.md claims match the code summary
- security: code-level security posture
- privacy: privacy/data-minimization posture
- leakageRisk: risk of accidental credential/data leakage
- notes: 1-2 sentences for this audit

Respond with ONLY valid JSON in this exact format:
{
  "clarity": 0.0,
  "usefulness": 0.0,
  "safety": 0.0,
  "completeness": 0.0,
  "reasoning": "Brief 2-3 sentence explanation of the scores.",
  "source_audit": {
    "alignment": 0.0,
    "security": 0.0,
    "privacy": 0.0,
    "leakageRisk": 0.0,
    "notes": "Optional short note"
  }
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
    source_audit?: {
      alignment?: number;
      security?: number;
      privacy?: number;
      leakageRisk?: number;
      notes?: string;
    };
  };

  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const c = clamp(parsed.clarity);
  const u = clamp(parsed.usefulness);
  const s = clamp(parsed.safety);
  const comp = clamp(parsed.completeness);

  const sourceAudit = parsed.source_audit
    ? {
        alignment: clamp(parsed.source_audit.alignment ?? 0),
        security: clamp(parsed.source_audit.security ?? 0),
        privacy: clamp(parsed.source_audit.privacy ?? 0),
        leakageRisk: clamp(parsed.source_audit.leakageRisk ?? 0),
        notes: parsed.source_audit.notes ?? "",
      }
    : undefined;

  return {
    clarity: c,
    usefulness: u,
    safety: s,
    completeness: comp,
    llmComposite: (c + u + s + comp) / 4,
    model,
    reasoning: parsed.reasoning ?? "",
    sourceAudit,
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
  slug: string,
  sourceContext = ""
): Promise<LLMEvalResult | null> {
  const prompt = buildLlmPrompt(skillMdContent, slug, sourceContext);

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

function msSince(t0: number): number {
  return Math.round(performance.now() - t0);
}

export async function analyzeSkill(
  skillDir: string,
  slug: string,
  entry?: ClawHubSkillEntry,
  options: { llm?: boolean } = {}
): Promise<ClawHubAnalysis> {
  const pipelineT0 = performance.now();

  const tStatic0 = performance.now();
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
  const staticMs = msSince(tStatic0);

  const tFs0 = performance.now();
  const fileStats = collectFileStats(skillDir);
  const fileStatsMs = msSince(tFs0);
  const insights = sourceInsights(skillDir);

  let llmEval: LLMEvalResult | null = null;
  let llmMs: number | null = null;
  if (options.llm) {
    const tLlm0 = performance.now();
    const skillMdPath = path.join(skillDir, "SKILL.md");
    if (fs.existsSync(skillMdPath)) {
      const skillMdContent = fs.readFileSync(skillMdPath, "utf-8");
      llmEval = await llmEvaluate(skillMdContent, slug, sourceSummaryForLlm(insights));
      if (llmEval?.sourceAudit) {
        insights.llmAssistedAudit = llmEval.sourceAudit;
      }
    }
    llmMs = msSince(tLlm0);
  }

  const pipelineMs = msSince(pipelineT0);

  // Weighted composite: static + LLM (weights from CLAWHUB_OVERALL_* env; default 0.6 / 0.4)
  const overallComposite = computeOverallComposite(
    staticAnalysis.staticComposite,
    llmEval?.llmComposite ?? null
  );

  return {
    slug,
    analyzedAt: new Date().toISOString(),
    staticAnalysis,
    llmEval,
    overallComposite,
    fileStats,
    insights,
    timing: {
      extractMs: 0,
      staticMs,
      llmMs,
      fileStatsMs,
      pipelineMs,
    },
  };
}
