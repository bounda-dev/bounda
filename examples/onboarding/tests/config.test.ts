import { afterEach, describe, expect, it, vi } from "vitest";

const load = async () => (await import("../bounda.config.ts")).default;

describe("bounda.config.ts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("runs on SQLite when DATABASE_URL is not set", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    expect((await load()).storage.name).toBe("sqlite");
  });

  it("runs on PostgreSQL when DATABASE_URL is set", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/onboarding");
    expect((await load()).storage.name).toBe("postgresql");
  });
});
