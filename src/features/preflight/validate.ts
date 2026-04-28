import { readIssue } from "@/shared/github/issues";

type HeadersRecord = Record<string, string | number | undefined>;

type GitHubApiResponse<TData = unknown> = {
  data: TData;
  headers?: HeadersRecord;
  status?: number;
};

type GitHubPreflightClient = {
  paginate: (route: string, parameters?: Record<string, unknown>) => Promise<unknown[]>;
  request: (
    route: string,
    parameters?: Record<string, unknown>,
  ) => Promise<GitHubApiResponse<unknown>>;
};

type AnthropicPreflightClient = {
  beta?: {
    agents?: {
      list: (parameters: { limit: number }) => Promise<unknown>;
    };
  };
};

type GitHubUserRecord = {
  login: string;
};

type GitHubRepoRecord = {
  default_branch: string;
  permissions?: Record<string, unknown>;
};

type GitHubPermissionRecord = {
  permission?: string;
  role_name?: string;
};

export type PreflightResult = {
  anthropic: {
    checked: boolean;
  };
  github: {
    defaultBranch: string;
    permissions: Record<string, unknown>;
  };
};

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class InvalidGitHubTokenError extends AuthError {
  constructor() {
    super(
      "GitHub token is invalid or expired.\nAction to fix: set GITHUB_TOKEN to a valid token with repo (or contents: read), issues: write, and pull_requests: write access.",
    );
    this.name = "InvalidGitHubTokenError";
  }
}

export class RepoNotFoundError extends Error {
  constructor(owner: string, repo: string) {
    super(
      `Repository ${owner}/${repo} was not found or is not accessible with the current GitHub token.\nAction to fix: confirm --repo is correct and that GITHUB_TOKEN can access this repository.`,
    );
    this.name = "RepoNotFoundError";
  }
}

export class ParentIssueClosedError extends Error {
  constructor(issueNumber: number) {
    super(
      `Parent issue #${issueNumber} is closed.\nAction to fix: reopen the parent issue or choose an open issue number.`,
    );
    this.name = "ParentIssueClosedError";
  }
}

export class InsufficientScopesError extends AuthError {
  readonly missingScopes: string[];

  constructor(missingScopes: string[]) {
    super(
      `GitHub token is missing required permissions: ${missingScopes.join(", ")}.\nAction to fix: grant repo (or contents: read), issues: write, and pull_requests: write to GITHUB_TOKEN.`,
    );
    this.missingScopes = missingScopes;
    this.name = "InsufficientScopesError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractStatus(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const statusValue = error.status;
  return typeof statusValue === "number" ? statusValue : undefined;
}

function parseOAuthScopes(headers?: HeadersRecord): string[] {
  const rawScopesHeader = headers?.["x-oauth-scopes"];
  if (typeof rawScopesHeader !== "string") {
    return [];
  }

  return rawScopesHeader
    .split(",")
    .map((scopeEntry) => scopeEntry.trim())
    .filter((scopeEntry) => scopeEntry.length > 0);
}

function parseAcceptedPermissions(headers?: HeadersRecord): Record<string, string> {
  const rawPermissionsHeader = headers?.["x-accepted-github-permissions"];
  if (typeof rawPermissionsHeader !== "string") {
    return {};
  }

  return Object.fromEntries(
    rawPermissionsHeader
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const separatorIndex = entry.indexOf("=");
        if (separatorIndex < 0) {
          return [entry, "true"] as const;
        }

        const permissionName = entry.slice(0, separatorIndex).trim();
        const permissionValue = entry.slice(separatorIndex + 1).trim();
        return [permissionName, permissionValue] as const;
      }),
  );
}

function assertUserRecord(value: unknown): GitHubUserRecord {
  if (!isRecord(value) || typeof value.login !== "string") {
    throw new Error(
      "Invalid GitHub user payload.\nAction to fix: retry with a valid GitHub token.",
    );
  }

  return {
    login: value.login,
  };
}

function assertRepoRecord(value: unknown): GitHubRepoRecord {
  if (!isRecord(value) || typeof value.default_branch !== "string") {
    throw new Error(
      "Invalid GitHub repository payload.\nAction to fix: retry after confirming the repository is accessible.",
    );
  }

  return {
    default_branch: value.default_branch,
    permissions: isRecord(value.permissions) ? value.permissions : undefined,
  };
}

function assertPermissionRecord(value: unknown): GitHubPermissionRecord {
  if (!isRecord(value)) {
    return {};
  }

  const permissionValue = value.permission;
  const roleNameValue = value.role_name;

  return {
    permission: typeof permissionValue === "string" ? permissionValue : undefined,
    role_name: typeof roleNameValue === "string" ? roleNameValue : undefined,
  };
}

function hasClassicRepoScope(classicScopes: string[]): boolean {
  return classicScopes.some((scopeEntry) => scopeEntry.toLowerCase() === "repo");
}

function hasReadPermission(permissionValue: string | undefined): boolean {
  return ["read", "triage", "write", "maintain", "admin"].includes(permissionValue ?? "");
}

function hasWritePermission(permissionValue: string | undefined): boolean {
  return ["write", "maintain", "admin"].includes(permissionValue ?? "");
}

function hasBooleanFlag(record: Record<string, unknown> | undefined, key: string): boolean {
  return record?.[key] === true;
}

function collectMissingScopes(observedPermissions: {
  classicScopes: string[];
  collaboratorPermission?: string;
  fineGrainedPermissions: Record<string, string>;
  repositoryPermissions?: Record<string, unknown>;
}): string[] {
  const classicRepoScope = hasClassicRepoScope(observedPermissions.classicScopes);
  const collaboratorPermission = observedPermissions.collaboratorPermission;
  const repositoryPermissions = observedPermissions.repositoryPermissions;
  const fineGrainedPermissions = observedPermissions.fineGrainedPermissions;

  const canCloneRepository =
    classicRepoScope ||
    hasReadPermission(fineGrainedPermissions.contents) ||
    hasReadPermission(collaboratorPermission) ||
    hasBooleanFlag(repositoryPermissions, "pull") ||
    hasBooleanFlag(repositoryPermissions, "push");

  const canWriteIssues =
    classicRepoScope ||
    hasWritePermission(fineGrainedPermissions.issues) ||
    hasWritePermission(collaboratorPermission) ||
    hasBooleanFlag(repositoryPermissions, "push");

  const canWritePullRequests =
    classicRepoScope ||
    hasWritePermission(fineGrainedPermissions.pull_requests) ||
    hasWritePermission(collaboratorPermission) ||
    hasBooleanFlag(repositoryPermissions, "push");

  return [
    ...(canCloneRepository ? [] : ["repo (or contents: read)"]),
    ...(canWriteIssues ? [] : ["issues: write"]),
    ...(canWritePullRequests ? [] : ["pull_requests: write"]),
  ];
}

function mergeFineGrainedPermissions(
  firstPermissions: Record<string, string>,
  secondPermissions: Record<string, string>,
): Record<string, string> {
  return {
    ...firstPermissions,
    ...secondPermissions,
  };
}

function mapReadIssueError(error: unknown, issueNumber: number): never {
  if (extractStatus(error) === 401) {
    throw new InvalidGitHubTokenError();
  }

  if (error instanceof Error && error.message.includes("closed")) {
    throw new ParentIssueClosedError(issueNumber);
  }

  if (error instanceof Error && error.message.includes("pull request")) {
    throw new Error(
      `Issue #${issueNumber} points to a pull request instead of a parent issue.\nAction to fix: pass an issue number, not a pull request number.`,
    );
  }

  throw error;
}

export async function validateGitHubAccess(
  octokit: GitHubPreflightClient,
  owner: string,
  repo: string,
  issueN: number,
): Promise<{ defaultBranch: string; permissions: Record<string, unknown> }> {
  let userResponse: GitHubApiResponse<unknown>;
  try {
    userResponse = await octokit.request("GET /user");
  } catch (error) {
    if (extractStatus(error) === 401) {
      throw new InvalidGitHubTokenError();
    }

    throw error;
  }

  const userRecord = assertUserRecord(userResponse.data);
  const classicScopes = parseOAuthScopes(userResponse.headers);

  let repoResponse: GitHubApiResponse<unknown>;
  try {
    repoResponse = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
  } catch (error) {
    if (extractStatus(error) === 401) {
      throw new InvalidGitHubTokenError();
    }

    if (extractStatus(error) === 404) {
      throw new RepoNotFoundError(owner, repo);
    }

    throw error;
  }

  try {
    await readIssue(octokit, owner, repo, issueN);
  } catch (error) {
    mapReadIssueError(error, issueN);
  }

  let permissionResponse: GitHubApiResponse<unknown> | undefined;
  try {
    permissionResponse = await octokit.request(
      "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
      {
        owner,
        repo,
        username: userRecord.login,
      },
    );
  } catch (error) {
    if (extractStatus(error) === 401) {
      throw new InvalidGitHubTokenError();
    }

    if (extractStatus(error) !== 403 && extractStatus(error) !== 404) {
      throw error;
    }
  }

  const repoRecord = assertRepoRecord(repoResponse.data);
  const permissionRecord = assertPermissionRecord(permissionResponse?.data);
  const fineGrainedPermissions = mergeFineGrainedPermissions(
    parseAcceptedPermissions(repoResponse.headers),
    parseAcceptedPermissions(permissionResponse?.headers),
  );

  const observedPermissions = {
    classicScopes,
    collaboratorPermission: permissionRecord.permission,
    fineGrainedPermissions,
    repositoryPermissions: repoRecord.permissions,
    roleName: permissionRecord.role_name,
  } satisfies Record<string, unknown>;

  const missingScopes = collectMissingScopes({
    classicScopes,
    collaboratorPermission: permissionRecord.permission,
    fineGrainedPermissions,
    repositoryPermissions: repoRecord.permissions,
  });

  if (missingScopes.length > 0) {
    throw new InsufficientScopesError(missingScopes);
  }

  return {
    defaultBranch: repoRecord.default_branch,
    permissions: observedPermissions,
  };
}

export async function validateAnthropicAccess(client: AnthropicPreflightClient): Promise<void> {
  const agentsApi = client.beta?.agents;
  if (!agentsApi) {
    throw new AuthError(
      "Anthropic client is unavailable.\nAction to fix: pass an initialized Anthropic client or set skipAnthropicCheck for dry-run mode.",
    );
  }

  try {
    await agentsApi.list({ limit: 1 });
  } catch (error) {
    if (extractStatus(error) === 401) {
      throw new AuthError(
        "Anthropic authentication is invalid or expired.\nAction to fix: set ANTHROPIC_API_KEY to a valid API key and retry.",
      );
    }

    throw error;
  }
}

export async function runPreflight(deps: {
  octokit: GitHubPreflightClient;
  anthropicClient?: AnthropicPreflightClient;
  owner: string;
  repo: string;
  issueN: number;
  skipAnthropicCheck?: boolean;
}): Promise<PreflightResult> {
  const githubAccess = await validateGitHubAccess(deps.octokit, deps.owner, deps.repo, deps.issueN);

  if (deps.skipAnthropicCheck) {
    return {
      anthropic: {
        checked: false,
      },
      github: githubAccess,
    };
  }

  if (!deps.anthropicClient) {
    throw new AuthError(
      "Anthropic client is required when skipAnthropicCheck is false.\nAction to fix: pass an initialized Anthropic client or enable skipAnthropicCheck for dry-run mode.",
    );
  }

  await validateAnthropicAccess(deps.anthropicClient);

  return {
    anthropic: {
      checked: true,
    },
    github: githubAccess,
  };
}
