/**
 * Pure mapping tests for ClawHub → SkillMetadata (no network).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  dependencyNamesFromParsedClawdis,
  mapClawHubDetailToSkillMetadata,
  normalizeSkillTags,
  type ClawHubGetBySlugValue,
  type ClawHubVersionRow,
} from "../clawhub-metadata-collector.js";

describe("normalizeSkillTags", () => {
  it("returns string[] when API sends string tags", () => {
    assert.deepEqual(normalizeSkillTags(["a", "b"]), ["a", "b"]);
  });

  it("returns [] for internal { latest: versionId } shape", () => {
    assert.deepEqual(normalizeSkillTags({ latest: "k97abc" }), []);
  });
});

describe("dependencyNamesFromParsedClawdis", () => {
  it("collects skill install rows", () => {
    const names = dependencyNamesFromParsedClawdis({
      install: [{ kind: "skill", slug: "other-pack" }],
    });
    assert.ok(names.includes("other-pack"));
  });

  it("collects skills array", () => {
    assert.deepEqual(
      dependencyNamesFromParsedClawdis({ skills: ["alpha", "bad Upper"] }),
      ["alpha"]
    );
  });
});

describe("mapClawHubDetailToSkillMetadata", () => {
  it("maps stats, versions, official badge, install snapshot", () => {
    const detail: ClawHubGetBySlugValue = {
      resolvedSlug: "demo",
      owner: { handle: "alice" },
      skill: {
        _id: "s1",
        slug: "demo",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_710_000_000_000,
        stats: {
          installsAllTime: 42,
          stars: 7,
          versions: 2,
        },
        badges: { official: { at: 1 } },
        tags: ["t1"],
      },
      latestVersion: { version: "1.1.0", createdAt: 1_710_000_000_000 },
    };
    const versions: ClawHubVersionRow[] = [
      { version: "1.0.0", createdAt: 1_700_000_000_000, parsed: null },
      {
        version: "1.1.0",
        createdAt: 1_710_000_000_000,
        parsed: { clawdis: { skills: ["dep-a"] } },
      },
    ];
    const recordedAt = "2026-03-29T12:00:00.000Z";
    const m = mapClawHubDetailToSkillMetadata(detail, versions, recordedAt);
    assert.ok(m);
    assert.equal(m!.skillName, "demo");
    assert.equal(m!.author, "alice");
    assert.equal(m!.verifiedAuthor, true);
    assert.deepEqual(m!.tags, ["t1"]);
    assert.equal(m!.starRating, null);
    assert.equal(m!.starCount, 7);
    assert.equal(m!.latestVersion, "1.1.0");
    assert.equal(m!.installHistory.length, 1);
    assert.equal(m!.installHistory[0]!.installCount, 42);
    assert.equal(m!.installHistory[0]!.recordedAt, recordedAt);
    assert.equal(m!.versionHistory.length, 2);
    assert.equal(m!.versionHistory.filter((v) => v.isLatest).length, 1);
    assert.ok(m!.versionHistory.some((v) => v.version === "1.1.0" && v.isLatest));
    assert.ok(m!.dependencyNames.includes("dep-a"));
  });
});
