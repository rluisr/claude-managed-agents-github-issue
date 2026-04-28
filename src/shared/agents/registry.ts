import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type Anthropic from "@anthropic-ai/sdk";
import type {
  AgentCreateParams,
  AgentUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { Config } from "@/shared/config";
import { RUN_LOCK } from "@/shared/constants";
import { createStateModule } from "@/shared/state";
import type { AgentState } from "@/shared/types";
import { buildChildDefinition } from "./child";
import { hashDefinition } from "./hash";
import { buildParentDefinition } from "./parent";

const LOCK_RETRY_OPTIONS = {
  retries: 40,
  factor: 1,
  minTimeout: 25,
  maxTimeout: 25,
  randomize: false,
} as const;

type AgentRole = "parent" | "child";

type PersistedAgentState = AgentState & {
  childDefinitionHash: string;
  parentDefinitionHash: string;
};

export type RegistryAnthropicClient = {
  beta: {
    agents: {
      create(params: AgentCreateParams): PromiseLike<{ id: string; version: number }>;
      update(
        agentId: string,
        params: AgentUpdateParams,
      ): PromiseLike<{ id: string; version: number }>;
    };
  };
};

export type EnsureAgentsOptions = {
  cfg: Config;
  parentPrompt: string;
  childPrompt: string;
  environmentId: string;
  parentTools: NonNullable<AgentCreateParams["tools"]>;
  forceRecreate?: boolean;
};

export type EnsureAgentsResult = {
  parentAgentId: string;
  parentAgentVersion: number;
  childAgentId: string;
  childAgentVersion: number;
  definitionHash: string;
};

type RegistryDeps = {
  buildParent: typeof buildParentDefinition;
  buildChild: typeof buildChildDefinition;
  hash: typeof hashDefinition;
  stateModule: ReturnType<typeof createStateModule>;
};

function hashCombinedDefinitions(
  parentDefinitionHash: string,
  childDefinitionHash: string,
): string {
  return createHash("sha256")
    .update(`${parentDefinitionHash}:${childDefinitionHash}`)
    .digest("hex");
}

function toEnsureAgentsResult(state: AgentState): EnsureAgentsResult {
  return {
    parentAgentId: state.parentAgentId,
    parentAgentVersion: state.parentAgentVersion,
    childAgentId: state.childAgentId,
    childAgentVersion: state.childAgentVersion,
    definitionHash: state.definitionHash,
  };
}

function toUpdateParams(definition: AgentCreateParams, version: number): AgentUpdateParams {
  return {
    version,
    ...(typeof definition.description === "undefined"
      ? {}
      : { description: definition.description }),
    ...(typeof definition.mcp_servers === "undefined"
      ? {}
      : { mcp_servers: definition.mcp_servers }),
    ...(typeof definition.metadata === "undefined" ? {} : { metadata: definition.metadata }),
    ...(typeof definition.model === "undefined" ? {} : { model: definition.model }),
    ...(typeof definition.name === "undefined" ? {} : { name: definition.name }),
    ...(typeof definition.skills === "undefined" ? {} : { skills: definition.skills }),
    ...(typeof definition.system === "undefined" ? {} : { system: definition.system }),
    ...(typeof definition.tools === "undefined" ? {} : { tools: definition.tools }),
  };
}

function readStoredDefinitionHash(state: AgentState, role: AgentRole): string | undefined {
  const key = role === "parent" ? "parentDefinitionHash" : "childDefinitionHash";
  const storedValue = (state as Record<string, unknown>)[key];

  return typeof storedValue === "string" ? storedValue : undefined;
}

function buildPersistedState(options: {
  createdAt: string;
  environmentId: string;
  parentAgentId: string;
  parentAgentVersion: number;
  childAgentId: string;
  childAgentVersion: number;
  definitionHash: string;
  parentDefinitionHash: string;
  childDefinitionHash: string;
}): PersistedAgentState {
  return {
    parentAgentId: options.parentAgentId,
    parentAgentVersion: options.parentAgentVersion,
    childAgentId: options.childAgentId,
    childAgentVersion: options.childAgentVersion,
    environmentId: options.environmentId,
    definitionHash: options.definitionHash,
    createdAt: options.createdAt,
    parentDefinitionHash: options.parentDefinitionHash,
    childDefinitionHash: options.childDefinitionHash,
  };
}

function createLockError(lockFilePath: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);

  return new Error(`Failed to acquire run lock at ${lockFilePath}: ${message}`);
}

function shouldRefreshEnvironmentId(state: AgentState, environmentId: string): boolean {
  return state.environmentId !== environmentId;
}

export function createRegistry(deps: Partial<RegistryDeps> = {}) {
  const registryDeps: RegistryDeps = {
    buildParent: buildParentDefinition,
    buildChild: buildChildDefinition,
    hash: hashDefinition,
    stateModule: createStateModule(),
    ...deps,
  };

  async function ensureAgents(
    client: RegistryAnthropicClient,
    options: EnsureAgentsOptions,
  ): Promise<EnsureAgentsResult> {
    const parentDefinition = registryDeps.buildParent(
      options.cfg,
      { parent: options.parentPrompt },
      options.parentTools,
    );
    const childDefinition = registryDeps.buildChild(options.cfg, {
      child: options.childPrompt,
    });
    const parentDefinitionHash = registryDeps.hash(parentDefinition);
    const childDefinitionHash = registryDeps.hash(childDefinition);
    const combinedDefinitionHash = hashCombinedDefinitions(
      parentDefinitionHash,
      childDefinitionHash,
    );
    const lockFilePath = resolve(process.cwd(), `${RUN_LOCK}.lock`);
    let lockAcquired = false;

    try {
      try {
        await registryDeps.stateModule.acquireRunLock({ retries: LOCK_RETRY_OPTIONS });
        lockAcquired = true;
      } catch (error) {
        throw createLockError(lockFilePath, error);
      }

      const existingState = await registryDeps.stateModule.readAgentState();

      if (options.forceRecreate === true || existingState === null) {
        const createdParent = await client.beta.agents.create(parentDefinition);
        const createdChild = await client.beta.agents.create(childDefinition);
        const nextState = buildPersistedState({
          createdAt: new Date().toISOString(),
          environmentId: options.environmentId,
          parentAgentId: createdParent.id,
          parentAgentVersion: createdParent.version,
          childAgentId: createdChild.id,
          childAgentVersion: createdChild.version,
          definitionHash: combinedDefinitionHash,
          parentDefinitionHash,
          childDefinitionHash,
        });

        await registryDeps.stateModule.writeAgentState(nextState);

        return toEnsureAgentsResult(nextState);
      }

      if (existingState.definitionHash === combinedDefinitionHash) {
        if (!shouldRefreshEnvironmentId(existingState, options.environmentId)) {
          return toEnsureAgentsResult(existingState);
        }

        const refreshedState = buildPersistedState({
          createdAt: existingState.createdAt,
          environmentId: options.environmentId,
          parentAgentId: existingState.parentAgentId,
          parentAgentVersion: existingState.parentAgentVersion,
          childAgentId: existingState.childAgentId,
          childAgentVersion: existingState.childAgentVersion,
          definitionHash: combinedDefinitionHash,
          parentDefinitionHash,
          childDefinitionHash,
        });

        await registryDeps.stateModule.writeAgentState(refreshedState);

        return toEnsureAgentsResult(refreshedState);
      }

      const storedParentDefinitionHash = readStoredDefinitionHash(existingState, "parent");
      const storedChildDefinitionHash = readStoredDefinitionHash(existingState, "child");
      const parentNeedsUpdate =
        typeof storedParentDefinitionHash === "string"
          ? storedParentDefinitionHash !== parentDefinitionHash
          : true;
      const childNeedsUpdate =
        typeof storedChildDefinitionHash === "string"
          ? storedChildDefinitionHash !== childDefinitionHash
          : true;

      const updatedParent = parentNeedsUpdate
        ? await client.beta.agents.update(
            existingState.parentAgentId,
            toUpdateParams(parentDefinition, existingState.parentAgentVersion),
          )
        : {
            id: existingState.parentAgentId,
            version: existingState.parentAgentVersion,
          };
      const updatedChild = childNeedsUpdate
        ? await client.beta.agents.update(
            existingState.childAgentId,
            toUpdateParams(childDefinition, existingState.childAgentVersion),
          )
        : {
            id: existingState.childAgentId,
            version: existingState.childAgentVersion,
          };

      const nextState = buildPersistedState({
        createdAt: existingState.createdAt,
        environmentId: options.environmentId,
        parentAgentId: updatedParent.id,
        parentAgentVersion: updatedParent.version,
        childAgentId: updatedChild.id,
        childAgentVersion: updatedChild.version,
        definitionHash: combinedDefinitionHash,
        parentDefinitionHash,
        childDefinitionHash,
      });

      await registryDeps.stateModule.writeAgentState(nextState);

      return toEnsureAgentsResult(nextState);
    } finally {
      if (lockAcquired) {
        await registryDeps.stateModule.releaseRunLock();
      }
    }
  }

  return { ensureAgents };
}

const defaultRegistry = createRegistry();

export function ensureAgents(
  client: Anthropic,
  options: EnsureAgentsOptions,
): Promise<EnsureAgentsResult>;
export function ensureAgents(
  client: RegistryAnthropicClient,
  options: EnsureAgentsOptions,
): Promise<EnsureAgentsResult>;
export function ensureAgents(
  client: Anthropic | RegistryAnthropicClient,
  options: EnsureAgentsOptions,
): Promise<EnsureAgentsResult> {
  return defaultRegistry.ensureAgents(client, options);
}
