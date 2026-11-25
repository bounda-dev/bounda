import { afterEach, describe, expect, it, vi } from "vitest";

describe("@bounda-dev/react-router/app without the plugin", () => {
  afterEach(() => {
    vi.doUnmock("@bounda-dev/core");
    vi.doUnmock("react-router");
    vi.resetModules();
  });

  it("fails at import with the plugin to add", async () => {
    const failure = import("./app.ts");
    await expect(failure).rejects.toThrow(
      "@bounda-dev/react-router/app is served by the bounda() Vite plugin",
    );
    await expect(failure).rejects.toThrow("plugins: [bounda(), reactRouter()]");
  });

  it("fails before it loads what its re-exports need", async () => {
    const loaded: string[] = [];
    vi.resetModules();
    vi.doMock("@bounda-dev/core", () => {
      loaded.push("@bounda-dev/core");
      return {};
    });
    vi.doMock("react-router", () => {
      loaded.push("react-router");
      return {};
    });
    await expect(import("./app.ts")).rejects.toThrow("bounda() Vite plugin");
    expect(loaded).toEqual([]);
  });
});
