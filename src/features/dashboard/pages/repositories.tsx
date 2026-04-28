/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { Layout } from "@/features/dashboard/components/layout";

export type Repository = {
  repo: string; // "owner/name"
  runCount: number;
  lastRunAt: string | null; // ISO timestamp
};

export type RepositoriesPageProps = {
  repositories: Repository[];
};

export const RepositoriesPage: FC<RepositoriesPageProps> = (props) => {
  return (
    <Layout title="Repositories" activeNav="repos">
      <section class="space-y-6">
        <header class="space-y-2">
          <h1 class="text-3xl font-bold tracking-tight text-neutral-900">Repositories</h1>
          <p class="text-neutral-500">
            agent ran against {props.repositories.length} repositor
            {props.repositories.length === 1 ? "y" : "ies"}
          </p>
        </header>
        {props.repositories.length === 0 ? (
          <EmptyState />
        ) : (
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {props.repositories.map((repo, idx) => (
              <RepoCard repo={repo} delayMs={idx * 50} />
            ))}
          </div>
        )}
      </section>
    </Layout>
  );
};

const RepoCard: FC<{ repo: Repository; delayMs: number }> = ({ repo, delayMs }) => {
  const [owner, name] = repo.repo.split("/");
  const href = `/repos/${owner}/${name}`;
  return (
    <a
      href={href}
      class="group block p-6 bg-surface border border-neutral-200 rounded-xl hover:border-brand-500 hover:shadow-md transition-all duration-200 animate-fade-in-up"
      style={`animation-delay: ${delayMs}ms; animation-fill-mode: both;`}
    >
      <div class="flex items-baseline space-x-1 mb-4">
        <span class="text-neutral-500 font-medium">{owner}/</span>
        <span class="text-xl font-bold text-neutral-900 group-hover:text-brand-600 transition-colors">
          {name}
        </span>
      </div>
      <div class="flex items-center justify-between text-sm">
        <span class="inline-flex items-center px-2.5 py-0.5 rounded-full bg-neutral-100 text-neutral-700 font-medium">
          {repo.runCount} run{repo.runCount === 1 ? "" : "s"}
        </span>
        <time class="text-neutral-500 font-mono" datetime={repo.lastRunAt ?? ""}>
          {formatRelativeTime(repo.lastRunAt)}
        </time>
      </div>
    </a>
  );
};

const EmptyState: FC = () => {
  return (
    <div class="text-center py-16 px-4 border-2 border-dashed border-neutral-200 rounded-xl bg-surface">
      <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-neutral-100 text-neutral-400 mb-4">
        <svg
          class="w-6 h-6"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 002-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
          />
        </svg>
      </div>
      <h3 class="text-lg font-medium text-neutral-900 mb-1">No runs yet</h3>
      <p class="text-neutral-500 mb-4">
        まだ実行履歴がありません。
        <a href="/runs/new" class="font-medium text-brand-600 hover:text-brand-700">
          New Run
        </a>
        から issue を指定して実行すると、ここに履歴が表示されます。
      </p>
    </div>
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
