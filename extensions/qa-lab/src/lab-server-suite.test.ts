import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { postLabJson, writeQaLabSuiteResultFixture } from "./lab-server-suite.test-support.js";
import { startQaLabServer } from "./lab-server.js";
import { loadQaRunnerModelOptions } from "./model-catalog.runtime.js";
import * as suiteSummary from "./suite-summary.js";

const suiteLaunchMock = vi.hoisted(() => ({ runQaSuite: vi.fn() }));

// mock-isolation: Keep suite process and provider startup outside this HTTP lifecycle fixture.
vi.mock("./suite-launch.runtime.js", () => ({ runQaSuite: suiteLaunchMock.runQaSuite }));

// mock-isolation: Record catalog dispatch without starting its CLI child.
vi.mock("./model-catalog.runtime.js", () => ({ loadQaRunnerModelOptions: vi.fn(async () => []) }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

it("serializes suite admission and drains accepted work before stopping the bus", async ({
  signal,
}) => {
  const summaryValidated = Promise.withResolvers<number>();
  const readSummary = suiteSummary.readQaSuiteFailedOrSkippedScenarioCountFromFile;
  using _ = vi
    .spyOn(suiteSummary, "readQaSuiteFailedOrSkippedScenarioCountFromFile")
    .mockImplementation((...args) => {
      const validation = readSummary(...args);
      // Returning the same promise lets the server publish status before this test resumes.
      void validation.then(summaryValidated.resolve, summaryValidated.reject);
      return validation;
    });
  const lab = await startQaLabServer({ embeddedGateway: "disabled" });
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= lab.stop());
  cleanups.push(stop);
  let finishSuite: ((value: unknown) => void) | undefined;
  suiteLaunchMock.runQaSuite.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishSuite = resolve;
      }),
  );
  const request = () =>
    postLabJson(lab.baseUrl, "/api/scenario/suite", {
      channelDriver: "crabline",
      providerMode: "live-frontier",
      scenarioIds: ["dm-chat-baseline"],
    });

  const responses = await Promise.all([request(), request()]);

  expect(
    responses.map((response) => response.status).toSorted((left, right) => left - right),
  ).toEqual([202, 409]);
  expect(suiteLaunchMock.runQaSuite).toHaveBeenCalledTimes(1);
  const result = {
    executionKind: "flow",
    expectedCells: [],
    observedCells: [],
    result: await writeQaLabSuiteResultFixture(tempDirs.make("qa-lab-suite-result-")),
  };
  let stopped = false;
  const stoppedRun = stop().then(() => {
    stopped = true;
  });
  try {
    const outbound = await postLabJson(lab.baseUrl, "/v1/outbound/message", {
      to: "dm:qa-operator",
      text: "accepted suite still delivering",
    });
    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      message: { direction: "outbound", text: "accepted suite still delivering" },
    });
    expect(stopped).toBe(false);
    const bootstrap = await fetch(`${lab.baseUrl}/api/bootstrap`);
    expect(bootstrap.status).toBe(200);
    await bootstrap.json();
    expect(loadQaRunnerModelOptions).not.toHaveBeenCalled();
    for (const route of ["/api/reset", "/api/scenario/self-check", "/api/scenario/suite"]) {
      const response = await postLabJson(lab.baseUrl, route, {});
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "QA Lab is stopping" });
    }
  } finally {
    finishSuite?.(result);
    await withinTest(summaryValidated.promise, signal);
    await withinTest(stoppedRun, signal);
  }
  expect(stopped).toBe(true);
  await expect(fetch(`${lab.baseUrl}/healthz`)).rejects.toThrow();
});
