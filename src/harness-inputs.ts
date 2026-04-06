/**
 * Shared input shaping + mock payloads for skill execution (used by harness and sandbox runner).
 */
import type { MockCronTrigger, MockWebhookPayload, SkillManifest } from "./types.js";

export function mockWebhookPayload(
  overrides: Partial<MockWebhookPayload> = {}
): MockWebhookPayload {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "claw-bench/0.1.0",
      "x-request-id": "bench-00000000",
    },
    body: { event: "benchmark.probe", data: { value: "test" } },
    query: {},
    params: {},
    ...overrides,
  };
}

export function mockCronTrigger(
  overrides: Partial<MockCronTrigger> = {}
): MockCronTrigger {
  return {
    scheduledTime: new Date().toISOString(),
    cronExpression: "0 9 * * 1-5",
    timezone: "UTC",
    jobName: "benchmark-probe",
    ...overrides,
  };
}

export function shapeInput(
  type: SkillManifest["type"],
  input: Record<string, unknown>
): Record<string, unknown> {
  if (type === "webhook") {
    if ("method" in input && "body" in input) return input;
    return mockWebhookPayload({ body: input }) as unknown as Record<string, unknown>;
  }
  if (type === "cron") {
    if ("cronExpression" in input) return input;
    return mockCronTrigger() as unknown as Record<string, unknown>;
  }
  return input;
}
