import { describe, expect, test } from "bun:test";

import { SpawnChildTaskInput, SpawnChildTaskOutput } from "@/features/child-execution/schemas";

function schemaDescription(schema: {
  description?: string;
  _def?: { description?: string };
}): string {
  return schema.description ?? schema._def?.description ?? "";
}

describe("SpawnChildTaskInput", () => {
  test("accepts a valid payload", () => {
    const parsed = SpawnChildTaskInput.parse({
      acceptanceCriteria: ["passes tests", "updates docs"],
      branch: "task/child-1",
      description: "Implement the child task handler",
      priorCommits: [{ message: "feat: initial setup", sha: "abc123" }],
      taskId: "task-1",
      title: "Implement child task",
    });

    expect(parsed).toEqual({
      acceptanceCriteria: ["passes tests", "updates docs"],
      branch: "task/child-1",
      description: "Implement the child task handler",
      priorCommits: [{ message: "feat: initial setup", sha: "abc123" }],
      taskId: "task-1",
      title: "Implement child task",
    });
  });

  test("surfaces taskId path and invalid_type metadata for wrong types", () => {
    const parseOutcome = SpawnChildTaskInput.safeParse({ taskId: 123 });

    expect(parseOutcome.success).toBe(false);

    if (parseOutcome.success) {
      throw new Error("Expected schema parse to fail");
    }

    expect(parseOutcome.error.issues).toContainEqual(
      expect.objectContaining({
        code: "invalid_type",
        expected: "string",
        path: ["taskId"],
        received: "number",
      }),
    );
  });

  test("rejects missing required fields", () => {
    const parseOutcome = SpawnChildTaskInput.safeParse({
      branch: "task/child-1",
      description: "Implement the child task handler",
      taskId: "task-1",
      title: "Implement child task",
    });

    expect(parseOutcome.success).toBe(false);

    if (parseOutcome.success) {
      throw new Error("Expected schema parse to fail");
    }

    expect(parseOutcome.error.issues).toContainEqual(
      expect.objectContaining({ path: ["acceptanceCriteria"] }),
    );
  });
});

describe("SpawnChildTaskOutput", () => {
  test("accepts a valid payload with optional commitSha omitted", () => {
    const parsed = SpawnChildTaskOutput.parse({
      filesChanged: ["src/shared/state.ts"],
      success: true,
      taskId: "task-1",
      testOutput: "bun test",
    });

    expect(parsed.commitSha).toBeUndefined();
    expect(parsed.success).toBe(true);
  });

  test("rejects a payload missing taskId", () => {
    const parseOutcome = SpawnChildTaskOutput.safeParse({ success: false });

    expect(parseOutcome.success).toBe(false);

    if (parseOutcome.success) {
      throw new Error("Expected schema parse to fail");
    }

    expect(parseOutcome.error.issues).toContainEqual(expect.objectContaining({ path: ["taskId"] }));
  });
});

describe("SpawnChildTask schema descriptions", () => {
  test("input/output schemas expose non-empty descriptions", () => {
    expect(schemaDescription(SpawnChildTaskInput)).not.toBe("");
    expect(schemaDescription(SpawnChildTaskOutput)).not.toBe("");
  });

  test("major input fields expose non-empty descriptions", () => {
    expect(schemaDescription(SpawnChildTaskInput.shape.taskId)).not.toBe("");
    expect(schemaDescription(SpawnChildTaskInput.shape.title)).not.toBe("");
  });
});
