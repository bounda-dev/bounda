import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { silentLogger } from "@bounda-dev/core";
import type { Adapter } from "@bounda-dev/core/adapter";
import {
  type ContractRow,
  checkpointStoreContract,
  contractFields,
  deadLetterStoreContract,
  eventStoreContract,
  inboxLedgerContract,
  readModelRebuildContract,
  readModelTransactionContract,
  schedulerContract,
  tableContract,
} from "@bounda-dev/core/adapter/testing";
import { describe } from "vitest";
import { durableObjectAdapter } from "../src/adapter.ts";
import { insideObject } from "./inside-object.ts";

const freshAdapter = async (): Promise<Adapter> => {
  const stub = env.BARE.get(env.BARE.newUniqueId());
  const adapter = await runInDurableObject(stub, (_instance, state) =>
    durableObjectAdapter({ storage: state.storage, options: {} }),
  );
  return insideObject(stub, adapter);
};

const freshStorage = async () => (await freshAdapter()).createStorage({ logger: silentLogger });

describe("the Durable Object adapter", () => {
  eventStoreContract({ create: async () => (await freshStorage()).eventStore });
  checkpointStoreContract({ create: async () => (await freshStorage()).checkpointStore });
  inboxLedgerContract({ create: async () => (await freshStorage()).inboxLedger });
  deadLetterStoreContract({ create: async () => (await freshStorage()).deadLetterStore });
  schedulerContract({ create: async () => (await freshStorage()).scheduler });
  tableContract({
    create: async () =>
      (
        await (
          await freshAdapter()
        ).createReadModel<ContractRow>({
          name: "orderSummary",
          fields: contractFields,
          logger: silentLogger,
        })
      ).table,
  });
  readModelRebuildContract({ create: freshAdapter, concurrent: false });
  readModelTransactionContract({
    create: freshAdapter,
    locking: "single-writer",
    concurrent: false,
  });
});
