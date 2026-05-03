/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { Layout } from "@/features/dashboard/components/layout";
import { StatusBadge } from "@/features/dashboard/components/status-badge";
import { Table } from "@/features/dashboard/components/table";
import type { RunSummary } from "@/features/dashboard/pages/runs";

export type RepoPromptSlot = {
  agent: "parent" | "child";
  configured: boolean;
  currentRevisionId: number | null;
  revisionCount: number;
  updatedAt: string | null;
};

export type RepoDetailPageProps = {
  repo: string;
  repoPromptSlots: RepoPromptSlot[];
  runs: RunSummary[];
};

export const RepoDetailPage: FC<RepoDetailPageProps> = (props) => {
  const { owner, name } = splitRepo(props.repo);
  const repoHref = `/repos/${owner}/${name}`;

  return (
    <Layout title={`${props.repo} · repository`} activeNav="repos">
      <section class="space-y-8">
        <header class="space-y-2">
          <nav class="flex items-center space-x-2 text-sm text-neutral-500">
            <a href="/repositories" class="hover:text-neutral-900 transition-colors">
              repositories
            </a>
            <span class="text-neutral-300">/</span>
            <span class="font-medium text-neutral-900">{props.repo}</span>
          </nav>
          <h1 class="text-3xl font-bold tracking-tight text-neutral-900">
            <a
              href={`https://github.com/${props.repo}`}
              target="_blank"
              rel="noopener noreferrer"
              class="hover:text-brand-600 transition-colors"
            >
              {owner}/<span class="text-brand-600">{name}</span>
            </a>
          </h1>
        </header>

        <section class="space-y-4">
          <div class="space-y-2">
            <h2 class="text-xl font-semibold text-neutral-900">Repository prompts</h2>
            <p class="text-sm text-neutral-500 max-w-3xl">
              Override the global system prompt with repository-specific instructions. Configured
              overrides are appended to each runtime prompt.
            </p>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            {props.repoPromptSlots.map((slot) => (
              <RepoPromptSlotCard key={slot.agent} repoHref={repoHref} slot={slot} />
            ))}
          </div>
        </section>

        <section class="space-y-4">
          <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
            <div class="space-y-1">
              <h2 class="text-xl font-semibold text-neutral-900">Runs</h2>
              <p class="text-sm text-neutral-500">
                {props.runs.length} run{props.runs.length === 1 ? "" : "s"} recorded for this
                repository.
              </p>
            </div>
            <a
              href={`${repoHref}/runs`}
              class="font-mono text-sm text-brand-600 hover:text-brand-700"
            >
              View all runs →
            </a>
          </div>

          {props.runs.length === 0 ? (
            <EmptyRunsState repo={props.repo} />
          ) : (
            <RunsTable runs={props.runs} />
          )}
        </section>
      </section>
    </Layout>
  );
};

const RepoPromptSlotCard: FC<{ repoHref: string; slot: RepoPromptSlot }> = ({ repoHref, slot }) => (
  <article class="bg-surface border border-neutral-200 rounded-xl p-6 space-y-5 shadow-sm">
    <header class="flex items-start justify-between gap-4">
      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="font-mono text-lg font-semibold text-neutral-900">{slot.agent}</h3>
          {slot.configured && (
            <span class="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide bg-success-50 text-success-700 border border-success-200">
              current
            </span>
          )}
        </div>
        <p class="text-sm text-neutral-500">
          {slot.agent === "parent"
            ? "Parent orchestration instructions."
            : "Child execution instructions."}
        </p>
      </div>
      <ConfiguredBadge configured={slot.configured} />
    </header>

    <dl class="grid grid-cols-2 gap-4 pt-4 border-t border-neutral-100">
      <div>
        <dt class="text-xs font-medium text-neutral-500 uppercase tracking-wider">revisions</dt>
        <dd class="mt-1 font-mono text-sm text-neutral-900">{slot.revisionCount}</dd>
      </div>
      <div>
        <dt class="text-xs font-medium text-neutral-500 uppercase tracking-wider">updated</dt>
        <dd class="mt-1 font-mono text-sm text-neutral-500">
          <time datetime={slot.updatedAt ?? ""}>{formatRelativeTime(slot.updatedAt)}</time>
        </dd>
      </div>
    </dl>

    <a
      href={`${repoHref}/prompts/${slot.agent}`}
      class="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-surface bg-brand-600 border border-transparent rounded-md hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors"
    >
      {slot.configured ? "Edit" : "Configure"}
    </a>
  </article>
);

const ConfiguredBadge: FC<{ configured: boolean }> = ({ configured }) => (
  <span
    class={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide border ${
      configured
        ? "bg-brand-50 text-brand-700 border-brand-200"
        : "bg-neutral-50 text-neutral-600 border-neutral-200"
    }`}
  >
    {configured ? "configured" : "not-configured"}
  </span>
);

const RunsTable: FC<{ runs: RunSummary[] }> = ({ runs }) => {
  return (
    <Table
      columns={["run", "repo", "issue", "branch", "started", "status", "tasks", "pr"]}
      sortedColumn="started"
      sortDirection="desc"
    >
      {runs.map((run) => (
        <RunRow key={run.runId} run={run} />
      ))}
    </Table>
  );
};

const RunRow: FC<{ run: RunSummary }> = ({ run }) => {
  const shortRunId = run.runId.slice(0, 8);
  const status = determineStatus(run);
  const { owner, name } = splitRepo(run.repo);
  return (
    <tr class="hover:bg-neutral-50 transition-colors">
      <td class="px-4 py-3">
        <a
          href={`/runs/${run.runId}`}
          class="font-mono text-brand-600 hover:text-brand-700 font-medium"
        >
          {shortRunId}
        </a>
      </td>
      <td class="px-4 py-3">
        <a href={`/repos/${owner}/${name}`} class="font-mono text-neutral-900 hover:text-brand-600">
          {run.repo}
        </a>
      </td>
      <td class="px-4 py-3">
        <a
          href={`https://github.com/${run.repo}/issues/${run.issueNumber}`}
          target="_blank"
          rel="noopener noreferrer"
          class="font-mono text-neutral-900 hover:text-brand-600"
        >
          #{run.issueNumber}
        </a>
      </td>
      <td class="px-4 py-3 font-mono text-neutral-500 text-sm">{run.branch ?? "—"}</td>
      <td class="px-4 py-3 font-mono text-neutral-500 text-sm">{formatDateTime(run.startedAt)}</td>
      <td class="px-4 py-3">
        <StatusBadge status={status} />
      </td>
      <td class="px-4 py-3 font-mono text-neutral-900">{run.subIssueCount}</td>
      <td class="px-4 py-3">
        {run.prUrl ? (
          <a
            href={run.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="font-mono text-brand-600 hover:text-brand-700 text-sm"
          >
            PR →
          </a>
        ) : (
          <span class="text-neutral-400">—</span>
        )}
      </td>
    </tr>
  );
};

function determineStatus(run: RunSummary): "success" | "failure" | "in-progress" | "pending" {
  if (run.status === "completed") return "success";
  if (run.status === "failed" || run.status === "aborted") return "failure";
  if (run.status === "running") return "in-progress";
  if (run.status === "queued") return "pending";
  if (run.prUrl) return "success";
  if (run.failedChildResultCount > 0) return "failure";
  if (run.subIssueCount > 0) return "in-progress";
  return "pending";
}

function formatDateTime(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().replace("T", " ").slice(0, 19)}Z`;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "—";
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = now - then;
  const seconds = Math.max(0, Math.floor(diffMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner = "", name = ""] = repo.split("/");
  return { owner, name };
}

const EmptyRunsState: FC<{ repo: string }> = ({ repo }) => (
  <div class="text-center py-16 px-4 border-2 border-dashed border-neutral-200 rounded-xl bg-surface">
    <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-neutral-100 text-neutral-400 mb-4">
      <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
      </svg>
    </div>
    <h3 class="text-lg font-medium text-neutral-900 mb-1">No runs for {repo}</h3>
    <p class="text-neutral-500 mb-4">このリポジトリに対してまだ実行履歴がありません。</p>
    <a
      href="/runs/new"
      class="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-brand-600 border border-transparent rounded-md hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors"
    >
      Start your first run
    </a>
  </div>
);
