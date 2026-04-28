import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  BetaManagedAgentsCredential,
  CredentialCreateParams,
} from "@anthropic-ai/sdk/resources/beta/vaults/credentials";
import type { BetaManagedAgentsVault } from "@anthropic-ai/sdk/resources/beta/vaults/vaults";

import { GITHUB_MCP_URL } from "@/shared/constants";

import { createLogger } from "../logging";
import { createVaultModule, VaultApiUnavailable } from "../vault";

const createdTempDirectories: string[] = [];
const SAMPLE_GITHUB_TOKEN = "ghp_1234567890abcdefghij1234567890abcdef";
const ISO_TIMESTAMP = "2026-04-23T00:00:00.000Z";

type CredentialDeleteInvocation = {
  credentialId: string;
  vaultId: string;
};

type MockVaultClientOptions = {
  createdCredentialId?: string;
  createdVaultId?: string;
  credentialDeleteImplementation?: (invocationCount: number) => Promise<void>;
  listedCredentials?: BetaManagedAgentsCredential[];
  retrievedVaultId?: string;
  vaultDeleteImplementation?: (invocationCount: number) => Promise<void>;
};

async function createTempLogFile(): Promise<string> {
  const directoryPath = await mkdtemp(join(tmpdir(), "github-issue-vault-"));
  createdTempDirectories.push(directoryPath);
  return join(directoryPath, "vault.log");
}

async function flushLogger(logFile: string): Promise<Array<Record<string, unknown>>> {
  const logContent = await readFile(logFile, "utf8");

  return logContent
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createVaultRecord(vaultId: string): BetaManagedAgentsVault {
  return {
    id: vaultId,
    archived_at: null,
    created_at: ISO_TIMESTAMP,
    display_name: "github-issue-agent auto",
    metadata: {},
    type: "vault",
    updated_at: ISO_TIMESTAMP,
  };
}

function createCredentialRecord(
  credentialId: string,
  mcpServerUrl: string,
): BetaManagedAgentsCredential {
  return {
    id: credentialId,
    archived_at: null,
    auth: {
      mcp_server_url: mcpServerUrl,
      type: "static_bearer",
    },
    created_at: ISO_TIMESTAMP,
    display_name: "github-issue-agent auto",
    metadata: {},
    type: "vault_credential",
    updated_at: ISO_TIMESTAMP,
    vault_id: "vlt_test",
  };
}

function createCredentialStream(
  credentials: BetaManagedAgentsCredential[],
): AsyncIterable<BetaManagedAgentsCredential> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const credentialEntry of credentials) {
        yield credentialEntry;
      }
    },
  };
}

function createNotFoundError(): Error & { status: number } {
  return Object.assign(new Error("not found"), { status: 404 });
}

function createMockVaultClient(options: MockVaultClientOptions = {}) {
  const createVaultInvocations: Array<{ display_name: string }> = [];
  const retrieveVaultInvocations: string[] = [];
  const listCredentialInvocations: string[] = [];
  const createCredentialInvocations: Array<{ params: CredentialCreateParams; vaultId: string }> =
    [];
  const deleteCredentialInvocations: CredentialDeleteInvocation[] = [];
  const deleteVaultInvocations: string[] = [];

  let credentialDeleteCount = 0;
  let vaultDeleteCount = 0;

  const client = {
    beta: {
      vaults: {
        create: async (params: { display_name: string }) => {
          createVaultInvocations.push(params);
          return createVaultRecord(options.createdVaultId ?? "vlt_created");
        },
        credentials: {
          create: async (vaultId: string, params: CredentialCreateParams) => {
            createCredentialInvocations.push({ params, vaultId });
            return createCredentialRecord(
              options.createdCredentialId ?? "vcrd_created",
              params.auth.mcp_server_url,
            );
          },
          delete: async (credentialId: string, params: { vault_id: string }) => {
            deleteCredentialInvocations.push({ credentialId, vaultId: params.vault_id });
            credentialDeleteCount += 1;
            await options.credentialDeleteImplementation?.(credentialDeleteCount);
            return {
              id: credentialId,
              type: "vault_credential_deleted" as const,
            };
          },
          list: (vaultId: string) => {
            listCredentialInvocations.push(vaultId);
            return createCredentialStream(options.listedCredentials ?? []);
          },
        },
        delete: async (vaultId: string) => {
          deleteVaultInvocations.push(vaultId);
          vaultDeleteCount += 1;
          await options.vaultDeleteImplementation?.(vaultDeleteCount);
          return {
            id: vaultId,
            type: "vault_deleted" as const,
          };
        },
        retrieve: async (vaultId: string) => {
          retrieveVaultInvocations.push(vaultId);
          return createVaultRecord(options.retrievedVaultId ?? vaultId);
        },
      },
    },
  };

  return {
    client,
    createCredentialInvocations,
    createVaultInvocations,
    deleteCredentialInvocations,
    deleteVaultInvocations,
    listCredentialInvocations,
    retrieveVaultInvocations,
  };
}

afterEach(async () => {
  await Promise.all(
    createdTempDirectories
      .splice(0)
      .map((directoryPath) => rm(directoryPath, { force: true, recursive: true })),
  );
});

describe("vault helpers", () => {
  test("ensureVault creates a vault when configVaultId is absent", async () => {
    const mockVaultClient = createMockVaultClient({ createdVaultId: "vlt_auto" });
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await expect(
      vaultModule.ensureVault(mockVaultClient.client, { githubToken: SAMPLE_GITHUB_TOKEN }),
    ).resolves.toEqual({ managedByUs: true, vaultId: "vlt_auto" });

    expect(mockVaultClient.createVaultInvocations).toEqual([
      {
        display_name: "github-issue-agent auto",
      },
    ]);
    expect(mockVaultClient.retrieveVaultInvocations).toEqual([]);
  });

  test("ensureVault reuses an explicit configVaultId", async () => {
    const mockVaultClient = createMockVaultClient({ retrievedVaultId: "vault_preconfigured" });
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await expect(
      vaultModule.ensureVault(mockVaultClient.client, {
        configVaultId: "vault_preconfigured",
        githubToken: SAMPLE_GITHUB_TOKEN,
      }),
    ).resolves.toEqual({ managedByUs: false, vaultId: "vault_preconfigured" });

    expect(mockVaultClient.retrieveVaultInvocations).toEqual(["vault_preconfigured"]);
    expect(mockVaultClient.createVaultInvocations).toEqual([]);
  });

  test("ensureGitHubCredential creates a static_bearer credential bound to GITHUB_MCP_URL", async () => {
    const mockVaultClient = createMockVaultClient({ createdCredentialId: "vcrd_auto" });
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await expect(
      vaultModule.ensureGitHubCredential(mockVaultClient.client, {
        githubToken: SAMPLE_GITHUB_TOKEN,
        vaultId: "vlt_auto",
      }),
    ).resolves.toEqual({ credentialId: "vcrd_auto", managedByUs: true });

    expect(mockVaultClient.listCredentialInvocations).toEqual(["vlt_auto"]);
    expect(mockVaultClient.createCredentialInvocations).toEqual([
      {
        params: {
          auth: {
            mcp_server_url: GITHUB_MCP_URL,
            token: SAMPLE_GITHUB_TOKEN,
            type: "static_bearer",
          },
          display_name: "github-issue-agent auto",
        },
        vaultId: "vlt_auto",
      },
    ]);
  });

  test("ensureGitHubCredential reuses an existing credential when the MCP URL matches", async () => {
    const mockVaultClient = createMockVaultClient({
      listedCredentials: [
        createCredentialRecord("vcrd_existing", GITHUB_MCP_URL),
        createCredentialRecord("vcrd_other", "https://example.com/mcp/"),
      ],
    });
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await expect(
      vaultModule.ensureGitHubCredential(mockVaultClient.client, {
        githubToken: SAMPLE_GITHUB_TOKEN,
        vaultId: "vlt_existing",
      }),
    ).resolves.toEqual({ credentialId: "vcrd_existing", managedByUs: false });

    expect(mockVaultClient.createCredentialInvocations).toEqual([]);
  });

  test("ensureGitHubCredential never logs the raw token value", async () => {
    const logFile = await createTempLogFile();
    const mockVaultClient = createMockVaultClient({ createdCredentialId: "vcrd_logged" });
    const vaultModule = createVaultModule({ logger: createLogger({ level: "info", logFile }) });

    await vaultModule.ensureGitHubCredential(mockVaultClient.client, {
      githubToken: SAMPLE_GITHUB_TOKEN,
      vaultId: "vlt_logged",
    });
    await vaultModule.flushLogs();

    const logEntries = await flushLogger(logFile);
    const serializedLogs = JSON.stringify(logEntries);

    expect(serializedLogs).not.toContain(SAMPLE_GITHUB_TOKEN);
    expect(serializedLogs.includes("[REDACTED]") || !serializedLogs.includes("github_token")).toBe(
      true,
    );
  });

  test("releaseVault deletes a self-created credential before deleting a self-created vault", async () => {
    const deletionSequence: string[] = [];
    const mockVaultClient = createMockVaultClient({
      credentialDeleteImplementation: async () => {
        deletionSequence.push("credential");
      },
      vaultDeleteImplementation: async () => {
        deletionSequence.push("vault");
      },
    });
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await vaultModule.releaseVault(mockVaultClient.client, {
      credentialId: "vcrd_auto",
      managedCredential: true,
      managedVault: true,
      vaultId: "vlt_auto",
    });

    expect(mockVaultClient.deleteCredentialInvocations).toEqual([
      { credentialId: "vcrd_auto", vaultId: "vlt_auto" },
    ]);
    expect(mockVaultClient.deleteVaultInvocations).toEqual(["vlt_auto"]);
    expect(deletionSequence).toEqual(["credential", "vault"]);
  });

  test("releaseVault leaves pre-existing vaults and credentials untouched", async () => {
    const mockVaultClient = createMockVaultClient();
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await vaultModule.releaseVault(mockVaultClient.client, {
      credentialId: "vcrd_existing",
      managedCredential: false,
      managedVault: false,
      vaultId: "vlt_existing",
    });

    expect(mockVaultClient.deleteCredentialInvocations).toEqual([]);
    expect(mockVaultClient.deleteVaultInvocations).toEqual([]);
  });

  test("releaseVault is idempotent and swallows 404 responses", async () => {
    const mockVaultClient = createMockVaultClient({
      credentialDeleteImplementation: async (invocationCount) => {
        if (invocationCount === 2) {
          throw createNotFoundError();
        }
      },
      vaultDeleteImplementation: async (invocationCount) => {
        if (invocationCount === 2) {
          throw createNotFoundError();
        }
      },
    });
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });
    const releaseContext = {
      credentialId: "vcrd_auto",
      managedCredential: true,
      managedVault: true,
      vaultId: "vlt_auto",
    };

    await vaultModule.releaseVault(mockVaultClient.client, releaseContext);
    await vaultModule.releaseVault(mockVaultClient.client, releaseContext);

    expect(mockVaultClient.deleteCredentialInvocations).toHaveLength(2);
    expect(mockVaultClient.deleteVaultInvocations).toHaveLength(2);
  });

  test("throws VaultApiUnavailable when the SDK vault namespace is missing", async () => {
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await expect(
      vaultModule.ensureVault({}, { githubToken: SAMPLE_GITHUB_TOKEN }),
    ).rejects.toBeInstanceOf(VaultApiUnavailable);
    await expect(vaultModule.ensureVault({}, { githubToken: SAMPLE_GITHUB_TOKEN })).rejects.toThrow(
      /vaultId.*credential/i,
    );
  });
});
