/**
 * ClawHub static analyzer + composite tests (fixtures on disk).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  analyzeDocQuality,
  analyzeCompleteness,
  analyzeSecurity,
  analyzeCodeQuality,
  computeStaticComposite,
  analyzeSkill,
} from "../clawhub-analyzer.js";
import type { ClawHubSkillEntry, StaticAnalysisResult } from "../types.js";

function approxEq(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

function tmpSkillDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawhub-analyzer-test-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const minimalEntry: ClawHubSkillEntry = {
  slug: "fixture-skill",
  name: "Fixture",
  author: "test",
  version: "1.0.0",
  summary: "test",
  downloads: "100",
  stars: "5",
  versionCount: 3,
};

describe("computeStaticComposite", () => {
  it("with codeQuality: weighted sum 30/20/25/15/10", () => {
    const r: StaticAnalysisResult = {
      docQuality: 1,
      completeness: 0,
      security: 0,
      codeQuality: 0,
      maintainability: 0,
      staticComposite: 0,
    };
    assert.ok(approxEq(computeStaticComposite(r), 0.3), `got ${computeStaticComposite(r)}`);
  });

  it("with codeQuality null: redistributes weights (35/24/29/12)", () => {
    const r: StaticAnalysisResult = {
      docQuality: 1,
      completeness: 0,
      security: 0,
      codeQuality: null,
      maintainability: 0,
      staticComposite: 0,
    };
    assert.ok(approxEq(computeStaticComposite(r), 0.35), `got ${computeStaticComposite(r)}`);
  });

  it("all ones with code → 1.0", () => {
    const r: StaticAnalysisResult = {
      docQuality: 1,
      completeness: 1,
      security: 1,
      codeQuality: 1,
      maintainability: 1,
      staticComposite: 0,
    };
    const c = computeStaticComposite(r);
    assert.ok(approxEq(c, 1), `expected ~1, got ${c}`);
  });

  it("all ones without code → 1.0", () => {
    const r: StaticAnalysisResult = {
      docQuality: 1,
      completeness: 1,
      security: 1,
      codeQuality: null,
      maintainability: 1,
      staticComposite: 0,
    };
    const c = computeStaticComposite(r);
    assert.ok(approxEq(c, 1), `expected ~1, got ${c}`);
  });
});

describe("analyzeDocQuality", () => {
  it("no SKILL.md → 0", () => {
    const dir = tmpSkillDir({ "readme.md": "hello" });
    assert.equal(analyzeDocQuality(dir), 0);
    fs.rmSync(dir, { recursive: true });
  });

  it("rich SKILL.md → high score", () => {
    const md = `---
name: demo
description: A demo skill for tests
---

## Overview

${"Longer body text. ".repeat(80)}

## Usage

Run the tool.

## Installation

\`\`\`bash
npm install
\`\`\`

## Examples

\`\`\`js
console.log(1);
\`\`\`

\`\`\`json
{"a": 1}
\`\`\`

| Col | A |
| --- | --- |
| 1 | 2 |
`;
    const dir = tmpSkillDir({ "SKILL.md": md });
    const q = analyzeDocQuality(dir);
    assert.ok(q >= 0.75, `expected >= 0.75, got ${q}`);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("analyzeCompleteness", () => {
  it("SKILL.md + semver entry boosts score", () => {
    const dir = tmpSkillDir({ "SKILL.md": "# Hi\n", "_meta.json": "{}" });
    const c = analyzeCompleteness(dir, minimalEntry);
    assert.ok(c > 0.4);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("analyzeSecurity", () => {
  it("markdown-only skill → 1.0", () => {
    const dir = tmpSkillDir({ "SKILL.md": "# Safe\n" });
    assert.equal(analyzeSecurity(dir), 1);
    fs.rmSync(dir, { recursive: true });
  });

  it("detects dangerous pattern in .js", () => {
    const dir = tmpSkillDir({
      "SKILL.md": "# X",
      "bad.js": "eval('console.log(1)');\n",
    });
    const s = analyzeSecurity(dir);
    assert.ok(s < 1);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("analyzeCodeQuality", () => {
  it("no scripts → null", () => {
    const dir = tmpSkillDir({ "SKILL.md": "# Only doc" });
    assert.equal(analyzeCodeQuality(dir), null);
    fs.rmSync(dir, { recursive: true });
  });

  it("structured script with try/catch → score > 0", () => {
    const dir = tmpSkillDir({
      "SKILL.md": "# X",
      "scripts/run.js": `#!/usr/bin/env node
try {
  main();
} catch (e) {
  process.exit(1);
}
// explain
function main() {}
`,
    });
    const q = analyzeCodeQuality(dir);
    assert.ok(q !== null && q > 0);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("analyzeSkill (no LLM)", () => {
  it("returns timing + static scores; llmMs null", async () => {
    const dir = tmpSkillDir({
      "SKILL.md": `---
name: t
description: d
---
## Usage
ok
`,
    });
    const out = await analyzeSkill(dir, "fixture-skill", minimalEntry, { llm: false });
    assert.equal(out.llmEval, null);
    assert.equal(out.timing.llmMs, null);
    assert.ok(out.timing.staticMs >= 0);
    assert.ok(
      out.timing.pipelineMs + 1 >= out.timing.staticMs,
      `pipeline ${out.timing.pipelineMs} should cover static ${out.timing.staticMs} (1ms rounding slack)`
    );
    assert.ok(out.timing.fileStatsMs >= 0);
    assert.equal(out.timing.extractMs, 0);
    assert.ok(out.staticAnalysis.staticComposite >= 0 && out.staticAnalysis.staticComposite <= 1);
    assert.ok(out.insights);
    const ins = out.insights!;
    assert.ok(["simple", "moderate", "complex", "unknown"].includes(ins.complexity));
    assert.ok(ins.credentialHygiene.hygieneScore >= 0 && ins.credentialHygiene.hygieneScore <= 1);
    assert.ok(["good", "warn", "risk"].includes(ins.credentialHygiene.hygieneLevel));
    fs.rmSync(dir, { recursive: true });
  });
});

describe("source insights: credential hygiene", () => {
  it("detects observed credential vars and undeclared mismatch", async () => {
    const dir = tmpSkillDir({
      "SKILL.md": "# test",
      "skill.json": JSON.stringify({
        name: "t",
        description: "d",
        type: "linear",
        entrypoint: "index.js",
        credentialVars: ["OPENAI_API_KEY"],
      }),
      "index.js": `
const a = process.env.OPENAI_API_KEY;
const b = process.env.STRIPE_SECRET;
`,
      ".env.example": "OPENAI_API_KEY=\n",
    });

    const out = await analyzeSkill(dir, "fixture-skill", minimalEntry, { llm: false });
    const h = out.insights!.credentialHygiene;
    assert.ok(h.observedCredentialVars.includes("OPENAI_API_KEY"));
    assert.ok(h.observedCredentialVars.includes("STRIPE_SECRET"));
    assert.ok(h.undeclaredCredentialVars.includes("STRIPE_SECRET"));
    assert.equal(h.declaredButUnusedCredentialVars.length, 0);
    assert.equal(h.hasEnvExample, true);
    assert.ok(h.envExampleCoverage > 0 && h.envExampleCoverage < 1);
    fs.rmSync(dir, { recursive: true });
  });

  it("declared but unused credential vars are flagged", async () => {
    const dir = tmpSkillDir({
      "SKILL.md": "# test",
      "skill.json": JSON.stringify({
        name: "t",
        description: "d",
        type: "linear",
        entrypoint: "index.js",
        credentialVars: ["GITHUB_TOKEN"],
      }),
      "index.js": "console.log('no creds');\n",
      ".env.example": "GITHUB_TOKEN=\n",
    });
    const out = await analyzeSkill(dir, "fixture-skill", minimalEntry, { llm: false });
    const h = out.insights!.credentialHygiene;
    assert.ok(h.declaredButUnusedCredentialVars.includes("GITHUB_TOKEN"));
    assert.equal(h.undeclaredCredentialVars.length, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("analyzeSkill with llm flag but missing SKILL.md", () => {
  it("keeps llmEval null and llmMs measured", async () => {
    const dir = tmpSkillDir({
      "index.js": "console.log('x');",
      "skill.json": JSON.stringify({
        name: "t",
        description: "d",
        type: "linear",
        entrypoint: "index.js",
      }),
    });
    const out = await analyzeSkill(dir, "fixture-skill", minimalEntry, { llm: true });
    assert.equal(out.llmEval, null);
    assert.ok(out.timing.llmMs !== null);
    assert.ok(out.insights?.credentialHygiene);
    fs.rmSync(dir, { recursive: true });
  });
});
