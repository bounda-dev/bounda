import { getContainerRuntimeClient } from "testcontainers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startContainer } from "./start-container.ts";

vi.mock("testcontainers", () => ({ getContainerRuntimeClient: vi.fn() }));

const runtime = vi.mocked(getContainerRuntimeClient);
const notRunning = new Error("Could not find a working container runtime strategy");

const dockerIsNotRunning = (): void => {
  runtime.mockRejectedValue(notRunning);
};

const dockerIsRunning = (): void => {
  runtime.mockResolvedValue({} as Awaited<ReturnType<typeof getContainerRuntimeClient>>);
};

beforeEach(() => {
  runtime.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("startContainer outside CI", () => {
  for (const ci of [undefined, "", "false"]) {
    it(`skips when Docker is not running, with CI ${JSON.stringify(ci)}`, async () => {
      vi.stubEnv("CI", ci);
      dockerIsNotRunning();
      const start = vi.fn(async () => "container");

      await expect(startContainer(start)).resolves.toBeNull();
      expect(start).not.toHaveBeenCalled();
    });
  }

  it("rejects with the error when the container fails to start", async () => {
    vi.stubEnv("CI", undefined);
    dockerIsRunning();
    const refused = new Error("toomanyrequests: You have reached your pull rate limit");

    await expect(startContainer(() => Promise.reject(refused))).rejects.toBe(refused);
  });

  it("resolves the started container when Docker is running", async () => {
    vi.stubEnv("CI", undefined);
    dockerIsRunning();

    await expect(startContainer(async () => "container")).resolves.toBe("container");
  });
});

describe("startContainer in CI", () => {
  for (const ci of ["true", "1"]) {
    it(`rejects when Docker is not running, with CI ${JSON.stringify(ci)}`, async () => {
      vi.stubEnv("CI", ci);
      dockerIsNotRunning();
      const start = vi.fn(async () => "container");

      const rejected = await startContainer(start).catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(Error);
      expect(rejected).toMatchObject({
        message: "Docker is not running, and in CI every suite that needs it must run",
        cause: notRunning,
      });
      expect(start).not.toHaveBeenCalled();
    });
  }

  it("rejects with the error when the container fails to start", async () => {
    vi.stubEnv("CI", "true");
    dockerIsRunning();
    const refused = new Error("toomanyrequests: You have reached your pull rate limit");

    await expect(startContainer(() => Promise.reject(refused))).rejects.toBe(refused);
  });

  it("resolves the started container when Docker is running", async () => {
    vi.stubEnv("CI", "true");
    dockerIsRunning();

    await expect(startContainer(async () => "container")).resolves.toBe("container");
  });
});
