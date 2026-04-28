import { describe, expect, it } from "bun:test";
import type { DecomposedTask } from "@/shared/types";
import { buildChildPrompt } from "../child";

describe("buildChildPrompt", () => {
  const mockGit = {
    authorName: "claude-agent[bot]",
    authorEmail: "claude-agent@users.noreply.github.com",
  };

  const mockTask: DecomposedTask = {
    id: "task-1",
    title: "Implement feature X",
    description: "Add feature X to the codebase",
    acceptanceCriteria: ["AC1: Feature X works", "AC2: Tests pass"],
  };

  const defaultArgs = {
    repoOwner: "owner",
    repoName: "repo",
    branch: "feature/x",
    baseBranch: "main",
    git: mockGit,
    task: mockTask,
    commitStyle: "conventional" as const,
  };

  it("should contain the branch-first checkout protocol verbatim", () => {
    const prompt = buildChildPrompt(defaultArgs);

    expect(prompt).toContain('git config user.name "claude-agent[bot]"');
    expect(prompt).toContain('git config user.email "claude-agent@users.noreply.github.com"');
    expect(prompt).toContain("git fetch origin");
    expect(prompt).toContain(
      "git checkout -B feature/x origin/feature/x || git checkout -B feature/x origin/main",
    );
    expect(prompt).toContain("git pull --ff-only origin feature/x || true");
  });

  it("should contain the MUST NOT spawn/invoke/call child guardrails", () => {
    const prompt = buildChildPrompt(defaultArgs);

    expect(prompt).toMatch(/MUST NOT (spawn|invoke|call).*child/);
    expect(prompt).toContain("MUST NOT spawn any child agent");
    expect(prompt).toContain("MUST NOT invoke sub-agents");
    expect(prompt).toContain("MUST NOT call spawn_child_task");
  });

  it("should render commit style correctly (conventional)", () => {
    const prompt = buildChildPrompt({ ...defaultArgs, commitStyle: "conventional" });
    expect(prompt).toContain("Commit in conventional format ({type}({scope}): {subject})");
  });

  it("should render commit style correctly (plain)", () => {
    const prompt = buildChildPrompt({ ...defaultArgs, commitStyle: "plain" });
    expect(prompt).toContain("Commit in plain format ({type}({scope}): {subject})");
  });

  it("should include prior commits context if provided", () => {
    const priorCommits = [
      { sha: "abc1234", message: "feat: initial work" },
      { sha: "def5678", message: "fix: minor bug" },
    ];
    const prompt = buildChildPrompt({ ...defaultArgs, priorCommits });

    expect(prompt).toContain("Prior commits on this branch:");
    expect(prompt).toContain("abc1234: feat: initial work");
    expect(prompt).toContain("def5678: fix: minor bug");
  });

  it("should include role and acceptance criteria", () => {
    const prompt = buildChildPrompt(defaultArgs);

    expect(prompt).toContain(
      "You are a task-implementer. Your task: Implement feature X — Add feature X to the codebase",
    );
    expect(prompt).toContain("- AC1: Feature X works");
    expect(prompt).toContain("- AC2: Tests pass");
  });

  it("should include return JSON format", () => {
    const prompt = buildChildPrompt(defaultArgs);
    expect(prompt).toContain("Return JSON via user.custom_tool_result:");
    expect(prompt).toContain("taskId");
    expect(prompt).toContain("success");
    expect(prompt).toContain("commitSha");
    expect(prompt).toContain("filesChanged");
    expect(prompt).toContain("testOutput");
  });
});
