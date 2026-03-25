<div align="center">
  <img src="./docs/images/claw-bench.png" alt="claw-bench — benchmark ClawHub skills" width="600" />
  <h1>claw-bench</h1>
  <p><strong>Benchmark ClawHub skills — correctness, consistency, robustness, latency</strong></p>
  <p>
    Benchmark tool for <a href="https://clawhub.ai">ClawHub</a> skills. Scores skills on four dimensions — <strong>correctness</strong>, <strong>consistency</strong>, <strong>robustness</strong>, and <strong>latency</strong> — and produces structured reports for comparison, leaderboard submission, and drift tracking.
  </p>
  <p>
    The public registry website is <a href="https://clawhub.ai"><strong>clawhub.ai</strong></a> (skills: <a href="https://clawhub.ai/skills">clawhub.ai/skills</a>). The <code>clawhub.dev</code> hostname is not the live ClawHub site; <code>api.clawhub.dev</code> often does not resolve in DNS—set <code>CLAWHUB_API_URL</code> yourself when ClawHub documents a working benchmark endpoint.
  </p>
  <p>
    <a href="https://github.com/just-claw-it/claw-bench/actions/workflows/ci.yml?branch=main">
      <img src="https://github.com/just-claw-it/claw-bench/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" />
    </a>
    <a href="LICENSE">
      <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" />
    </a>
  </p>
</div>

## Installation

The package is **not on the npm registry yet** — clone this repository and run `npm install && npm run build`, or use `npm link` from the repo root (see [Development](#development)). When it is published, you will be able to use:

```bash
npm install -g claw-bench
```

Or install locally in a project:

```bash
npm install claw-bench
```

### Prerequisites

- **Node.js 20+**
- **Ollama** running locally (for consistency scoring via embeddings). Pull an embedding model:
  ```bash
  ollama pull nomic-embed-text
  ```

### Running from this repository (`command not found: claw-bench`)

The `claw-bench` command is only on your shell `PATH` if you install the package globally (`npm install -g claw-bench`) or link it (`npm link` inside this repo). When you clone the repo and run `claw-bench` directly, zsh reports **command not found**.

From the project root, build once, then use one of these:

```bash
npm install
npm run build
```

- **`npx claw-bench <args>`** — runs the local CLI (e.g. `npx claw-bench clawhub list`, `npx claw-bench dashboard --port 3078`).
- **`npm run clawhub -- <args>`** — same as `node dist/cli.js clawhub <args>` (e.g. `npm run clawhub -- list`, `npm run clawhub -- download --all`).
- **`npm run dashboard -- --port 3078`** — starts the dashboard on a free port if `3077` is busy.

Optional: `npm link` in the repo adds `claw-bench` to your PATH for this machine.

### Docker

Build and run the dashboard + API anywhere:

```bash
docker compose up --build
# http://localhost:3077
```

- **SQLite** is stored on the **`clawbench-data`** volume at **`CLAW_BENCH_DB=/data/bench.db`** (survives container restarts).
- The HTTP server binds **`0.0.0.0`** by default so published ports work; set **`CLAW_BENCH_BIND`** (e.g. `127.0.0.1`) to override.
- **`NODE_ENV=production`** (set in the image) hides local smoke-test runs (e.g. `test-skills/echo-skill`) from dashboard API responses. Set **`CLAW_BENCH_SHOW_TEST_RUNS=1`** in the container environment if you want them listed.
- The image ships an **empty** `clawhub/skills-seed.json` (`[]`). Populate the catalog by **exec**’ing into the container, or **bind-mount** a seed file:

```bash
# One-off: crawl registry inside the running container (writes DB + /app/clawhub — ephemeral unless you mount /app/clawhub)
docker compose exec claw-bench node dist/cli.js clawhub crawl --dry-run
docker compose exec claw-bench node dist/cli.js clawhub crawl
```

Or add a read-only mount in `docker-compose.yml`:

```yaml
volumes:
  - ./clawhub/skills-seed.json:/app/clawhub/skills-seed.json:ro
```

Plain **Docker** (no Compose): `docker build -t claw-bench .` then  
`docker run -p 3077:3077 -v clawbench-data:/data claw-bench`.

### Crawling the full ClawHub registry

The [skills page](https://clawhub.ai/skills) is a client-side app; you do **not** need to crawl HTML. The registry is served by a public [Convex](https://www.convex.dev) query (`skills:listPublicPageV4` on the same deployment the site uses).

From the repo (after `npm run build`):

```bash
# Fetch every public skill and overwrite clawhub/skills-seed.json + sync the local SQLite catalog
npx claw-bench clawhub crawl

# Preview how many skills exist (no file write)
npx claw-bench clawhub crawl --dry-run

# Re-load SQLite from an existing seed file without calling Convex again
npx claw-bench clawhub crawl --seed-only

# Same order as the site’s “Sort” menu (default: downloads, descending)
npx claw-bench clawhub crawl --sort stars
```

Then download zips and run analysis:

```bash
npx claw-bench clawhub download --all
npx claw-bench clawhub analyze --all
# optional: delete each zip + extracted folder after analyzing (saves disk; re-download to re-run)
# npx claw-bench clawhub analyze --all --cleanup
# optional LLM scores:
# ANTHROPIC_API_KEY=... npx claw-bench clawhub analyze --all --llm
# Local Ollama for LLM scores:
# CLAWHUB_LLM_PROVIDER=ollama OLLAMA_ANALYSIS_MODEL=llama3.2 npx claw-bench clawhub analyze --all --llm
```

**LLM provider for `clawhub analyze --llm`** (`CLAWHUB_LLM_PROVIDER`):

| Provider | Environment |
|----------|-------------|
| **Anthropic** (default when `ANTHROPIC_API_KEY` is set) | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_MODEL` |
| **Ollama** | `CLAWHUB_LLM_PROVIDER=ollama`, `OLLAMA_HOST` (default `http://127.0.0.1:11434`), `OLLAMA_ANALYSIS_MODEL` or `OLLAMA_MODEL` |
| **OpenAI-compatible** (OpenAI, LM Studio, vLLM, etc.) | `CLAWHUB_LLM_PROVIDER=openai`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` (optional), `OPENAI_MODEL` |

Embeddings for benchmarks still use **Ollama** via `OLLAMA_HOST` and `BENCH_EMBED_MODEL` — separate from catalog LLM analysis.

Override the Convex deployment URL if ClawHub moves (rare):

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAWHUB_CONVEX_URL` | Convex **.cloud** URL for `/api/query` | `https://wry-manatee-359.convex.cloud` |

## Quick start

```bash
# Benchmark a local skill
claw-bench run ./my-skill

# Benchmark a skill by name (looks in ./skills, ~/.clawhub/skills, etc.)
claw-bench run my-skill

# Compare two skills side-by-side
claw-bench compare ./skill-a ./skill-b

# View the last report as markdown
claw-bench report --format md

# Push results to the ClawHub leaderboard
claw-bench push --api-key <key>
```

## Scoring dimensions

| Dimension | Weight (authored) | Weight (automated) | Description |
|-----------|------------------:|-------------------:|-------------|
| Correctness | 40% | — | Passes input/output pairs from `bench.json` |
| Consistency | 30% | 50% | Embedding similarity across repeated runs |
| Robustness | 20% | 35% | Graceful handling of malformed inputs |
| Latency | 10% | 15% | p95 response time vs threshold |

If a skill ships with `bench.json`, it receives an **authored** score (all four dimensions). Otherwise, it gets an **automated** score (consistency + robustness + latency).

## CLI commands

### `claw-bench run <skill>`

Run a full benchmark on a skill.

| Flag | Description | Default |
|------|-------------|---------|
| `--threshold <n>` | Consistency similarity threshold | `0.92` |
| `--runs <n>` | Number of consistency/latency runs | `5` |
| `--latency-threshold <ms>` | Latency p95 threshold | `5000` |
| `--embed-model <model>` | Ollama embedding model | `nomic-embed-text` |
| `--semantic-check` | Run experimental LLM semantic check | off |
| `--skill-version <v>` | Tag run with a version for drift tracking | — |
| `--no-store` | Skip writing to local DB | — |
| `--output-dir <dir>` | Report output directory | `./bench-reports` |

### `claw-bench compare <skillA> <skillB>`

Side-by-side benchmark comparison. Accepts the same `--threshold`, `--runs`, `--latency-threshold`, and `--embed-model` flags as `run`.

### `claw-bench report`

Export or display an existing benchmark report.

| Flag | Description | Default |
|------|-------------|---------|
| `--format <fmt>` | `json` or `md` | `json` |
| `--input <file>` | Path to report | `./bench-reports/benchmark-report.json` |

### `claw-bench push`

Push a report to the ClawHub leaderboard.

| Flag | Description |
|------|-------------|
| `--api-key <key>` | ClawHub API key (or set `CLAWHUB_API_KEY`) |
| `--api-url <url>` | Override API endpoint |
| `--skill-name <n>` | Override skill name on leaderboard |
| `--draft` | Submit as draft (not publicly visible) |

### `claw-bench data <subcommand>`

Query the local benchmark database for analytics.

| Subcommand | Description |
|------------|-------------|
| `stats` | DB location and run count |
| `distribution` | Score distributions by skill type |
| `threshold` | Calibrate consistency threshold |
| `installs` | Score vs install count correlation |
| `drift [skill]` | Score drift over time |
| `authors` | Score by author verification status |
| `tags` | Mean score per tag |
| `stars` | Score vs star rating correlation |
| `deps` | Score vs dependency count |
| `growth` | Install growth vs score |
| `import-metadata <file>` | Import skill metadata from JSON |

## Configuration

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BENCH_EMBED_MODEL` | Default embedding model | `nomic-embed-text` |
| `OLLAMA_HOST` | Ollama server URL | `http://localhost:11434` |
| `CLAW_BENCH_DB` | SQLite database path | `~/.claw-bench/bench.db` |
| `CLAWHUB_API_KEY` | ClawHub leaderboard API key | — |
| `CLAWHUB_API_URL` | ClawHub benchmark leaderboard `POST` URL | `https://api.clawhub.dev/v1/leaderboard` (legacy default; **override** if that host does not resolve) |
| `CLAWHUB_CONVEX_URL` | Convex `.cloud` base URL for registry crawl (`clawhub crawl`) | `https://wry-manatee-359.convex.cloud` |
| `ANTHROPIC_API_KEY` | API key for semantic check / catalog LLM | — |
| `ANTHROPIC_MODEL` | Model for semantic check / catalog LLM | `claude-haiku-4-5-20251001` |
| `CLAWHUB_LLM_PROVIDER` | Catalog LLM: `anthropic` \| `ollama` \| `openai` | — |
| `OLLAMA_ANALYSIS_MODEL` | Ollama model for catalog `--llm` | same as `OLLAMA_MODEL` or `llama3.2` |
| `OPENAI_API_KEY` | OpenAI-compatible `chat/completions` for catalog `--llm` | — |
| `OPENAI_BASE_URL` | OpenAI-compatible API base | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | OpenAI-compatible model id | `gpt-4o-mini` |

## Writing `bench.json`

To enable correctness scoring, create a `bench.json` alongside `skill.json`:

```json
{
  "skillName": "my-skill",
  "pairs": [
    {
      "description": "Echoes input",
      "input": { "input": "hello" },
      "expectedOutput": { "echo": "hello" }
    }
  ]
}
```

Each pair defines an input and the expected output keys/values. Correctness is the fraction of pairs that produce matching output.

## Skill structure

A ClawHub skill is a directory containing:

```
my-skill/
├── skill.json      # Manifest (name, type, entrypoint)
├── bench.json      # Optional correctness pairs
└── index.js        # Default-exported async handler
```

`skill.json` example:

```json
{
  "name": "my-skill",
  "description": "Does something useful",
  "type": "linear",
  "entrypoint": "index.js",
  "credentialVars": []
}
```

Supported types: `linear`, `webhook`, `cron`.

## Dashboard

claw-bench includes an interactive web dashboard for browsing, comparing, and analyzing benchmark results.

### Quick start

```bash
# Install dashboard dependencies
npm run dashboard:install

# Build the dashboard
npm run dashboard:build

# Launch (serves on http://localhost:3077)
npx claw-bench dashboard
# or: npm run dashboard
```

### Dashboard features

- **Overview** -- summary stats, score distribution histogram, skills leaderboard, recent runs
- **Runs Explorer** -- searchable, sortable, filterable table of all runs with expandable detail rows
- **Skill Detail** -- per-skill radar chart, score drift over time, version deltas, run history
- **Compare** -- select 2-4 skills for side-by-side radar charts and dimension breakdown
- **Import** -- drag-and-drop `benchmark-report.json` files to import into the database

### Development mode

For frontend development with hot reload:

```bash
# Terminal 1: start the API server
npm run build
npx claw-bench dashboard --port 3077

# Terminal 2: start the Vite dev server (proxies /api to 3077)
npm run dashboard:dev
# Open http://localhost:5173
```

## Development

```bash
git clone https://github.com/just-claw-it/claw-bench.git
cd claw-bench
npm install
npm run build
npm test
```

`dist/` is not committed; always run `npm run build` after pulling changes. For the dashboard UI, also run `npm run dashboard:install` and `npm run dashboard:build`.

## License

This project is licensed under the [MIT License](LICENSE).

To report a security issue privately, see [SECURITY.md](SECURITY.md).
