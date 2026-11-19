import type {
  BoundaError,
  ReadModelRestoringError,
  RestoreUnreconciledError,
} from "@bounda-dev/core";
import type { Adapter, RestoreArgs, RestrictedPersonsStore } from "@bounda-dev/core/adapter";
import type { CreateSqliteAdapterArgs, SqliteCopy } from "@bounda-dev/core/adapter/sqlite";
import type { RestoreTarget } from "@bounda-dev/core/adapter/testing";
import { describe, expectTypeOf, it } from "vitest";

describe("restoring a copy in place", () => {
  it("is an adapter's optional method, given where the copy is", () => {
    expectTypeOf<Adapter["restore"]>().toEqualTypeOf<
      ((args: RestoreArgs) => Promise<void>) | undefined
    >();
    expectTypeOf<RestoreArgs>().toEqualTypeOf<{ readonly copy: string }>();
  });

  it("is built over any SQLite from a copy opened for reading", () => {
    expectTypeOf<CreateSqliteAdapterArgs<"x", unknown, unknown>["openCopy"]>().toEqualTypeOf<
      ((copy: string) => Promise<SqliteCopy>) | undefined
    >();
    expectTypeOf<SqliteCopy["close"]>().toEqualTypeOf<() => Promise<void>>();
  });

  it("is proved by the restore contract through the adapter a running app opened", () => {
    type Opened = RestoreTarget["storage"];
    expectTypeOf<RestoreTarget["restore"]>().parameters.toEqualTypeOf<
      [opened?: Opened | undefined]
    >();
    expectTypeOf<RestoreTarget["restore"]>().returns.toEqualTypeOf<Promise<Opened>>();
  });

  it("asks every database's copy of who is restricted to clear", () => {
    expectTypeOf<RestrictedPersonsStore["clear"]>().toEqualTypeOf<() => Promise<void>>();
  });
});

describe("what a read refuses after a restore", () => {
  it("names the read model that is not back where it stood", () => {
    expectTypeOf<ReadModelRestoringError>().toExtend<BoundaError>();
    expectTypeOf<ReadModelRestoringError["readModel"]>().toEqualTypeOf<string>();
    expectTypeOf<ConstructorParameters<typeof ReadModelRestoringError>>().toEqualTypeOf<
      [readModel: string]
    >();
  });

  it("refuses until the ledger is reconciled, with why it is not as an optional cause", () => {
    expectTypeOf<RestoreUnreconciledError>().toExtend<BoundaError>();
    expectTypeOf<ConstructorParameters<typeof RestoreUnreconciledError>>().toEqualTypeOf<
      [cause?: unknown]
    >();
  });
});
