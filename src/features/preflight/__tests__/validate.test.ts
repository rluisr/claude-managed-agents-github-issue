import { describe, expect, test } from "bun:test";

import {
  AuthError,
  InsufficientScopesError,
  InvalidGitHubTokenError,
  ParentIssueClosedError,
  RepoNotFoundError,
  runPreflight,
  validateAnthropicAccess,
  validateGitHubAccess,
} from "../validate";

type HeadersRecord = Record<string, string | number | undefined>;

type MockApiResponse = {
  data: unknown;
  headers?: HeadersRecord;
  status?: number;
};

type RequestCall = {
  body?: Record<string, unknown>;
  method: string;
  url: string;
};

type RequestOutcome =
  | {
      kind: "resolve";
      response: MockApiResponse;
    }
  | {
      error: MockRequestError;
      kind: "reject";
    };

type MockAnthropicClientOptions = {
  error?: Error;
};

class MockRequestError extends Error {
  readonly headers?: HeadersRecord;
  readonly response?: {
    data?: {
      message?: string;
    };
    headers?: HeadersRecord;
  };
  readonly status: number;

  constructor(
    message: string,
    status: number,
    options: {
      apiMessage?: string;
      headers?: HeadersRecord;
    } = {},
  ) {
    super(message);
    this.name = "MockRequestError";
    this.headers = options.headers;
    this.response = {
      data: options.apiMessage ? { message: options.apiMessage } : undefined,
      headers: options.headers,
    };
    this.status = status;
  }
}

function buildIssue(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    body: "Parent issue body",
    id: 101,
    number: 42,
    state: "open",
    title: "Parent issue",
    ...overrides,
  };
}

function materializeCall(route: string, parameters: Record<string, unknown> = {}): RequestCall {
  const routeParts = route.split(" ");
  const method = routeParts[0];
  const rawUrl = routeParts[1];
  if (typeof method !== "string" || typeof rawUrl !== "string") {
    throw new Error(`Invalid route: ${route}`);
  }

  const placeholderKeys: string[] = [];
  for (const placeholderMatch of rawUrl.matchAll(/\{([^}]+)\}/g)) {
    const placeholderKey = placeholderMatch[1];
    if (typeof placeholderKey !== "string") {
      throw new Error(`Invalid placeholder in route: ${route}`);
    }

    placeholderKeys.push(placeholderKey);
  }

  let url = rawUrl;
  for (const placeholderKey of placeholderKeys) {
    const placeholderValue = parameters[placeholderKey];
    if (typeof placeholderValue === "undefined") {
      throw new Error(`Missing route parameter: ${placeholderKey}`);
    }

    url = url.replace(`{${placeholderKey}}`, String(placeholderValue));
  }

  const bodyEntries = Object.entries(parameters).filter(
    ([parameterKey]) =>
      !placeholderKeys.includes(parameterKey) &&
      parameterKey !== "page" &&
      parameterKey !== "per_page",
  );

  return {
    body: bodyEntries.length > 0 ? Object.fromEntries(bodyEntries) : undefined,
    method,
    url,
  };
}

function createMockGitHubClient(
  options: { paginateOutcomes?: unknown[][]; requestOutcomes?: RequestOutcome[] } = {},
) {
  const pendingPaginateOutcomes = [...(options.paginateOutcomes ?? [])];
  const pendingRequestOutcomes = [...(options.requestOutcomes ?? [])];
  const paginateCalls: RequestCall[] = [];
  const requestCalls: RequestCall[] = [];

  return {
    paginateCalls,
    requestCalls,
    async paginate(route: string, parameters?: Record<string, unknown>) {
      paginateCalls.push(materializeCall(route, parameters ?? {}));

      const nextOutcome = pendingPaginateOutcomes.shift();
      if (!nextOutcome) {
        throw new Error(`Unexpected paginate call: ${route}`);
      }

      return nextOutcome;
    },
    async request(route: string, parameters?: Record<string, unknown>) {
      requestCalls.push(materializeCall(route, parameters ?? {}));

      const nextOutcome = pendingRequestOutcomes.shift();
      if (!nextOutcome) {
        throw new Error(`Unexpected request call: ${route}`);
      }

      if (nextOutcome.kind === "reject") {
        throw nextOutcome.error;
      }

      return nextOutcome.response;
    },
  };
}

function createMockAnthropicClient(options: MockAnthropicClientOptions = {}) {
  const listCalls: Array<{ limit: number }> = [];

  const client = {
    beta: {
      agents: {
        async list(params: { limit: number }) {
          listCalls.push(params);
          if (options.error) {
            throw options.error;
          }

          return { data: [] };
        },
      },
    },
  };

  return {
    client,
    listCalls,
  };
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }

    throw new Error("Expected promise to reject with an Error instance");
  }

  throw new Error("Expected promise to reject");
}

describe("preflight", () => {
  test("validateGitHubAccess returns OK for valid token with required scopes", async () => {
    const octokit = createMockGitHubClient({
      paginateOutcomes: [[]],
      requestOutcomes: [
        {
          kind: "resolve",
          response: {
            data: { login: "octocat" },
            headers: { "x-oauth-scopes": "repo" },
          },
        },
        {
          kind: "resolve",
          response: {
            data: {
              default_branch: "main",
              permissions: {
                pull: true,
                push: true,
              },
            },
            headers: {
              "x-accepted-github-permissions": "contents=read, issues=write, pull_requests=write",
            },
          },
        },
        {
          kind: "resolve",
          response: { data: buildIssue() },
        },
        {
          kind: "resolve",
          response: {
            data: {
              permission: "write",
              role_name: "write",
            },
          },
        },
      ],
    });

    const access = await validateGitHubAccess(octokit, "acme", "widgets", 42);

    expect(access.defaultBranch).toBe("main");
    expect(access.permissions).toMatchObject({
      classicScopes: ["repo"],
      collaboratorPermission: "write",
      fineGrainedPermissions: {
        contents: "read",
        issues: "write",
        pull_requests: "write",
      },
      repositoryPermissions: {
        pull: true,
        push: true,
      },
    });
    expect(octokit.requestCalls).toEqual([
      { body: undefined, method: "GET", url: "/user" },
      { body: undefined, method: "GET", url: "/repos/acme/widgets" },
      { body: undefined, method: "GET", url: "/repos/acme/widgets/issues/42" },
      {
        body: undefined,
        method: "GET",
        url: "/repos/acme/widgets/collaborators/octocat/permission",
      },
    ]);
  });

  test("InvalidGitHubToken on 401 from GET /user", async () => {
    const rawToken = "ghp_supersecret1234567890abcdefghij123456";
    const octokit = createMockGitHubClient({
      requestOutcomes: [
        {
          error: new MockRequestError(`token=${rawToken}`, 401, {
            apiMessage: `bad credentials for ${rawToken}`,
          }),
          kind: "reject",
        },
      ],
    });

    const error = await captureError(validateGitHubAccess(octokit, "acme", "widgets", 42));

    expect(error instanceof InvalidGitHubTokenError).toBe(true);
    expect(error.message.toLowerCase()).toContain("token");
    expect(error.message.toLowerCase()).toContain("invalid");
    expect(error.message).not.toContain(rawToken);
  });

  test("validateGitHubAccess throws RepoNotFoundError on repo 404", async () => {
    const octokit = createMockGitHubClient({
      requestOutcomes: [
        {
          kind: "resolve",
          response: { data: { login: "octocat" } },
        },
        {
          error: new MockRequestError("missing repo", 404),
          kind: "reject",
        },
      ],
    });

    const error = await captureError(validateGitHubAccess(octokit, "acme", "widgets", 42));

    expect(error instanceof RepoNotFoundError).toBe(true);
  });

  test("ParentIssueClosed / ClosedParent throws ParentIssueClosedError", async () => {
    const octokit = createMockGitHubClient({
      requestOutcomes: [
        {
          kind: "resolve",
          response: { data: { login: "octocat" } },
        },
        {
          kind: "resolve",
          response: {
            data: {
              default_branch: "main",
              permissions: {
                pull: true,
                push: true,
              },
            },
          },
        },
        {
          kind: "resolve",
          response: { data: buildIssue({ state: "closed" }) },
        },
      ],
    });

    const error = await captureError(validateGitHubAccess(octokit, "acme", "widgets", 42));

    expect(error instanceof ParentIssueClosedError).toBe(true);
    expect(octokit.requestCalls).toEqual([
      { body: undefined, method: "GET", url: "/user" },
      { body: undefined, method: "GET", url: "/repos/acme/widgets" },
      { body: undefined, method: "GET", url: "/repos/acme/widgets/issues/42" },
    ]);
  });

  test("InsufficientScopes lists repo issues:write pull_requests:write", async () => {
    const octokit = createMockGitHubClient({
      paginateOutcomes: [[]],
      requestOutcomes: [
        {
          kind: "resolve",
          response: {
            data: { login: "octocat" },
            headers: { "x-oauth-scopes": "read:user" },
          },
        },
        {
          kind: "resolve",
          response: {
            data: {
              default_branch: "main",
              permissions: {
                pull: false,
                push: false,
              },
            },
          },
        },
        {
          kind: "resolve",
          response: { data: buildIssue() },
        },
        {
          kind: "resolve",
          response: {
            data: {
              permission: "none",
              role_name: "none",
            },
          },
        },
      ],
    });

    const error = await captureError(validateGitHubAccess(octokit, "acme", "widgets", 42));

    expect(error instanceof InsufficientScopesError).toBe(true);
    expect(error.message).toMatch(/repo|contents:\s*read/i);
    expect(error.message).toMatch(/issues:\s*write/i);
    expect(error.message).toMatch(/pull_requests:\s*write/i);
  });

  test("validateAnthropicAccess calls agents.list({ limit: 1 })", async () => {
    const anthropicClient = createMockAnthropicClient();

    await expect(validateAnthropicAccess(anthropicClient.client)).resolves.toBeUndefined();
    expect(anthropicClient.listCalls).toEqual([{ limit: 1 }]);
  });

  test("validateAnthropicAccess translates 401 to AuthError", async () => {
    const anthropicClient = createMockAnthropicClient({
      error: Object.assign(new Error("Unauthorized"), { status: 401 }),
    });

    const error = await captureError(validateAnthropicAccess(anthropicClient.client));

    expect(error instanceof AuthError).toBe(true);
  });

  test("runPreflight skips AnthropicAccess when skipAnthropicCheck=true", async () => {
    const octokit = createMockGitHubClient({
      paginateOutcomes: [[]],
      requestOutcomes: [
        {
          kind: "resolve",
          response: {
            data: { login: "octocat" },
            headers: { "x-oauth-scopes": "repo" },
          },
        },
        {
          kind: "resolve",
          response: {
            data: {
              default_branch: "main",
              permissions: {
                pull: true,
                push: true,
              },
            },
            headers: {
              "x-accepted-github-permissions": "contents=read, issues=write, pull_requests=write",
            },
          },
        },
        {
          kind: "resolve",
          response: { data: buildIssue() },
        },
        {
          kind: "resolve",
          response: {
            data: {
              permission: "write",
              role_name: "write",
            },
          },
        },
      ],
    });

    const preflightResult = await runPreflight({
      issueN: 42,
      octokit,
      owner: "acme",
      repo: "widgets",
      skipAnthropicCheck: true,
    });

    expect(preflightResult).toMatchObject({
      anthropic: { checked: false },
      github: { defaultBranch: "main" },
    });
  });
});
