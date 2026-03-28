/**
 * Tests for catalog composite weights (static + LLM).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  computeOverallComposite,
  readClawHubOverallWeights,
  readLlmAggregateMode,
  buildClawhubLlmAggregateSubquery,
} from "../clawhub-scoring.js";

const ENV_STATIC = "CLAWHUB_OVERALL_STATIC_WEIGHT";
const ENV_LLM = "CLAWHUB_OVERALL_LLM_WEIGHT";
const ENV_AGG = "CLAWHUB_LLM_AGGREGATE";

describe("computeOverallComposite", () => {
  let prevS: string | undefined;
  let prevL: string | undefined;

  beforeEach(() => {
    prevS = process.env[ENV_STATIC];
    prevL = process.env[ENV_LLM];
    delete process.env[ENV_STATIC];
    delete process.env[ENV_LLM];
  });

  afterEach(() => {
    if (prevS === undefined) delete process.env[ENV_STATIC];
    else process.env[ENV_STATIC] = prevS;
    if (prevL === undefined) delete process.env[ENV_LLM];
    else process.env[ENV_LLM] = prevL;
  });

  it("returns static only when LLM composite is null", () => {
    assert.equal(computeOverallComposite(0.82, null), 0.82);
  });

  it("uses default 0.6 static + 0.4 LLM when env unset", () => {
    assert.equal(computeOverallComposite(0.5, 1.0), 0.5 * 0.6 + 1.0 * 0.4);
  });

  it("normalizes custom weights from env", () => {
    process.env[ENV_STATIC] = "3";
    process.env[ENV_LLM] = "7";
    assert.deepEqual(readClawHubOverallWeights(), { wStatic: 0.3, wLlm: 0.7 });
    assert.equal(computeOverallComposite(1.0, 0.0), 0.3);
  });
});

describe("readLlmAggregateMode", () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env[ENV_AGG];
    delete process.env[ENV_AGG];
  });

  afterEach(() => {
    if (prev === undefined) delete process.env[ENV_AGG];
    else process.env[ENV_AGG] = prev;
  });

  it("defaults to mean", () => {
    assert.equal(readLlmAggregateMode(), "mean");
  });

  it("accepts median, min, max (case-insensitive)", () => {
    process.env[ENV_AGG] = "MEDIAN";
    assert.equal(readLlmAggregateMode(), "median");
    process.env[ENV_AGG] = "min";
    assert.equal(readLlmAggregateMode(), "min");
    process.env[ENV_AGG] = "MAX";
    assert.equal(readLlmAggregateMode(), "max");
  });

  it("accepts avg / average as mean", () => {
    process.env[ENV_AGG] = "avg";
    assert.equal(readLlmAggregateMode(), "mean");
    process.env[ENV_AGG] = "average";
    assert.equal(readLlmAggregateMode(), "mean");
  });

  it("unknown value falls back to mean", () => {
    process.env[ENV_AGG] = "nope";
    assert.equal(readLlmAggregateMode(), "mean");
  });
});

describe("buildClawhubLlmAggregateSubquery", () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env[ENV_AGG];
    delete process.env[ENV_AGG];
  });

  afterEach(() => {
    if (prev === undefined) delete process.env[ENV_AGG];
    else process.env[ENV_AGG] = prev;
  });

  it("mean mode: AVG + GROUP BY x.slug", () => {
    const sql = buildClawhubLlmAggregateSubquery().replace(/\s+/g, " ");
    assert.match(sql, /AVG\s*\(\s*x\.llm_clarity\s*\)/i);
    assert.match(sql, /GROUP BY x\.slug/i);
  });

  it("min mode: MIN aggregates", () => {
    process.env[ENV_AGG] = "min";
    const sql = buildClawhubLlmAggregateSubquery().replace(/\s+/g, " ");
    assert.match(sql, /MIN\s*\(\s*x\.llm_composite\s*\)/i);
  });

  it("max mode: MAX aggregates", () => {
    process.env[ENV_AGG] = "max";
    const sql = buildClawhubLlmAggregateSubquery().replace(/\s+/g, " ");
    assert.match(sql, /MAX\s*\(\s*x\.llm_composite\s*\)/i);
  });

  it("median mode: per-dimension median subqueries + llm_model_count", () => {
    process.env[ENV_AGG] = "median";
    const sql = buildClawhubLlmAggregateSubquery();
    assert.match(sql, /llm_model_count/);
    assert.match(sql, /AVG\s*\(\s*t\.v\s*\)\s+AS\s+llm_clarity/i);
    assert.match(sql, /PARTITION BY b\.slug ORDER BY b\.llm_clarity/i);
  });
});
