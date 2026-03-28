/**
 * Tests for catalog composite weights (static + LLM).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { computeOverallComposite, readClawHubOverallWeights } from "../clawhub-scoring.js";

const ENV_STATIC = "CLAWHUB_OVERALL_STATIC_WEIGHT";
const ENV_LLM = "CLAWHUB_OVERALL_LLM_WEIGHT";

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
