import { describe, expect, it } from "bun:test";
import { buildParentPrompt } from "../parent";

describe("buildParentPrompt", () => {
  const defaultParams = {
    maxSubIssues: 10,
    commitStyle: "conventional",
    git: {
      authorName: "claude-agent[bot]",
      authorEmail: "claude-agent@users.noreply.github.com",
    },
    repoOwner: "rluisr",
    repoName: "claude-managed-agents",
    parentIssueNumber: 123,
    branch: "agent/issue-123/fix-bug",
    baseBranch: "main",
  };

  it("should contain all mandatory phrases", () => {
    const prompt = buildParentPrompt(defaultParams);

    expect(prompt).toContain(
      "You are the ORCHESTRATOR. You do not edit code or run tests directly.",
    );
    expect(prompt).toContain("GitHub issue #123 in rluisr/claude-managed-agents");
    expect(prompt).toContain("no more than 10 atomic sub-tasks");
    expect(prompt).toContain("call `create_sub_issue` custom tool");
    expect(prompt).toContain("call `spawn_child_task` custom tool");
    expect(prompt).toContain("Branch name = `agent/issue-123/fix-bug`.");
    expect(prompt).toContain(
      "git fetch && git checkout -B agent/issue-123/fix-bug origin/agent/issue-123/fix-bug || git checkout -B agent/issue-123/fix-bug origin/main",
    );
    expect(prompt).toContain("git pull --ff-only origin agent/issue-123/fix-bug || true");
    expect(prompt).toContain("commit style = conventional");
    expect(prompt).toContain(
      "git identity = claude-agent[bot]/claude-agent@users.noreply.github.com",
    );
    expect(prompt).toContain("MUST run `bun test` before commit if project has it");
    expect(prompt).toContain("call `create_final_pr` custom tool with consolidated title/body");
    expect(prompt).toContain(
      "Emit `session.status_idle` by producing final `agent.message` with PR URL and exit",
    );
    expect(prompt).toContain("MUST NOT edit files directly");
    expect(prompt).toContain("MUST NOT call spawn_child_task more than 10 times");
    expect(prompt).toContain(
      "MUST handle create_sub_issue returning existing (dedup) without error",
    );
    expect(prompt).toContain(
      "If child returns {success:false}, analyze error, generate corrective prompt with explicit additional constraints, retry via `spawn_child_task` (max 3 retries per task)",
    );
  });

  it("should interpolate configuration values correctly", () => {
    const params = {
      ...defaultParams,
      maxSubIssues: 5,
      commitStyle: "gitmoji",
      git: {
        authorName: "custom-bot",
        authorEmail: "custom@example.com",
      },
      baseBranch: "develop",
    };
    const prompt = buildParentPrompt(params);

    expect(prompt).toContain("no more than 5 atomic sub-tasks");
    expect(prompt).toContain("MUST NOT call spawn_child_task more than 5 times");
    expect(prompt).toContain("commit style = gitmoji");
    expect(prompt).toContain("git identity = custom-bot/custom@example.com");
    expect(prompt).toContain("origin/develop");

    expect(prompt).not.toContain("{maxSubIssues}");
    expect(prompt).not.toContain("{commitStyle}");
    expect(prompt).not.toContain("{authorName}");
    expect(prompt).not.toContain("{authorEmail}");
    expect(prompt).not.toContain("{baseBranch}");
  });

  it("should throw an error if baseBranch is an empty string at runtime", () => {
    expect(() => buildParentPrompt({ ...defaultParams, baseBranch: "" })).toThrow(
      "baseBranch is required",
    );
  });

  it("should be within the token limit (approx 8192 tokens / 32000 bytes)", () => {
    const prompt = buildParentPrompt(defaultParams);
    expect(prompt.length < 32000).toBe(true);
  });
});
