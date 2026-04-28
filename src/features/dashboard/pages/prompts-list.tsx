/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { Layout } from "@/features/dashboard/components/layout";
import { Table } from "@/features/dashboard/components/table";

export type PromptListEntry = {
  promptKey: "parent.system" | "child.system" | "parent.runtime" | "child.runtime";
  editable: boolean;
  updatedAt: string | null; // ISO; null if never seeded
  revisionCount: number;
};

export type PromptsListPageProps = {
  prompts: PromptListEntry[];
};

export const PromptsListPage: FC<PromptsListPageProps> = (props) => {
  return (
    <Layout title="Prompts" activeNav="prompts">
      <section class="prompts-page space-y-6">
        <header class="page-header">
          <h1 class="page-title text-3xl font-bold tracking-tight text-neutral-900">Prompts</h1>
          <p class="page-subtitle text-neutral-500">
            system prompts: editable / runtime templates: read-only
          </p>
        </header>
        {props.prompts.length === 0 ? (
          <div class="empty-state text-center py-16 px-4 border-2 border-dashed border-neutral-200 rounded-xl bg-surface">
            <div class="empty-state-icon text-4xl mb-4">⎋</div>
            <div class="empty-state-title text-lg font-medium text-neutral-900 mb-2">
              No prompts seeded yet
            </div>
            <div class="empty-state-hint text-neutral-500">
              No prompts seeded yet. Restart the CLI or run "serve" to seed defaults.
            </div>
          </div>
        ) : (
          <div class="prompt-list-table">
            <Table columns={["key", "editable", "revisions", "updated", "details"]}>
              {props.prompts.map((entry) => (
                <tr key={entry.promptKey}>
                  <td class="prompt-key-cell">
                    <a
                      href={`/prompts/${entry.promptKey}`}
                      data-prompt-key={entry.promptKey}
                      class="font-mono text-brand-600 hover:underline"
                    >
                      {entry.promptKey}
                    </a>
                  </td>
                  <td>
                    <span
                      class={`prompt-badge ${entry.editable ? "editable bg-success-50 text-success-700 border-success-200" : "readonly bg-neutral-50 text-neutral-600 border-neutral-200"} inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide border`}
                    >
                      {entry.editable ? "editable" : "read-only"}
                    </span>
                  </td>
                  <td class="mono font-mono">{entry.revisionCount}</td>
                  <td class="mono muted font-mono text-neutral-500">
                    {formatRelativeTime(entry.updatedAt)}
                  </td>
                  <td>
                    <a
                      href={`/prompts/${entry.promptKey}`}
                      class="mono font-mono text-brand-600 hover:underline"
                    >
                      view →
                    </a>
                  </td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </section>
    </Layout>
  );
};

// Helper - render a short relative time string like "3h ago" or fall back to date
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
