/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { Layout } from "@/features/dashboard/components/layout";

export type RunNewPageProps = {
  values?: {
    issue?: string;
    repo?: string;
    dryRun?: boolean;
    vaultId?: string;
    configPath?: string;
  };
  errors?: {
    issue?: string;
    repo?: string;
    dryRun?: string;
    vaultId?: string;
    configPath?: string;
    _form?: string;
  };
};

export const RunNewPage: FC<RunNewPageProps> = ({ values = {}, errors = {} }) => {
  return (
    <Layout title="New Run" activeNav="run-new">
      <div class="max-w-2xl mx-auto">
        <header class="mb-8">
          <h1 class="text-3xl font-bold tracking-tight text-neutral-900 mb-2">Start New Run</h1>
          <p class="text-neutral-500">
            Configure and enqueue a new managed agent run for a GitHub issue.
          </p>
        </header>

        {errors._form && (
          <div class="mb-6 p-4 rounded-md bg-status-failed-bg text-status-failed-fg border border-status-failed-fg/20">
            <p class="text-sm font-medium">{errors._form}</p>
          </div>
        )}

        <form
          method="post"
          action="/runs/new"
          class="space-y-6 bg-surface p-6 sm:p-8 rounded-xl border border-neutral-200 shadow-sm"
        >
          <div class="space-y-4">
            <div>
              <label htmlFor="repo" class="block text-sm font-medium text-neutral-900 mb-1">
                Repository <span class="text-brand-600">*</span>
              </label>
              <input
                type="text"
                id="repo"
                name="repo"
                required
                pattern="[\w.-]+/[\w.-]+"
                placeholder="WinTicket/server"
                value={values.repo ?? ""}
                class={`block w-full rounded-md shadow-sm sm:text-sm px-3 py-2 border focus:ring-2 focus:ring-offset-0 outline-none transition-colors ${
                  errors.repo
                    ? "border-status-failed-fg/50 focus:border-status-failed-fg focus:ring-status-failed-fg/20 bg-status-failed-bg/30"
                    : "border-neutral-300 focus:border-brand-500 focus:ring-brand-500/20 bg-surface"
                }`}
              />
              {errors.repo ? (
                <p class="mt-1 text-sm text-status-failed-fg">{errors.repo}</p>
              ) : (
                <p class="mt-1 text-xs text-neutral-500">Format: owner/repository</p>
              )}
            </div>

            <div>
              <label htmlFor="issue" class="block text-sm font-medium text-neutral-900 mb-1">
                Issue Number <span class="text-brand-600">*</span>
              </label>
              <div class="relative">
                <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <span class="text-neutral-500 sm:text-sm">#</span>
                </div>
                <input
                  type="number"
                  id="issue"
                  name="issue"
                  required
                  min="1"
                  placeholder="42"
                  value={values.issue ?? ""}
                  class={`block w-full pl-7 rounded-md shadow-sm sm:text-sm px-3 py-2 border focus:ring-2 focus:ring-offset-0 outline-none transition-colors ${
                    errors.issue
                      ? "border-status-failed-fg/50 focus:border-status-failed-fg focus:ring-status-failed-fg/20 bg-status-failed-bg/30"
                      : "border-neutral-300 focus:border-brand-500 focus:ring-brand-500/20 bg-surface"
                  }`}
                />
              </div>
              {errors.issue && <p class="mt-1 text-sm text-status-failed-fg">{errors.issue}</p>}
            </div>

            <div>
              <label htmlFor="vaultId" class="block text-sm font-medium text-neutral-900 mb-1">
                Vault ID <span class="text-neutral-400 font-normal">(Optional)</span>
              </label>
              <input
                type="text"
                id="vaultId"
                name="vaultId"
                placeholder="vlt_..."
                value={values.vaultId ?? ""}
                class={`block w-full rounded-md shadow-sm sm:text-sm px-3 py-2 border focus:ring-2 focus:ring-offset-0 outline-none transition-colors ${
                  errors.vaultId
                    ? "border-status-failed-fg/50 focus:border-status-failed-fg focus:ring-status-failed-fg/20 bg-status-failed-bg/30"
                    : "border-neutral-300 focus:border-brand-500 focus:ring-brand-500/20 bg-surface"
                }`}
              />
              {errors.vaultId ? (
                <p class="mt-1 text-sm text-status-failed-fg">{errors.vaultId}</p>
              ) : (
                <p class="mt-1 text-xs text-neutral-500">Reuse an existing Anthropic vault</p>
              )}
            </div>

            <div>
              <label htmlFor="configPath" class="block text-sm font-medium text-neutral-900 mb-1">
                Config Path <span class="text-neutral-400 font-normal">(Optional)</span>
              </label>
              <input
                type="text"
                id="configPath"
                name="configPath"
                placeholder="./my.config.ts"
                value={values.configPath ?? ""}
                class={`block w-full rounded-md shadow-sm sm:text-sm px-3 py-2 border focus:ring-2 focus:ring-offset-0 outline-none transition-colors ${
                  errors.configPath
                    ? "border-status-failed-fg/50 focus:border-status-failed-fg focus:ring-status-failed-fg/20 bg-status-failed-bg/30"
                    : "border-neutral-300 focus:border-brand-500 focus:ring-brand-500/20 bg-surface"
                }`}
              />
              {errors.configPath && (
                <p class="mt-1 text-sm text-status-failed-fg">{errors.configPath}</p>
              )}
            </div>

            <div class="pt-2">
              <div class="flex items-start">
                <div class="flex items-center h-5">
                  <input
                    id="dryRun"
                    name="dryRun"
                    type="checkbox"
                    checked={values.dryRun}
                    class="focus:ring-brand-500 h-4 w-4 text-brand-600 border-neutral-300 rounded"
                  />
                </div>
                <div class="ml-3 text-sm">
                  <label htmlFor="dryRun" class="font-medium text-neutral-900">
                    Dry Run
                  </label>
                  <p class="text-neutral-500">
                    Enqueue the run in dry-run mode without remote execution.
                  </p>
                </div>
              </div>
              {errors.dryRun && (
                <p class="mt-1 text-sm text-status-failed-fg ml-7">{errors.dryRun}</p>
              )}
            </div>
          </div>

          <div class="pt-4 border-t border-neutral-200 flex justify-end">
            <button
              type="submit"
              class="inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-brand-600 hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors"
            >
              Start Run
            </button>
          </div>
        </form>
      </div>
    </Layout>
  );
};
