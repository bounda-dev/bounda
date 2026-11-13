import { describe, expect, it } from "vitest";
import type { Table } from "../adapter/storage/table.ts";
import type { EventPayloadArgs, PayloadArgs } from "../modules/payload.ts";
import type { Registry } from "../modules/registry.ts";
import type { FieldsArgs } from "../modules/view.ts";
import { expectRestricted, NotRestrictedError } from "./expect-restricted.ts";
import { createTestApp } from "./index.ts";

interface Row {
  readonly customerId: string;
  readonly email?: string;
}

const registry = {
  aggregates: {
    customer: {
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ email: personal(z.email()) }),
          evolve: () => ({}),
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string(), email: z.email() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { email: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.customerRegistered?.({ email: command.payload.email })],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {
    customers: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          email: f.string().optional().personal(),
        }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: ({
              event,
              table,
            }: {
              event: { aggregateId: string; payload: { email: string | null } };
              table: Table<Row>;
            }) =>
              table.upsert({
                customerId: event.aggregateId,
                ...(event.payload.email === null ? {} : { email: event.payload.email }),
              }),
          },
        },
        bounda: { personalDataForgotten: { project: () => undefined } },
      },
      queries: {
        all: { handler: ({ table }: { table: Table<Row> }) => table.findMany() },
      },
    },
  },
} as unknown as Registry;

const setup = async () => {
  const { app } = await createTestApp({ registry });
  const commands = app.commands as unknown as Record<
    string,
    (payload: unknown) => Promise<unknown>
  >;
  const queries = app.queries as unknown as Record<
    string,
    (payload?: unknown, options?: object) => Promise<unknown>
  >;
  await commands.registerCustomer?.({ customerId: "ana", email: "ana@example.com" });
  await app.runUntilIdle();
  return { app, queries };
};

describe("expectRestricted", () => {
  it("passes when what the app hands out keeps the person's restricted data back", async () => {
    const { app, queries } = await setup();
    await app.restrict("ana", { ground: "accuracy-contested" });
    await app.catchUpReadModels();
    await expect(
      expectRestricted(app, "ana", { places: { "all customers": await queries.all?.() } }),
    ).resolves.toBeUndefined();
    await app.stop();
  });

  it("names each value something handed out, and where", async () => {
    const { app, queries } = await setup();
    await app.restrict("ana", { ground: "accuracy-contested" });
    await app.catchUpReadModels();
    const leaked = await queries.all?.(undefined, { includeRestricted: "consent" });
    const refused = await expectRestricted(app, "ana", {
      places: { "all customers": leaked },
      values: ["ANA@EXAMPLE.COM"],
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(NotRestrictedError);
    expect(refused).toMatchObject({
      personId: "ana",
      found: [{ value: "ana@example.com", place: "all customers", field: "[0].email" }],
    });
    expect((refused as Error).message).toContain('"ana@example.com" in all customers, [0].email');
    await app.stop();
  });

  it("refuses a person without a restriction, and one none of whose values a restriction covers", async () => {
    const { app } = await setup();
    await expect(expectRestricted(app, "ana")).rejects.toThrow(
      'expectRestricted found no restriction of "ana": restrict them first',
    );
    await app.restrict("bo", { ground: "accuracy-contested" });
    await expect(expectRestricted(app, "bo")).rejects.toThrow(
      'expectRestricted found no value of "bo" their restriction covers',
    );
    await app.stop();
  });
});
