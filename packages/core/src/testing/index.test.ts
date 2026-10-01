import { describe, expect, it } from "vitest";
import type { CreateArgs } from "../modules/collaborator.ts";
import type { Registry } from "../modules/registry.ts";
import { registry } from "../node/fixtures/project/registry.ts";
import { createTestApp } from "./index.ts";

describe("createTestApp", () => {
  it("boots on the in-memory adapter with a fixed clock and sequential ids", async () => {
    const { app, clock, ids } = await createTestApp({ registry });
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    const result = await app.commands.increment({ counterId: "c-1" });
    expect(result).toMatchObject({ version: 1, eventIds: ["id-2"] });
    expect(ids.next()).toBe("id-3");
    await app.processUntilIdle();
    expect((await app.getLag()).maxLag).toBe(0);
    await app.stop();
  });

  it("accepts runtime configuration and a custom start time", async () => {
    const { app, clock } = await createTestApp({
      registry,
      config: { runtime: { role: "web" } },
      now: new Date("2030-06-01T12:00:00.000Z"),
    });
    expect(app.role).toBe("web");
    expect(clock.now().toISOString()).toBe("2030-06-01T12:00:00.000Z");
    await app.stop();
  });

  it("hands the env it is given to the collaborators' create, and an empty one otherwise", async () => {
    const seen: unknown[] = [];
    const withPort = {
      ...registry,
      aggregates: {
        counter: {
          ...registry.aggregates.counter,
          collaborators: {
            clock: {
              env: {
                create: ({ env }: CreateArgs) => {
                  seen.push(env);
                  return {};
                },
              },
            },
          },
        },
      },
    } satisfies Registry;
    const given = await createTestApp({ registry: withPort, env: { REGION: "eu" } });
    const empty = await createTestApp({ registry: withPort });
    expect(seen).toEqual([{ REGION: "eu" }, {}]);
    await given.app.stop();
    await empty.app.stop();
  });
});
