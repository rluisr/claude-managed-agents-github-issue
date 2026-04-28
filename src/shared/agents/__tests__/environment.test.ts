import { describe, expect, test } from "bun:test";
import type {
  BetaUnrestrictedNetwork,
  EnvironmentCreateParams,
} from "@anthropic-ai/sdk/resources/beta/environments";
import type { AgentState } from "@/shared/types";
import {
  buildEnvironmentDefinition,
  ensureEnvironment,
  hashEnvironmentDefinition,
} from "../environment";

function assertEnvironmentCreateParams(
  definition: EnvironmentCreateParams,
): EnvironmentCreateParams {
  return definition;
}

function expectUnrestrictedNetwork<T extends BetaUnrestrictedNetwork>(_value: T): void {}

type DefinitionHasLegacyNetwork = "network" extends keyof ReturnType<
  typeof buildEnvironmentDefinition
>
  ? true
  : false;
type ConfigHasLegacyNetwork = "network" extends keyof NonNullable<
  ReturnType<typeof buildEnvironmentDefinition>["config"]
>
  ? true
  : false;
type UnrestrictedHasLegacyMode = "mode" extends keyof BetaUnrestrictedNetwork ? true : false;
type UnrestrictedHasAllowMcpServers = "allow_mcp_servers" extends keyof BetaUnrestrictedNetwork
  ? true
  : false;

function expectFalse<_Value extends false>(): void {}

function containsKey(value: unknown, searchedKey: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsKey(entry, searchedKey));
  }

  if (value && typeof value === "object") {
    const recordValue = value as Record<string, unknown>;

    return Object.entries(recordValue).some(
      ([entryKey, entryValue]) => entryKey === searchedKey || containsKey(entryValue, searchedKey),
    );
  }

  return false;
}

function createAgentState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    parentAgentId: "parent-agent",
    parentAgentVersion: 1,
    childAgentId: "child-agent",
    childAgentVersion: 2,
    environmentId: "env_cached",
    definitionHash: "cached-hash",
    createdAt: "2026-04-23T00:00:00.000Z",
    ...overrides,
  };
}

expectFalse<DefinitionHasLegacyNetwork>();
expectFalse<ConfigHasLegacyNetwork>();
expectFalse<UnrestrictedHasLegacyMode>();
expectFalse<UnrestrictedHasAllowMcpServers>();

describe("environment", () => {
  test("buildEnvironmentDefinition returns SDK-shaped cloud config", () => {
    const definition = assertEnvironmentCreateParams(
      buildEnvironmentDefinition({ name: "custom-environment" }),
    );

    expect(definition.name).toBe("custom-environment");

    if (!definition.config) {
      throw new Error("Expected config to be defined");
    }

    expect(definition.config.type).toBe("cloud");

    if (!definition.config.networking) {
      throw new Error("Expected networking to be defined");
    }

    if (definition.config.networking.type !== "unrestricted") {
      throw new Error("Expected unrestricted networking");
    }

    expectUnrestrictedNetwork(definition.config.networking);

    if (!definition.config.packages) {
      throw new Error("Expected packages to be defined");
    }

    expect(definition.config.packages).toEqual({
      type: "packages",
      npm: ["bun"],
      apt: ["git"],
    });
  });

  test("buildEnvironmentDefinition never emits legacy network fields", () => {
    const definition = buildEnvironmentDefinition();

    if (!definition.config) {
      throw new Error("Expected config to be defined");
    }

    if (!definition.config.networking) {
      throw new Error("Expected networking to be defined");
    }

    if (definition.config.networking.type !== "unrestricted") {
      throw new Error("Expected unrestricted networking");
    }

    expect(containsKey(definition, "network")).toBe(false);
    expect(containsKey(definition, "mode")).toBe(false);
    expect(containsKey(definition, "allow_mcp_servers")).toBe(false);
  });

  test("hashEnvironmentDefinition is stable for equivalent definitions", () => {
    const firstDefinition = buildEnvironmentDefinition({ name: "stable-environment" });
    const reorderedDefinition: EnvironmentCreateParams = {
      config: {
        packages: {
          apt: ["git"],
          npm: ["bun"],
          type: "packages",
        },
        networking: { type: "unrestricted" },
        type: "cloud",
      },
      name: "stable-environment",
    };

    const firstHash = hashEnvironmentDefinition(firstDefinition);
    const secondHash = hashEnvironmentDefinition(
      buildEnvironmentDefinition({ name: "stable-environment" }),
    );
    const reorderedHash = hashEnvironmentDefinition(reorderedDefinition);

    expect(firstHash).toBe(secondHash);
    expect(firstHash).toBe(reorderedHash);
    expect(firstHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("ensureEnvironment reuses a cached environment when the hash matches", async () => {
    const definition = buildEnvironmentDefinition();
    const definitionHash = hashEnvironmentDefinition(definition);
    let createCalls = 0;
    const client = {
      beta: {
        environments: {
          create: async (_params: EnvironmentCreateParams) => {
            createCalls += 1;

            return { id: "env_created" };
          },
        },
      },
    };

    const ensureOutcome = await ensureEnvironment(
      client,
      createAgentState({
        definitionHash,
        environmentId: "env_cached_match",
      }),
    );

    expect(ensureOutcome).toEqual({
      environmentId: "env_cached_match",
      hash: definitionHash,
      created: false,
    });
    expect(createCalls).toBe(0);
  });

  test("ensureEnvironment creates a new environment when the cache is stale", async () => {
    const createCalls: EnvironmentCreateParams[] = [];
    const client = {
      beta: {
        environments: {
          create: async (params: EnvironmentCreateParams) => {
            createCalls.push(params);

            return { id: "env_new" };
          },
        },
      },
    };

    const ensureOutcome = await ensureEnvironment(
      client,
      createAgentState({
        definitionHash: "stale-hash",
        environmentId: "env_stale",
      }),
    );
    const expectedDefinition = buildEnvironmentDefinition();
    const expectedHash = hashEnvironmentDefinition(expectedDefinition);

    expect(ensureOutcome).toEqual({
      environmentId: "env_new",
      hash: expectedHash,
      created: true,
    });
    expect(createCalls.length).toBe(1);

    const firstCreateCall = createCalls[0];

    if (!firstCreateCall) {
      throw new Error("Expected create to be called once");
    }

    expect(firstCreateCall).toEqual({
      ...expectedDefinition,
      metadata: {
        definition_hash: expectedHash,
      },
    });
  });
});
