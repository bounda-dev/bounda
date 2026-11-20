import { afterEach, describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { type BoundaApp, createApp } from "../../kernel/app.ts";
import type { CommandPayloadArgs, EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { QueryOptions } from "../../modules/query.ts";
import type { Registry } from "../../modules/registry.ts";
import { type FieldsArgs, fieldBuilder as f } from "../../modules/view.ts";
import type { Adapter, ReadModelStorage } from "../adapter.ts";
import type { RestrictionView } from "../storage/restricted-persons.ts";
import { RETAINED_KEY_PREFIX, storedFields } from "../storage/sealed-fields.ts";
import type { ReadClient, Table } from "../storage/table.ts";

/**
 * A database an app runs on, and how its hand-written SQL reaches it.
 */
export interface RestrictedSqlTarget {
  readonly storage: Adapter;
  /**
   * The name of the read model's table, as hand-written SQL names it.
   */
  table(readModel: string): string;
  /**
   * The rows `sql`, which binds no parameter, answers through the driver `client.raw` is.
   */
  raw(driver: unknown, sql: string): Promise<readonly Record<string, unknown>[]>;
}

export interface RestrictedSqlContractArgs {
  /**
   * A fresh, empty database.
   */
  readonly create: () => Promise<RestrictedSqlTarget>;
}

export interface RestrictedSqlContractFunction {
  (args: RestrictedSqlContractArgs): void;
}

interface OrderRow {
  readonly orderId: string;
  readonly customerId: string;
  readonly total: number;
}

type Client = ReadClient<OrderRow>;

const PAGE = 2;

const registryFor = (target: RestrictedSqlTarget): Registry => {
  const orders = target.table("orders");
  const ids = (rows: readonly { readonly orderId?: unknown; readonly order_id?: unknown }[]) =>
    rows.map((row) => String(row.orderId ?? row.order_id));
  return {
    aggregates: {
      order: {
        stateFingerprint: "restricted-sql-contract",
        state: { initialState: {} },
        events: {
          orderPlaced: {
            payload: ({ z, notPersonal }: EventPayloadArgs) =>
              z.object({ customerId: notPersonal(z.string()), total: z.number() }),
            evolve: () => ({}),
          },
        },
        commands: {
          placeOrder: {
            module: {
              payload: ({ z, notPersonal }: CommandPayloadArgs) =>
                z.object({
                  orderId: notPersonal(z.string()),
                  customerId: notPersonal(z.string()),
                  total: z.number(),
                }),
              handler: ({
                command,
                events,
              }: {
                command: { payload: { customerId: string; total: number } };
                events: Record<string, (payload?: unknown) => unknown>;
              }) => [
                events.orderPlaced?.({
                  customerId: command.payload.customerId,
                  total: command.payload.total,
                }),
              ],
            },
          },
        },
        policies: {},
        processes: {},
      },
    },
    readModels: {
      orders: {
        view: {
          fields: ({ f }: FieldsArgs) => ({
            orderId: f.string().primaryKey().notPersonal(),
            customerId: f.string().index().person(),
            total: f.number(),
          }),
        },
        projections: {
          order: {
            orderPlaced: {
              project: ({
                event,
                table,
              }: {
                event: StoredEvent<"OrderPlaced", { customerId: string; total: number }>;
                table: Table<OrderRow>;
              }) =>
                table.upsert({
                  orderId: event.aggregateId,
                  customerId: event.payload.customerId,
                  total: event.payload.total,
                }),
            },
          },
        },
        queries: {
          page: {
            payload: ({ z }: PayloadArgs) => z.object({ offset: z.number().int().min(0) }),
            repository: async ({ client, offset }: { client: Client; offset: number }) =>
              ids(
                await client.all(
                  `SELECT order_id, customer_id FROM ${orders} WHERE ${client.unrestricted()} ORDER BY order_id LIMIT ${PAGE} OFFSET ${offset}`,
                ),
              ),
            handler: ({ repositoryData }: { repositoryData: readonly string[] }) => repositoryData,
          },
          aliased: {
            payload: ({ z }: PayloadArgs) => z.object({ offset: z.number().int().min(0) }),
            repository: async ({ client, offset }: { client: Client; offset: number }) =>
              ids(
                await client.all(
                  `SELECT o.order_id FROM ${orders} AS o WHERE o.total > 0 AND ${client.unrestricted("o")} ORDER BY o.order_id LIMIT ${PAGE} OFFSET ${offset}`,
                ),
              ),
            handler: ({ repositoryData }: { repositoryData: readonly string[] }) => repositoryData,
          },
          first: {
            repository: async ({ client }: { client: Client }) =>
              (
                await client.get(
                  `SELECT order_id FROM ${orders} WHERE customer_id <> 'ana' AND ${client.unrestricted()} ORDER BY order_id`,
                )
              )?.orderId ?? null,
            handler: ({ repositoryData }: { repositoryData: string | null }) => repositoryData,
          },
          totals: {
            repository: async ({ client }: { client: Client }) => {
              const row = (await client.get(
                `SELECT COUNT(*) AS orders, SUM(total) AS spent FROM ${orders} WHERE ${client.unrestricted()}`,
              )) as unknown as { readonly orders: unknown; readonly spent: unknown };
              return { orders: Number(row.orders), spent: Number(row.spent) };
            },
            handler: ({ repositoryData }: { repositoryData: unknown }) => repositoryData,
          },
          unfenced: {
            payload: ({ z }: PayloadArgs) => z.object({ offset: z.number().int().min(0) }),
            repository: async ({ client, offset }: { client: Client; offset: number }) =>
              ids(
                await client.all(
                  `SELECT order_id, customer_id FROM ${orders} ORDER BY order_id LIMIT ${PAGE} OFFSET ${offset}`,
                ),
              ),
            handler: ({ repositoryData }: { repositoryData: readonly string[] }) => repositoryData,
          },
          unfencedIds: {
            repository: async ({ client }: { client: Client }) =>
              ids(await client.all(`SELECT order_id, total FROM ${orders} ORDER BY order_id`)),
            handler: ({ repositoryData }: { repositoryData: readonly string[] }) => repositoryData,
          },
          unfencedTotals: {
            repository: async ({ client }: { client: Client }) => {
              const row = (await client.get(
                `SELECT COUNT(*) AS orders FROM ${orders}`,
              )) as unknown as { readonly orders: unknown };
              return Number(row.orders);
            },
            handler: ({ repositoryData }: { repositoryData: unknown }) => repositoryData,
          },
          slipped: {
            repository: async ({ client }: { client: Client }) =>
              ids(
                await client.all(
                  `SELECT order_id, customer_id FROM ${orders} WHERE ${client.unrestricted()} OR 1 = 1 ORDER BY order_id`,
                ),
              ),
            handler: ({ repositoryData }: { repositoryData: readonly string[] }) => repositoryData,
          },
          badAlias: {
            repository: ({ client }: { client: Client }) => client.unrestricted("o; DROP TABLE o"),
            handler: ({ repositoryData }: { repositoryData: unknown }) => repositoryData,
          },
          rawPage: {
            payload: ({ z }: PayloadArgs) => z.object({ offset: z.number().int().min(0) }),
            repository: async ({ client, offset }: { client: Client; offset: number }) =>
              ids(
                await target.raw(
                  client.raw,
                  `SELECT order_id FROM ${orders} WHERE ${client.unrestricted()} ORDER BY order_id LIMIT ${PAGE} OFFSET ${offset}`,
                ),
              ),
            handler: ({ repositoryData }: { repositoryData: readonly string[] }) => repositoryData,
          },
        },
      },
    },
  } as unknown as Registry;
};

// Ana's orders, then Bo's, then Cy's: with Bo restricted, a page cut before Bo's rows are left out
// comes back short, and the one cut over Bo's alone comes back empty while Cy's order follows.
const ORDERS = [
  ["o-1", "ana", 10],
  ["o-2", "ana", 20],
  ["o-3", "bo", 30],
  ["o-4", "bo", 40],
  ["o-5", "cy", 50],
] as const;

/**
 * How every SQL adapter's read models answer hand-written SQL under a restriction of processing:
 * `client.unrestricted()` in a statement's `WHERE` leaves out the rows of restricted persons in
 * the database, so `LIMIT`, `OFFSET` and aggregates count only the others, on the basis the query
 * names; and a statement without it is refused. Call it inside a `describe` of the adapter's test
 * file.
 */
export const restrictedSqlContract: RestrictedSqlContractFunction = ({ create }) => {
  describe("restricted SQL contract", () => {
    const stops: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const stop of stops.splice(0)) await stop();
    });

    const restrictedApp = async () => {
      const target = await create();
      const app: BoundaApp<Registry> = await createApp<Registry>({
        registry: registryFor(target),
        config: { storage: target.storage },
        ids: createSequentialIdGenerator({ prefix: "restricted-sql" }),
        clock: createFixedClock(new Date("2026-05-01T00:00:00.000Z")),
      });
      stops.push(() => app.stop());
      for (const [orderId, customerId, total] of ORDERS) {
        await app.commands.placeOrder?.({ orderId, customerId, total });
      }
      await app.restrict("bo", { ground: "legal-claims" });
      await app.runUntilIdle();
      const query = (type: string, payload?: unknown, options?: QueryOptions) =>
        (app.queries[type] as (payload?: unknown, options?: QueryOptions) => Promise<unknown>)(
          payload,
          options,
        );
      return { app, query };
    };

    it("pages hand-written SQL exactly, the restricted rows left out before LIMIT and OFFSET", async () => {
      const { query } = await restrictedApp();
      expect(await query("page", { offset: 0 })).toEqual(["o-1", "o-2"]);
      expect(await query("page", { offset: 2 })).toEqual(["o-5"]);
      expect(await query("aliased", { offset: 2 })).toEqual(["o-5"]);
      expect(await query("first")).toBe("o-5");
      expect(await query("totals")).toEqual({ orders: 3, spent: 80 });
      expect(await query("rawPage", { offset: 2 })).toEqual(["o-5"]);
    });

    it("pages the restricted rows too on a basis that reads them", async () => {
      const { query } = await restrictedApp();
      const basis = { includeRestricted: "legal-claims" } as const;
      expect(await query("page", { offset: 2 }, basis)).toEqual(["o-3", "o-4"]);
      expect(await query("aliased", { offset: 2 }, basis)).toEqual(["o-3", "o-4"]);
      expect(await query("first", undefined, basis)).toBe("o-3");
      expect(await query("totals", undefined, basis)).toEqual({ orders: 5, spent: 150 });
      expect(await query("rawPage", { offset: 2 }, basis)).toEqual(["o-3", "o-4"]);
    });

    it("refuses hand-written SQL without the condition before it runs, on any basis", async () => {
      const { query } = await restrictedApp();
      for (const options of [undefined, { includeRestricted: "legal-claims" } as const]) {
        for (const [type, payload] of [
          ["unfenced", { offset: 2 }],
          ["unfencedIds", undefined],
          ["unfencedTotals", undefined],
        ] as const) {
          await expect(query(type, payload, options)).rejects.toThrow(
            new ConfigurationError(
              'A query of read model "orders" ran SQL through client without client.unrestricted() in it: put it in the statement\'s WHERE, so the rows of restricted persons are left out before LIMIT, OFFSET and aggregates count them',
            ),
          );
        }
      }
    });

    it("still leaves out a row of a restricted person the statement let through", async () => {
      const { query } = await restrictedApp();
      expect(await query("slipped")).toEqual(["o-1", "o-2", "o-5"]);
    });

    it("refuses an alias that is not a plain SQL identifier", async () => {
      const { query } = await restrictedApp();
      await expect(query("badAlias")).rejects.toThrow(
        new ConfigurationError(
          'Read model "orders": client.unrestricted names the alias "o; DROP TABLE o", which is not a plain SQL identifier: alias the table with letters, digits and underscores',
        ),
      );
    });

    describe("the condition each view renders", () => {
      // An odd category, so its name goes into the statement as a literal both engines read back.
      const ODD = "it's a \\ category";
      const fields = storedFields({
        readModel: "notes",
        fields: {
          noteId: f.string().primaryKey(),
          customerId: f.string().index().person(),
          text: f.string().optional().personal({ category: ODD }),
          total: f.number(),
        },
      });
      let target: RestrictedSqlTarget;
      let notes: ReadModelStorage<Record<string, unknown>>;

      const rowsOf = async (view: RestrictionView, alias?: string) => {
        const name = target.table("notes");
        const from = alias === undefined ? name : `${name} AS ${alias}`;
        const rows = await notes.client.all(
          `SELECT note_id FROM ${from} WHERE ${notes.restricted.condition(view, alias)} ORDER BY note_id`,
        );
        return rows.map((row) => String(row.noteId));
      };
      const tableRows = async (table: Table<Record<string, unknown>>) =>
        (await table.findMany({ orderBy: { field: "noteId", direction: "asc" } })).map((row) =>
          String(row.noteId),
        );

      afterEach(async () => {
        await notes.close();
      });

      it("reads what the view's table reads, in a statement that binds nothing", async () => {
        target = await create();
        notes = await target.storage.createReadModel({
          name: "notes",
          fields,
          logger: silentLogger,
        });
        for (const [noteId, customerId, key] of [
          ["n-1", "ana", "f-1"],
          ["n-2", "bo", "f-1"],
          ["n-3", "cy", "f-1"],
          ["n-4", "dan", `${RETAINED_KEY_PREFIX}f-kept`],
          ["n-5", "eve", "f-1"],
        ] as const) {
          await notes.table.upsert({ noteId, customerId, text: "x", text__key: key, total: 1 });
        }
        await notes.transact({
          subscriber: "restrictions:notes",
          wait: true,
          work: async ({ restrictedPersons }) => {
            await restrictedPersons.request("ana", [{ ground: "legal-claims", categories: null }]);
            await restrictedPersons.request("bo", [
              { ground: "objection-pending", categories: [ODD] },
            ]);
            await restrictedPersons.request("cy", [
              { ground: "objection-pending", categories: ["marketing"] },
            ]);
          },
        });
        expect(await rowsOf("unrestricted")).toEqual(["n-3", "n-5"]);
        expect(await rowsOf("unrestricted")).toEqual(
          await tableRows(notes.restricted.unrestricted),
        );
        expect(await rowsOf("retained", "n")).toEqual(["n-3", "n-4", "n-5"]);
        expect(await rowsOf("retained")).toEqual(await tableRows(notes.restricted.retained));
        expect(await rowsOf("all", "N")).toEqual(["n-1", "n-2", "n-3", "n-4", "n-5"]);
        const copy = `${target.table("notes").slice(0, -"rm_notes".length)}RESTRICTED_PERSONS`;
        await expect(rowsOf("unrestricted", copy)).rejects.toThrow(ConfigurationError);
      });
    });
  });
};
