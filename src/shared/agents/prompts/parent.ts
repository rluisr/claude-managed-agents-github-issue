export type BuildParentPromptParams = {
  maxSubIssues: number;
  commitStyle: string;
  git: {
    authorName: string;
    authorEmail: string;
  };
  repoOwner: string;
  repoName: string;
  parentIssueNumber: number;
  branch: string;
  baseBranch: string;
  /**
   * Repository-specific instructions appended to the runtime prompt as an
   * additional section. The body is passed through verbatim. When omitted or
   * blank, no extra section is rendered (preserving byte-identical output for
   * repositories without an override).
   */
  repoPrompt?: string | null;
};

export function buildParentPrompt(params: BuildParentPromptParams): string {
  if (!params.baseBranch) {
    throw new Error("baseBranch is required");
  }

  const {
    maxSubIssues,
    commitStyle,
    git,
    repoOwner,
    repoName,
    parentIssueNumber,
    branch,
    baseBranch,
    repoPrompt,
  } = params;

  const basePrompt = `You are the ORCHESTRATOR. You do not edit code or run tests directly.
Your goal is to resolve GitHub issue #${parentIssueNumber} in ${repoOwner}/${repoName} by decomposing it into smaller, manageable tasks and delegating them to child agents.

MUST NOT edit files directly.

Follow these steps:

Step 1: Read via GitHub MCP \`get_issue\`. Decompose into **no more than ${maxSubIssues} atomic sub-tasks**.
MUST NOT call spawn_child_task more than ${maxSubIssues} times.

Step 2: For each sub-task, call \`create_sub_issue\` custom tool to track progress on GitHub.
MUST handle create_sub_issue returning existing (dedup) without error.

Step 3: For each sub-task, call \`spawn_child_task\` custom tool. Branch name = \`${branch}\`. Prompt includes:
- (a) task spec: Provide clear instructions and acceptance criteria for the child agent.
- (b) branch checkout-first: \`git fetch && git checkout -B ${branch} origin/${branch} || git checkout -B ${branch} origin/${baseBranch}\` then \`git pull --ff-only origin ${branch} || true\`
- (c) commit style = ${commitStyle}
- (d) git identity = ${git.authorName}/${git.authorEmail}
- (e) MUST run \`bun test\` before commit if project has it

If child returns {success:false}, analyze error, generate corrective prompt with explicit additional constraints, retry via \`spawn_child_task\` (max 3 retries per task).

Step 4: After all children succeed, call \`create_final_pr\` custom tool with consolidated title/body to close the parent issue.

Step 5: Emit \`session.status_idle\` by producing final \`agent.message\` with PR URL and exit.`;

  const repoSection = renderRepoPromptSection(repoOwner, repoName, repoPrompt);
  return repoSection === null ? basePrompt : `${basePrompt}\n\n${repoSection}`;
}

function renderRepoPromptSection(
  repoOwner: string,
  repoName: string,
  repoPrompt: string | null | undefined,
): string | null {
  if (typeof repoPrompt !== "string") {
    return null;
  }

  const trimmed = repoPrompt.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return `## Repository-specific instructions for ${repoOwner}/${repoName}\n\n${trimmed}\n\nThese instructions take precedence over generic guidance when they conflict, but you MUST still respect the global guardrails above (no direct file edits, sub-task limits, etc.).`;
}
