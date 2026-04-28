import type {
  BetaManagedAgentsCredential,
  CredentialCreateParams,
} from "@anthropic-ai/sdk/resources/beta/vaults/credentials";
import type { BetaManagedAgentsVault } from "@anthropic-ai/sdk/resources/beta/vaults/vaults";
import type { Logger } from "pino";

import { GITHUB_MCP_URL } from "@/shared/constants";
import { createLogger } from "@/shared/logging";

const AUTO_DISPLAY_NAME = "github-issue-agent auto";

export type EnsureVaultContext = {
  configVaultId?: string;
  githubToken: string;
};

export type EnsureGitHubCredentialContext = {
  githubToken: string;
  vaultId: string;
};

export type ReleaseVaultContext = {
  credentialId?: string;
  managedCredential: boolean;
  managedVault: boolean;
  vaultId: string;
};

type VaultClient = {
  beta?: {
    vaults?: VaultsApi;
  };
};

type VaultsApi = {
  create: (params: { display_name: string }) => Promise<Pick<BetaManagedAgentsVault, "id">>;
  credentials?: CredentialsApi;
  delete: (vaultId: string) => Promise<unknown>;
  retrieve: (vaultId: string) => Promise<Pick<BetaManagedAgentsVault, "id">>;
};

type CredentialsApi = {
  create: (
    vaultId: string,
    params: CredentialCreateParams,
  ) => Promise<Pick<BetaManagedAgentsCredential, "id">>;
  delete: (credentialId: string, params: { vault_id: string }) => Promise<unknown>;
  list: (vaultId: string) => AsyncIterable<BetaManagedAgentsCredential>;
};

type VaultModuleDependencies = {
  logger: Logger;
};

export class VaultApiUnavailable extends Error {
  constructor() {
    super(
      "Vault API unavailable in the installed SDK; configure vaultId with a pre-provisioned GitHub MCP credential.",
    );
    this.name = "VaultApiUnavailable";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.status === 404;
}

function buildCredentialCreateParams(githubToken: string): CredentialCreateParams {
  return {
    auth: {
      mcp_server_url: GITHUB_MCP_URL,
      token: githubToken,
      type: "static_bearer",
    },
    display_name: AUTO_DISPLAY_NAME,
  };
}

function requireVaultsApi(client: VaultClient): VaultsApi {
  const vaultsApi = client.beta?.vaults;

  if (!vaultsApi) {
    throw new VaultApiUnavailable();
  }

  return vaultsApi;
}

function requireCredentialsApi(client: VaultClient): CredentialsApi {
  const credentialsApi = requireVaultsApi(client).credentials;

  if (!credentialsApi) {
    throw new VaultApiUnavailable();
  }

  return credentialsApi;
}

async function swallowNotFound(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }

    throw error;
  }
}

export function createVaultModule(overrides: Partial<VaultModuleDependencies> = {}) {
  const dependencies: VaultModuleDependencies = {
    logger: createLogger({ level: "silent" }),
    ...overrides,
  };
  const logger = dependencies.logger.child({ component: "vault" });

  async function ensureVault(
    client: VaultClient,
    context: EnsureVaultContext,
  ): Promise<{ managedByUs: boolean; vaultId: string }> {
    const vaultsApi = requireVaultsApi(client);

    if (typeof context.configVaultId === "string" && context.configVaultId.length > 0) {
      const existingVault = await vaultsApi.retrieve(context.configVaultId);
      logger.info({ managedByUs: false, vaultId: existingVault.id }, "Reused configured vault");
      return {
        managedByUs: false,
        vaultId: existingVault.id,
      };
    }

    const createdVault = await vaultsApi.create({ display_name: AUTO_DISPLAY_NAME });
    logger.info({ managedByUs: true, vaultId: createdVault.id }, "Created managed vault");

    return {
      managedByUs: true,
      vaultId: createdVault.id,
    };
  }

  async function ensureGitHubCredential(
    client: VaultClient,
    context: EnsureGitHubCredentialContext,
  ): Promise<{ credentialId: string; managedByUs: boolean }> {
    const credentialsApi = requireCredentialsApi(client);

    logger.info(
      { mcpServerUrl: GITHUB_MCP_URL, vaultId: context.vaultId },
      "Checking vault for GitHub MCP credential",
    );

    for await (const credentialEntry of credentialsApi.list(context.vaultId)) {
      if (credentialEntry.auth.mcp_server_url === GITHUB_MCP_URL) {
        logger.info(
          {
            credentialId: credentialEntry.id,
            managedByUs: false,
            vaultId: context.vaultId,
          },
          "Reused existing GitHub MCP credential",
        );

        return {
          credentialId: credentialEntry.id,
          managedByUs: false,
        };
      }
    }

    const createdCredential = await credentialsApi.create(
      context.vaultId,
      buildCredentialCreateParams(context.githubToken),
    );
    logger.info(
      {
        credentialId: createdCredential.id,
        managedByUs: true,
        mcpServerUrl: GITHUB_MCP_URL,
        vaultId: context.vaultId,
      },
      "Created GitHub MCP credential",
    );

    return {
      credentialId: createdCredential.id,
      managedByUs: true,
    };
  }

  async function releaseVault(client: VaultClient, context: ReleaseVaultContext): Promise<void> {
    const vaultsApi = requireVaultsApi(client);
    const credentialsApi = requireCredentialsApi(client);

    if (context.managedCredential && typeof context.credentialId === "string") {
      const credentialIdToDelete = context.credentialId;
      await swallowNotFound(async () => {
        await credentialsApi.delete(credentialIdToDelete, { vault_id: context.vaultId });
      });
      logger.info(
        {
          credentialId: credentialIdToDelete,
          managedByUs: true,
          vaultId: context.vaultId,
        },
        "Released managed vault credential",
      );
    }

    if (context.managedVault) {
      await swallowNotFound(async () => {
        await vaultsApi.delete(context.vaultId);
      });
      logger.info({ managedByUs: true, vaultId: context.vaultId }, "Released managed vault");
    }
  }

  async function flushLogs(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      logger.flush((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  return {
    ensureGitHubCredential,
    ensureVault,
    flushLogs,
    releaseVault,
  };
}

const defaultVaultModule = createVaultModule();

export const { ensureGitHubCredential, ensureVault, releaseVault } = defaultVaultModule;
