# AGENTS.md — github-issue-agent

## ランタイムとツールチェイン

- **Bun 1.3+** — TS を直接実行。ビルドステップなし (`bun run build` は no-op)
- **TypeScript** — `strict: true` + `noUncheckedIndexedAccess: true`
- **パスエイリアス** — `@/*` → `./src/*` (tsconfig `paths`)。import は `@/shared/config` のように書く
- **Biome** — formatter + linter 一体。space indent 2, line width 100, recommended rules
- **SDK** — `@anthropic-ai/sdk@0.90.0`。lockfile でピン留め
- **Tailwind CSS v4** — WebUI のスタイリングに使用

## コマンド

```bash
bun run start              # bun run index.ts
bun run dev                # bun run --watch index.ts (開発時)
bun run build              # bun run build:css (CSS minify)
bun run build:css          # tailwindcss minified output to dist/dashboard.css
bun run dev:css            # tailwindcss watch mode
bun run typecheck          # tsc --noEmit
bun run lint               # biome check .
bun test                   # 全テスト
bun test src/features/run-api/__tests__/server.test.ts   # 単一ファイル
bun test --coverage        # カバレッジ (line 75%, function 50% 閾値: bunfig.toml)
```

検証順: `lint` → `typecheck` → `test`

## アーキテクチャ

Vertical Slice Architecture を採用。`src/features/` 配下の各ディレクトリが 1 つのユースケースを自己完結的に持ち、レイヤー横断の共有コードは `src/shared/` に置く。

```
src/
  features/
    run-api/                # HTTP API routes (POST /api/runs, SSE multiplexer, etc.)
    run-execution/          # Orchestration core (runIssueOrchestration, event-bridge)
    run-queue/              # FIFO queue + DB-persisted status
    run-stop/               # Run cancellation logic
    dashboard/              # Hono SSR + Tailwind WebUI (pages, components, styles)
    decomposition/          # issue → sub-issue 分解 (github-write)
    child-execution/        # 子エージェント spawn
    finalize-pr/            # 最終 PR 作成
    preflight/              # 実行前バリデーション
  shared/
    agents/                 # parent/child agent definition, registry, environment, prompts
    github/                 # Octokit wrapper, 型, issue read プリミティブ
    persistence/            # SQLite db module + schemas (runs, sessions, run_events, prompts, etc.)
    prompts/                # default prompt seeding + loader
    run-events/             # EventEmitter + DB-backed event log + Last-Event-ID
    session.ts              # Managed Agents イベントループ
    config.ts               # zod スキーマ + 環境変数オーバーライド
    state.ts                # .github-issue-agent/ 下の JSON 状態 + proper-lockfile
    vault.ts                # Anthropic Vault / Credential 管理
    signals.ts              # SIGINT/SIGTERM/uncaught 用 cleanup registry
    logging.ts              # pino ログ (token 自動マスク)
    constants.ts            # モデル名, MCP URL, ツール名, ファイルパス定数
    types.ts                # RunStatus/RunPhase/RunEvent/RunSummary 等
index.ts                    # HTTP サーバーのエントリポイント (bun run index.ts)
```

## 設計パターン

- **Vertical Slice**: 各機能は `handler.ts` (ロジック), `schemas.ts` (zod), `tool-definition.ts` (Anthropic tool 定義) の 3 ファイル構成。新ツール追加時はこのパターンに従う
- **Hono SSR**: WebUI は Hono を使用したサーバーサイドレンダリングで構成され、クライアントサイド JS を最小限に抑えている
- **DI**: 主要モジュール (`persistence`, `registry`, `logging`) は `createXxxModule(overrides)` で依存を注入可能。テストでは実 I/O をモックする
- **Agent registry**: エージェント定義のハッシュを比較し、変更時のみ API に update を送る。
- **Runtime state**: `.github-issue-agent/dashboard.db` (SQLite) に実行状態を永続化。

## テスト

- テストは `__tests__/` ディレクトリにソースと colocate
- `bunfig.toml` で `test/setup.ts` を preload (現在は空)
- `test/fixtures/` に Anthropic API のフェイククライアント (`fake-anthropic.ts`, `fake-anthropic-sessions.ts`)
- E2E テスト (`scripts/e2e-real.ts`) は実 API を呼ぶため `E2E=1`, `TEST_REPO`, `TEST_ISSUE` が必須。詳細は `docs/e2e-setup.md`

## 環境変数

| 変数 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API キー (必須) |
| `GITHUB_TOKEN` | GitHub PAT (必須。classic: `repo`, fine-grained: contents:read, issues:write, pull_requests:write) |
| `PORT` | サーバーの listen ポート (default: 3000) |
| `DB_PATH` | SQLite データベースのパス |
| `PARENT_MODEL` / `CHILD_MODEL` | モデル名オーバーライド |

## SDK バージョン依存

- `@anthropic-ai/sdk@0.90.0` で動作確認済み
- `thinking` / `budget_tokens` は SDK 未対応のため無効化中。対象箇所は `TODO(sdk-v0.91): re-enable thinking at MAX budget` で grep 可能
- `constants.ts` の `MAX_THINKING_BUDGET_DEFERRED` センチネルが存在を保証

## 注意事項

- `.github-issue-agent/` は gitignore 済みのランタイムディレクトリ。
- `src/shared/logging.ts` が GitHub token / Anthropic key を自動マスクする。ログに credential が漏れる場合はここを確認
