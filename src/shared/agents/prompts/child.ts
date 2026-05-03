import type { DecomposedTask } from "@/shared/types";

export type BuildChildPromptArgs = {
  repoOwner: string;
  repoName: string;
  branch: string;
  baseBranch: string;
  git: {
    authorName: string;
    authorEmail: string;
  };
  task: DecomposedTask;
  commitStyle: string;
  priorCommits?: Array<{ sha: string; message: string }>;
  /**
   * Repository-specific instructions appended to the runtime prompt as an
   * additional section. The body is passed through verbatim. When omitted or
   * blank, no extra section is rendered (preserving byte-identical output for
   * repositories without an override).
   */
  repoPrompt?: string | null;
};

export function buildChildPrompt({
  repoOwner,
  repoName,
  branch,
  baseBranch,
  git,
  task,
  commitStyle,
  priorCommits,
  repoPrompt,
}: BuildChildPromptArgs): string {
  const acList = task.acceptanceCriteria.map((ac) => `- ${ac}`).join("\n");

  const priorCommitsSection =
    priorCommits && priorCommits.length > 0
      ? `
Prior commits on this branch:
${priorCommits.map((c) => `${c.sha}: ${c.message}`).join("\n")}
`
      : "";

  const basePrompt = `You are a task-implementer. Your task: ${task.title} — ${task.description}

Repository: ${repoOwner}/${repoName}

Acceptance criteria:
${acList}

MANDATORY first step: configure git + checkout branch
\`\`\`
git config user.name "${git.authorName}"
git config user.email "${git.authorEmail}"
git fetch origin
git checkout -B ${branch} origin/${branch} || git checkout -B ${branch} origin/${baseBranch}
git pull --ff-only origin ${branch} || true
\`\`\`

Implementation guidance:
- Focus on the specific task assigned.
- Follow existing patterns and style in the repository.
- Do not install unrelated dependencies.
- Do not edit files outside the repository.

Before commit: run \`bun test\` if \`package.json\` has a test script; if not, explain why it's not applicable.

Commit in ${commitStyle} format ({type}({scope}): {subject})

Push: \`git push -u origin ${branch}\`

Return JSON via user.custom_tool_result:
\`\`\`
{
  "taskId": "${task.id}",
  "success": true|false,
  "commitSha": "...",
  "filesChanged": ["..."],
  "testOutput": "...",
  "error": {
    "type": "...",
    "message": "...",
    "stderr": "..."
  }
}
\`\`\`
${priorCommitsSection}
Critical guardrails:
- MUST NOT spawn any child agent
- MUST NOT invoke sub-agents
- MUST NOT call spawn_child_task
- MUST NOT install unrelated dependencies
- MUST NOT edit files outside the repository
- MUST NOT push to any branch other than ${branch}
- MUST NOT run destructive commands (e.g., rm -rf /)
`;

  const repoSection = renderRepoPromptSection(repoOwner, repoName, repoPrompt);
  return repoSection === null ? basePrompt : `${basePrompt}\n${repoSection}\n`;
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

  return `\n## Repository-specific instructions for ${repoOwner}/${repoName}\n\n${trimmed}\n\nThese instructions take precedence over generic guidance when they conflict, but you MUST still respect the critical guardrails above.`;
}
