import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";

const RUN_ID_PATH = "/tmp/ghissue-runid";

type HarnessRun = {
  exitCode: number;
  stderrText: string;
  stdoutText: string;
};

async function removeRunIdMarker(): Promise<void> {
  await rm(RUN_ID_PATH, { force: true });
}

function createSpawnEnv(overrides: Record<string, string | undefined>): Record<string, string> {
  const inheritedEntries = Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  const nextEnv = Object.fromEntries(inheritedEntries);

  delete nextEnv.E2E;
  delete nextEnv.TEST_REPO;
  delete nextEnv.TEST_ISSUE;
  delete nextEnv.ANTHROPIC_API_KEY;
  delete nextEnv.GITHUB_TOKEN;

  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") {
      nextEnv[key] = value;
    } else {
      delete nextEnv[key];
    }
  }

  return nextEnv;
}

async function runHarness(overrides: Record<string, string | undefined>): Promise<HarnessRun> {
  const child = spawn("bun", ["run", "scripts/e2e-real.ts"], {
    cwd: process.cwd(),
    env: createSpawnEnv(overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutText = "";
  let stderrText = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutText += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderrText += chunk;
  });

  const [exitCode] = await once(child, "close");

  return {
    exitCode: typeof exitCode === "number" ? exitCode : -1,
    stderrText,
    stdoutText,
  };
}

beforeEach(async () => {
  await removeRunIdMarker();
});

afterEach(async () => {
  await removeRunIdMarker();
});

describe("e2e-real gate and validation", () => {
  test("E2E unset -> exit 0 with skip message", async () => {
    const harnessOutcome = await runHarness({
      TEST_ISSUE: "1",
      TEST_REPO: "example-owner/example-repo",
    });
    const combinedOutput = `${harnessOutcome.stdoutText}${harnessOutcome.stderrText}`;

    expect(harnessOutcome.exitCode).toBe(0);
    expect(combinedOutput).toContain("e2e-real: skipping");
    expect(combinedOutput).toContain("E2E=1 not set");
  });

  test("E2E='0' -> exit 0 with skip message", async () => {
    const harnessOutcome = await runHarness({
      E2E: "0",
      TEST_ISSUE: "1",
      TEST_REPO: "example-owner/example-repo",
    });
    const combinedOutput = `${harnessOutcome.stdoutText}${harnessOutcome.stderrText}`;

    expect(harnessOutcome.exitCode).toBe(0);
    expect(combinedOutput).toContain("e2e-real: skipping");
    expect(combinedOutput).toContain("refusing to run");
  });

  test("E2E=1 with malformed TEST_REPO -> exit 0 with skip message", async () => {
    const harnessOutcome = await runHarness({
      E2E: "1",
      TEST_ISSUE: "1",
      TEST_REPO: "malformed-repo",
    });
    const combinedOutput = `${harnessOutcome.stdoutText}${harnessOutcome.stderrText}`;

    expect(harnessOutcome.exitCode).toBe(0);
    expect(combinedOutput).toContain("e2e-real: skipping");
    expect(combinedOutput).toContain("TEST_REPO");
  });

  test("E2E=1 with valid TEST_REPO and missing TEST_ISSUE -> exit 0 with skip message", async () => {
    const harnessOutcome = await runHarness({
      E2E: "1",
      TEST_REPO: "example-owner/example-repo",
    });
    const combinedOutput = `${harnessOutcome.stdoutText}${harnessOutcome.stderrText}`;

    expect(harnessOutcome.exitCode).toBe(0);
    expect(combinedOutput).toContain("e2e-real: skipping");
    expect(combinedOutput).toContain("TEST_ISSUE");
  });

  test("E2E=1 with valid repo/issue and missing ANTHROPIC_API_KEY -> exit 0 with skip message", async () => {
    const harnessOutcome = await runHarness({
      ANTHROPIC_API_KEY: "",
      E2E: "1",
      GITHUB_TOKEN: "ghp_fakefakefakefakefakefakefakefakefake",
      TEST_ISSUE: "1",
      TEST_REPO: "example-owner/example-repo",
    });
    const combinedOutput = `${harnessOutcome.stdoutText}${harnessOutcome.stderrText}`;

    expect(harnessOutcome.exitCode).toBe(0);
    expect(combinedOutput).toContain("e2e-real: skipping");
    expect(combinedOutput).toContain("ANTHROPIC_API_KEY");
  });

  test("E2E=1 with missing GITHUB_TOKEN -> exit 0 with skip message", async () => {
    const harnessOutcome = await runHarness({
      ANTHROPIC_API_KEY: "sk-ant-fakefakefake",
      E2E: "1",
      GITHUB_TOKEN: "",
      TEST_ISSUE: "1",
      TEST_REPO: "example-owner/example-repo",
    });
    const combinedOutput = `${harnessOutcome.stdoutText}${harnessOutcome.stderrText}`;

    expect(harnessOutcome.exitCode).toBe(0);
    expect(combinedOutput).toContain("e2e-real: skipping");
    expect(combinedOutput).toContain("GITHUB_TOKEN");
  });
});
