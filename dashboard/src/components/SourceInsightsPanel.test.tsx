import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import SourceInsightsPanel, {
  ImportedMetadataCard,
  PipelineTimingsCard,
  parseAnalysisInsights,
} from "./SourceInsightsPanel";

describe("parseAnalysisInsights", () => {
  it("returns null for empty input", () => {
    expect(parseAnalysisInsights(null)).toBeNull();
    expect(parseAnalysisInsights(undefined)).toBeNull();
    expect(parseAnalysisInsights("")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseAnalysisInsights("{not json")).toBeNull();
  });

  it("parses valid JSON", () => {
    const raw = JSON.stringify({ complexity: "moderate", scriptFiles: 2 });
    const p = parseAnalysisInsights(raw);
    expect(p?.complexity).toBe("moderate");
    expect(p?.scriptFiles).toBe(2);
  });
});

describe("PipelineTimingsCard", () => {
  it("renders nothing when all timings are absent", () => {
    const { container } = render(<PipelineTimingsCard />);
    expect(container.firstChild).toBeNull();
  });

  it("renders step labels and ms values", () => {
    render(
      <PipelineTimingsCard
        extract_ms={10}
        static_analysis_ms={20}
        llm_ms={null}
        file_stats_ms={5}
        pipeline_ms={100}
      />
    );
    expect(screen.getByText("Pipeline timings")).toBeInTheDocument();
    expect(screen.getByText("Extract")).toBeInTheDocument();
    expect(screen.getByText("10 ms")).toBeInTheDocument();
    expect(screen.getByText("100 ms")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });
});

describe("ImportedMetadataCard", () => {
  it("renders nothing without import_meta_recorded_at", () => {
    const { container } = render(<ImportedMetadataCard />);
    expect(container.firstChild).toBeNull();
  });

  it("shows imported fields when recorded_at is set", () => {
    render(
      <ImportedMetadataCard
        import_meta_recorded_at="2026-03-15T12:00:00.000Z"
        import_meta_author="alice"
        import_meta_verified_author={1}
        import_meta_tags={JSON.stringify(["a", "b"])}
        import_meta_star_rating={4.2}
        import_meta_star_count={9}
        import_meta_latest_version="2.0.0"
        import_meta_total_versions={3}
        import_meta_dependency_count={1}
        import_meta_first_published_at="2026-01-01T00:00:00.000Z"
        import_meta_last_updated_at="2026-03-01T00:00:00.000Z"
      />
    );
    expect(screen.getByText("Imported metadata")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
  });
});

describe("SourceInsightsPanel", () => {
  it("renders structured sections from insights", () => {
    const insights = parseAnalysisInsights(
      JSON.stringify({
        complexity: "complex",
        scriptFiles: 5,
        totalLoc: 200,
        primaryLanguage: "typescript",
        languageBreakdown: [{ language: "typescript", files: 3 }],
        describedLanguages: ["typescript"],
        undocumentedLanguages: [],
        missingFromCode: [],
        credentialHygiene: {
          declaredCredentialVars: [],
          observedCredentialVars: [],
          undeclaredCredentialVars: [],
          declaredButUnusedCredentialVars: [],
          hasEnvExample: true,
          envExampleCoverage: 1,
          hygieneScore: 0.9,
          hygieneLevel: "good",
        },
        securityFindings: {
          filesScanned: 10,
          dangerousMatches: 0,
          secretMatches: 0,
          exfiltrationMatches: 0,
          flaggedFiles: [],
          potentialDataLeakage: false,
        },
      })
    );
    expect(insights).not.toBeNull();
    render(<SourceInsightsPanel insights={insights} rawJson="{}" />);
    expect(screen.getByText("Source insights")).toBeInTheDocument();
    expect(screen.getByText("complex")).toBeInTheDocument();
    expect(screen.getByText("Language breakdown")).toBeInTheDocument();
    expect(screen.getAllByText("typescript").length).toBeGreaterThanOrEqual(1);
  });

  it("shows raw JSON section when rawJson is provided", () => {
    const raw = JSON.stringify({ complexity: "simple" });
    const insights = parseAnalysisInsights(raw);
    render(<SourceInsightsPanel insights={insights} rawJson={raw} />);
    expect(screen.getByText("Raw analysis_insights JSON")).toBeInTheDocument();
  });
});
