/**
 * CLI smoke test for clawhub analyze output lines (attrs + llm-audit).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { spawn } from "child_process";
import AdmZip from "adm-zip";

interface SeedEntry {
  slug: string;
  name: string;
  author: string;
  version: string;
  summary: string;
  downloads: string;
  stars: string;
  versionCount: number;
}

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawhub-cli-smoke-"));
}

function writeMiniCatalog(root: string, slug: string): void {
  const clawhubDir = path.join(root, "clawhub");
  const zipDir = path.join(clawhubDir, "zip");
  fs.mkdirSync(zipDir, { recursive: true });

  const seed: SeedEntry[] = [{
    slug,
    name: "Smoke Skill",
    author: "tester",
    version: "1.0.0",
    summary: "smoke",
    downloads: "1k",
    stars: "10",
    versionCount: 1,
  }];
  fs.writeFileSync(path.join(clawhubDir, "skills-seed.json"), JSON.stringify(seed, null, 2));

  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from(`# Smoke Skill\n\n## Usage\n\nUse it.\n\n## Security\n\nNo secrets.\n`));
  zip.addFile("skill.json", Buffer.from(JSON.stringify({
    name: "Smoke Skill",
    description: "smoke",
    type: "linear",
    entrypoint: "index.js",
    credentialVars: ["OPENAI_API_KEY"],
  }, null, 2)));
  zip.addFile("index.js", Buffer.from("const k = process.env.OPENAI_API_KEY; console.log('ok');"));
  zip.writeZip(path.join(zipDir, `${slug}.zip`));
}

function startFakeOpenAi(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                clarity: 0.8,
                usefulness: 0.7,
                safety: 0.9,
                completeness: 0.85,
                reasoning: "Looks okay.",
                source_audit: {
                  alignment: 0.75,
                  security: 0.8,
                  privacy: 0.7,
                  leakageRisk: 0.25,
                  notes: "Minor credential documentation gap.",
                },
              }),
            },
          }],
        }));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("Failed to bind fake OpenAI server");
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function runCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("clawhub analyze CLI smoke", () => {
  it("prints attrs and llm-audit lines", async () => {
    const tempRoot = mkTempDir();
    const slug = "smoke-skill";
    writeMiniCatalog(tempRoot, slug);

    const fake = await startFakeOpenAi();
    const dbFile = path.join(tempRoot, "bench.db");

    const cliPath = path.join(process.cwd(), "dist", "cli.js");
    const run = await runCli(
      [cliPath, "clawhub", "analyze", "--all", "--llm", "--no-seed", "--clean-all-analyses"],
      tempRoot,
      {
        ...process.env,
        CLAW_BENCH_DB: dbFile,
        CLAWHUB_LLM_PROVIDER: "openai",
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: fake.baseUrl,
        OPENAI_MODEL: "smoke-model",
      }
    );

    await fake.close();

    assert.equal(run.status, 0, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
    assert.match(run.stdout, /attrs:/);
    assert.match(run.stdout, /hygiene=\d+%/);
    assert.match(run.stdout, /llm-audit:/);
    assert.match(run.stdout, /overall:/);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("without --llm prints attrs but no llm-audit line", async () => {
    const tempRoot = mkTempDir();
    const slug = "smoke-skill-no-llm";
    writeMiniCatalog(tempRoot, slug);
    const dbFile = path.join(tempRoot, "bench.db");

    const cliPath = path.join(process.cwd(), "dist", "cli.js");
    const run = await runCli(
      [cliPath, "clawhub", "analyze", "--all", "--no-seed", "--clean-all-analyses"],
      tempRoot,
      {
        ...process.env,
        CLAW_BENCH_DB: dbFile,
      }
    );

    assert.equal(run.status, 0, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
    assert.match(run.stdout, /attrs:/);
    assert.doesNotMatch(run.stdout, /llm-audit:/);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

