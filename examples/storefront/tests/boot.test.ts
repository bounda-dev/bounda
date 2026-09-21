import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sqlite } from "@bounda-dev/adapter-sqlite";
import { silentLogger } from "@bounda-dev/core";
import { boot } from "@bounda-dev/core/node";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const temporary: string[] = [];

afterAll(async () => {
  await Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("boot", () => {
  it("starts the app from the generated registry on a SQLite file and serves a full cycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "storefront-"));
    temporary.push(directory);
    const app = await boot({
      root,
      config: {
        storage: sqlite({ path: join(directory, "storefront.db") }),
        commands: { sendConfirmation: { notifier: { use: "memory" } } },
      },
      signals: false,
      logger: silentLogger,
    });
    const orderId = "018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e03";
    await app.commands.placeOrder({
      orderId,
      customerId: "grace",
      items: [{ productId: "lamp", quantity: 1, price: 42 }],
    });
    await app.processUntilIdle();
    expect(await app.queries.getOrderSummary({ orderId })).toMatchObject({
      status: "placed",
      confirmationSent: true,
    });
    await app.stop();

    const again = await boot({
      root,
      config: {
        storage: sqlite({ path: join(directory, "storefront.db") }),
        commands: { sendConfirmation: { notifier: { use: "memory" } } },
      },
      signals: false,
      logger: silentLogger,
    });
    expect(await again.queries.getMyOrders({ customerId: "grace" })).toHaveLength(1);
    await again.stop();
  });
});
