/** @jsxImportSource hono/jsx */
import type { FC, PropsWithChildren } from "hono/jsx";

export type LayoutProps = PropsWithChildren<{
  title: string;
  activeNav?: "repos" | "runs" | "run-detail" | "prompts" | "run-new";
  enhanced?: boolean;
}>;

export const Layout: FC<LayoutProps> = (props) => {
  return (
    <html lang="en" class="antialiased text-neutral-900 bg-surface-muted">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} · github-issue dashboard</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="/assets/dashboard.css" />
      </head>
      <body class="min-h-screen flex flex-col font-sans">
        <nav class="bg-surface border-b border-neutral-200 sticky top-0 z-10">
          <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex flex-col md:flex-row md:items-center md:justify-between h-auto md:h-16 py-3 md:py-0">
              <div class="flex-shrink-0 mb-3 md:mb-0">
                <a
                  href="/"
                  class="font-mono font-semibold tracking-tight text-neutral-900 hover:text-brand-600 transition-colors"
                >
                  github-issue<span class="text-neutral-400 font-normal ml-2">dashboard</span>
                </a>
              </div>
              <div class="flex overflow-x-auto pb-1 md:pb-0 -mb-px md:mb-0 space-x-6 md:space-x-8">
                <a
                  href="/runs"
                  class={`whitespace-nowrap py-2 md:py-5 border-b-2 text-sm font-medium transition-colors ${
                    props.activeNav === "runs"
                      ? "border-brand-500 text-brand-600"
                      : "border-transparent text-neutral-500 hover:text-neutral-900 hover:border-neutral-300"
                  }`}
                >
                  Runs
                </a>
                <a
                  href="/runs/new"
                  class={`whitespace-nowrap py-2 md:py-5 border-b-2 text-sm font-medium transition-colors ${
                    props.activeNav === "run-new"
                      ? "border-brand-500 text-brand-600"
                      : "border-transparent text-neutral-500 hover:text-neutral-900 hover:border-neutral-300"
                  }`}
                >
                  New Run
                </a>
                <a
                  href="/repositories"
                  class={`whitespace-nowrap py-2 md:py-5 border-b-2 text-sm font-medium transition-colors ${
                    props.activeNav === "repos"
                      ? "border-brand-500 text-brand-600"
                      : "border-transparent text-neutral-500 hover:text-neutral-900 hover:border-neutral-300"
                  }`}
                >
                  Repositories
                </a>
                <a
                  href="/prompts"
                  class={`whitespace-nowrap py-2 md:py-5 border-b-2 text-sm font-medium transition-colors ${
                    props.activeNav === "prompts"
                      ? "border-brand-500 text-brand-600"
                      : "border-transparent text-neutral-500 hover:text-neutral-900 hover:border-neutral-300"
                  }`}
                >
                  Prompts
                </a>
              </div>
            </div>
          </div>
        </nav>
        <main class="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {props.children}
        </main>
        <footer class="bg-surface border-t border-neutral-200 mt-auto">
          <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <p class="text-xs text-neutral-500 font-mono text-center md:text-left">
              {props.enhanced
                ? "SSR + progressive enhancement · built with Hono + bun:sqlite"
                : "SSR · no JS · built with Hono + bun:sqlite"}
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
};
