#!/usr/bin/env bun

import { performance } from "node:perf_hooks";
import process from "node:process";

import { D1HttpClient } from "../src/shared/persistence/d1-http-client";

const SINGLE_QUERY_COUNT = 100;
const BATCH_TRANSACTION_COUNT = 20;
const SINGLE_QUERY_P95_THRESHOLD_MS = 80;
const BATCH_TRANSACTION_P95_THRESHOLD_MS = 200;

type PercentileSummary = {
  p50: number;
  p95: number;
  p99: number;
};

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (value === undefined || value.length === 0) {
    process.stderr.write(`Missing ${name}. Set D1_ACCOUNT_ID, D1_DATABASE_ID, and D1_API_TOKEN.\n`);
    process.exit(1);
  }

  return value;
}

async function measure(operation: () => Promise<unknown>, count: number): Promise<number[]> {
  const durations: number[] = [];

  for (let index = 0; index < count; index += 1) {
    const startedAt = performance.now();
    await operation();
    durations.push(performance.now() - startedAt);
  }

  return durations;
}

function percentile(sortedDurations: readonly number[], percentileValue: number): number {
  if (sortedDurations.length === 0) {
    throw new Error("Cannot compute percentiles for an empty sample");
  }

  const rawIndex = Math.ceil((percentileValue / 100) * sortedDurations.length) - 1;
  const boundedIndex = Math.min(Math.max(rawIndex, 0), sortedDurations.length - 1);
  const value = sortedDurations[boundedIndex];

  if (value === undefined) {
    throw new Error(`Percentile index ${boundedIndex} was outside the sample`);
  }

  return value;
}

function summarize(durations: readonly number[]): PercentileSummary {
  const sortedDurations = [...durations].sort((left, right) => left - right);

  return {
    p50: percentile(sortedDurations, 50),
    p95: percentile(sortedDurations, 95),
    p99: percentile(sortedDurations, 99),
  };
}

function formatMs(value: number): string {
  return `${value.toFixed(2)}ms`;
}

function printSummary(label: string, summary: PercentileSummary, thresholdMs: number): boolean {
  const passed = summary.p95 <= thresholdMs;
  process.stdout.write(
    `${label}: p50=${formatMs(summary.p50)} p95=${formatMs(summary.p95)} p99=${formatMs(
      summary.p99,
    )} threshold_p95<=${formatMs(thresholdMs)} ${passed ? "PASS" : "FAIL"}\n`,
  );
  return passed;
}

async function main(): Promise<number> {
  const client = new D1HttpClient({
    accountId: readRequiredEnv("D1_ACCOUNT_ID"),
    apiToken: readRequiredEnv("D1_API_TOKEN"),
    databaseId: readRequiredEnv("D1_DATABASE_ID"),
  });
  const selectOne = client.prepare("SELECT 1");
  const batchedTransaction = client.transaction(() => {
    client.prepare("SELECT 1").all();
    client.prepare("SELECT 2").all();
    client.prepare("SELECT 3").all();
    client.prepare("SELECT 4").all();
  });

  process.stdout.write(`Running ${SINGLE_QUERY_COUNT} sequential SELECT 1 queries...\n`);
  const singleQueryDurations = await measure(() => selectOne.all(), SINGLE_QUERY_COUNT);

  process.stdout.write(
    `Running ${BATCH_TRANSACTION_COUNT} batched BEGIN/SELECT/COMMIT transactions...\n`,
  );
  const batchDurations = await measure(() => batchedTransaction(), BATCH_TRANSACTION_COUNT);

  const singlePassed = printSummary(
    "single-query RTT",
    summarize(singleQueryDurations),
    SINGLE_QUERY_P95_THRESHOLD_MS,
  );
  const batchPassed = printSummary(
    "batched-transaction RTT",
    summarize(batchDurations),
    BATCH_TRANSACTION_P95_THRESHOLD_MS,
  );
  const passed = singlePassed && batchPassed;

  process.stdout.write(`overall ${passed ? "PASS" : "FAIL"}\n`);
  return passed ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
