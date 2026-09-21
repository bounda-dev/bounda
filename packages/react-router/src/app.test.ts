import { describe, expect, it } from "vitest";

describe("@bounda-dev/react-router/app without the plugin", () => {
  it("fails at import with the plugin to add", async () => {
    const failure = import("./app.ts");
    await expect(failure).rejects.toThrow(
      "@bounda-dev/react-router/app is served by the bounda() Vite plugin",
    );
    await expect(failure).rejects.toThrow("plugins: [bounda(), reactRouter()]");
  });
});
