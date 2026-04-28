import { createHash } from "node:crypto";

import type {
  BetaUnrestrictedNetwork,
  EnvironmentCreateParams,
} from "@anthropic-ai/sdk/resources/beta/environments";

import type { AgentState } from "@/shared/types";

const DEFAULT_ENVIRONMENT_NAME = "github-issue-agent-env";

type EnvironmentCacheState =
  | Pick<AgentState, "definitionHash" | "environmentId">
  | null
  | undefined;

type EnvironmentClient = {
  beta: {
    environments: {
      create: (params: EnvironmentCreateParams) => Promise<{ id: string }>;
    };
  };
};

type EnsureEnvironmentResult = {
  environmentId: string;
  hash: string;
  created: boolean;
};

function canonicalizeJson(jsonNode: unknown): unknown {
  if (Array.isArray(jsonNode)) {
    return jsonNode.map((arrayEntry) => canonicalizeJson(arrayEntry));
  }

  if (jsonNode && typeof jsonNode === "object") {
    const recordNode = jsonNode as Record<string, unknown>;
    const sortedEntries = Object.keys(recordNode)
      .sort()
      .map((entryKey) => [entryKey, canonicalizeJson(recordNode[entryKey])] as const);

    return Object.fromEntries(sortedEntries);
  }

  return jsonNode;
}

export function buildEnvironmentDefinition(opts?: { name?: string }): EnvironmentCreateParams {
  return {
    name: opts?.name ?? DEFAULT_ENVIRONMENT_NAME,
    config: {
      type: "cloud",
      networking: { type: "unrestricted" } as BetaUnrestrictedNetwork,
      packages: {
        type: "packages",
        npm: ["bun"],
        apt: ["git"],
      },
    },
  };
}

export function hashEnvironmentDefinition(definition: EnvironmentCreateParams): string {
  const canonicalDefinition = canonicalizeJson(definition);

  return createHash("sha256").update(JSON.stringify(canonicalDefinition)).digest("hex");
}

export async function ensureEnvironment(
  client: EnvironmentClient,
  state: EnvironmentCacheState,
): Promise<EnsureEnvironmentResult> {
  const definition = buildEnvironmentDefinition();
  const definitionHash = hashEnvironmentDefinition(definition);

  if (state?.environmentId && state.definitionHash === definitionHash) {
    return {
      environmentId: state.environmentId,
      hash: definitionHash,
      created: false,
    };
  }

  const createdEnvironment = await client.beta.environments.create({
    ...definition,
    metadata: {
      definition_hash: definitionHash,
    },
  });

  return {
    environmentId: createdEnvironment.id,
    hash: definitionHash,
    created: true,
  };
}
