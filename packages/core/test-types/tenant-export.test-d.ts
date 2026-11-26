import {
  type BoundaApp,
  type BoundaClient,
  type CausationContext,
  type DeadLetterKind,
  type DeadLetterStatus,
  type EventMetadata,
  type ExportedCategories,
  type ExportedCategory,
  type ExportedRestricted,
  type ExportedTransfer,
  type ExportOutcome,
  type PersonalDataAccess,
  type PersonRecipient,
  type ProcessingRestriction,
  type ReadTenantExportFunction,
  readTenantExport,
  type StoredEvent,
  TENANT_EXPORT_FORMAT,
  TENANT_EXPORT_VERSION,
  type TenantExportAccess,
  type TenantExportCategory,
  type TenantExportCounts,
  type TenantExportedAnswer,
  type TenantExportedDeadLetter,
  type TenantExportedEvent,
  type TenantExportedPerson,
  type TenantExportedRow,
  type TenantExportedScheduledCommand,
  type TenantExportedSubscriberFailure,
  type TenantExportHeader,
  type TenantExportJsonLinesFunction,
  type TenantExportPart,
  type TenantExportReached,
  type TenantExportRecipient,
  tenantExportJsonLines,
} from "@bounda-dev/core";
import type {
  DeadLetterStore,
  DispatchOutcome,
  EventStore,
  ForgetLedgerEntry,
  LoadManyArgs,
  PersonalKeyStore,
  PersonStore,
  ScanArgs,
  ScheduledCommand,
  Scheduler,
  StoredDeadLetter,
  StoredPerson,
} from "@bounda-dev/core/adapter";
import { describe, expectTypeOf, it } from "vitest";

describe("the tenant export", () => {
  it("is a call of every client, streamed, a part at a time", () => {
    expectTypeOf<BoundaClient["exportTenant"]>().toEqualTypeOf<
      (tenant: string) => Promise<AsyncIterable<TenantExportPart>>
    >();
    expectTypeOf<BoundaApp["exportTenant"]>().toEqualTypeOf<BoundaClient["exportTenant"]>();
  });

  it("names its format and version as literals a reader checks", () => {
    expectTypeOf(TENANT_EXPORT_FORMAT).toEqualTypeOf<"bounda.tenant-export">();
    expectTypeOf(TENANT_EXPORT_VERSION).toEqualTypeOf<5>();
    expectTypeOf<TenantExportHeader>().toEqualTypeOf<{
      readonly format: "bounda.tenant-export";
      readonly version: 5;
      readonly tenant: string;
      readonly exportId: string;
      readonly exportedAt: string;
      readonly position: number;
      readonly frozenAt: string;
      readonly reached: TenantExportReached;
      readonly categories: Readonly<Record<string, TenantExportCategory>>;
      readonly transfers: readonly ExportedTransfer[];
      readonly readModels: readonly string[];
    }>();
    expectTypeOf<TenantExportReached>().toEqualTypeOf<{
      readonly readModels: Readonly<Record<string, number>>;
      readonly forgetLedger: number | null;
    }>();
    expectTypeOf<Omit<TenantExportCategory, "ports">>().toEqualTypeOf<
      Omit<ExportedCategory, "held" | "keptUntil" | "restrictedUntil">
    >();
    expectTypeOf<TenantExportCategory["ports"]>().toEqualTypeOf<readonly string[]>();
  });

  it("hands out parts of each kind, the header first and the end last", () => {
    expectTypeOf<TenantExportPart["kind"]>().toEqualTypeOf<
      | "header"
      | "person"
      | "recipient"
      | "event"
      | "scheduledCommand"
      | "deadLetter"
      | "subscriberFailure"
      | "answer"
      | "row"
      | "forgetLedgerEntry"
      | "end"
    >();
    expectTypeOf<
      Extract<TenantExportPart, { kind: "header" }>["header"]
    >().toEqualTypeOf<TenantExportHeader>();
    expectTypeOf<
      Extract<TenantExportPart, { kind: "person" }>["person"]
    >().toEqualTypeOf<TenantExportedPerson>();
    expectTypeOf<
      Extract<TenantExportPart, { kind: "recipient" }>["recipient"]
    >().toEqualTypeOf<TenantExportRecipient>();
    expectTypeOf<
      Extract<TenantExportPart, { kind: "event" }>["event"]
    >().toEqualTypeOf<TenantExportedEvent>();
    expectTypeOf<
      Extract<TenantExportPart, { kind: "scheduledCommand" }>["scheduledCommand"]
    >().toEqualTypeOf<TenantExportedScheduledCommand>();
    expectTypeOf<
      Extract<TenantExportPart, { kind: "deadLetter" }>["deadLetter"]
    >().toEqualTypeOf<TenantExportedDeadLetter>();
    expectTypeOf<
      Extract<TenantExportPart, { kind: "subscriberFailure" }>["subscriberFailure"]
    >().toEqualTypeOf<TenantExportedSubscriberFailure>();
    expectTypeOf<
      Extract<TenantExportPart, { kind: "answer" }>["answer"]
    >().toEqualTypeOf<TenantExportedAnswer>();
    expectTypeOf<Extract<TenantExportPart, { kind: "row" }>>().toEqualTypeOf<{
      readonly kind: "row";
      readonly readModel: string;
      readonly row: TenantExportedRow;
    }>();
    expectTypeOf<
      Extract<TenantExportPart, { kind: "forgetLedgerEntry" }>["entry"]
    >().toEqualTypeOf<ForgetLedgerEntry>();
    expectTypeOf<
      Extract<TenantExportPart, { kind: "end" }>["counts"]
    >().toEqualTypeOf<TenantExportCounts>();
  });

  it("types each record with every value opened", () => {
    expectTypeOf<TenantExportedPerson>().toEqualTypeOf<{
      readonly personId: string;
      readonly lastActiveAt: string | null;
      readonly forgottenAt: string | null;
      readonly categories: Readonly<
        Record<string, Pick<ExportedCategory, "keptUntil" | "restrictedUntil">>
      >;
      readonly restrictions: readonly ProcessingRestriction[];
      readonly recipients: readonly PersonRecipient[];
    }>();
    expectTypeOf<Omit<TenantExportRecipient, "persons">>().toEqualTypeOf<
      Omit<PersonRecipient, never>
    >();
    expectTypeOf<TenantExportRecipient>().toExtend<PersonRecipient>();
    expectTypeOf<TenantExportRecipient["persons"]>().toEqualTypeOf<number>();
    expectTypeOf<TenantExportedEvent>().toEqualTypeOf<{
      readonly id: string;
      readonly type: string;
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly version: number;
      readonly position: number;
      readonly timestamp: string;
      readonly metadata: EventMetadata;
      readonly person: string | null;
      readonly payload: unknown;
      readonly categories: ExportedCategories;
      readonly restricted: ExportedRestricted;
      readonly redacted: readonly string[];
    }>();
    expectTypeOf<TenantExportedScheduledCommand>().toEqualTypeOf<{
      readonly dedupeKey: string;
      readonly type: string;
      readonly aggregateId: string;
      readonly payload: unknown;
      readonly executeAt: string;
      readonly scheduledAt?: string;
      readonly context: CausationContext;
      readonly attempts: number;
      readonly persons: readonly string[];
      readonly categories: ExportedCategories;
      readonly restricted: ExportedRestricted;
    }>();
    expectTypeOf<TenantExportedDeadLetter["kind"]>().toEqualTypeOf<DeadLetterKind>();
    expectTypeOf<TenantExportedDeadLetter["status"]>().toEqualTypeOf<DeadLetterStatus>();
    expectTypeOf<TenantExportedDeadLetter["errorMessage"]>().toEqualTypeOf<string | null>();
    expectTypeOf<TenantExportedDeadLetter["errorStack"]>().toEqualTypeOf<
      string | null | undefined
    >();
    expectTypeOf<TenantExportedDeadLetter["payload"]>().toEqualTypeOf<unknown>();
    expectTypeOf<TenantExportedDeadLetter["persons"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<TenantExportedSubscriberFailure["errorMessage"]>().toEqualTypeOf<string | null>();
    expectTypeOf<TenantExportedSubscriberFailure["resolvedAt"]>().toEqualTypeOf<string | null>();
    expectTypeOf<
      TenantExportedSubscriberFailure["restricted"]
    >().toEqualTypeOf<ExportedRestricted>();
    expectTypeOf<TenantExportedAnswer>().toEqualTypeOf<{
      readonly idempotencyKey: string;
      readonly expiresAt: string;
      readonly outcome: DispatchOutcome;
      readonly persons: readonly string[];
      readonly restricted: ExportedRestricted;
    }>();
    expectTypeOf<TenantExportedRow>().toEqualTypeOf<{
      readonly key: unknown;
      readonly data: Readonly<Record<string, unknown>>;
      readonly person: string | null;
      readonly categories: ExportedCategories;
      readonly restricted: ExportedRestricted;
    }>();
  });

  it("counts what it handed out, as the access log records it", () => {
    expectTypeOf<TenantExportCounts>().toEqualTypeOf<{
      readonly persons: number;
      readonly recipients: number;
      readonly events: number;
      readonly scheduledCommands: number;
      readonly deadLetters: number;
      readonly subscriberFailures: number;
      readonly answers: number;
      readonly readModelRows: number;
      readonly forgetLedgerEntries: number;
    }>();
    expectTypeOf<TenantExportAccess["operation"]>().toEqualTypeOf<"exportTenant">();
    expectTypeOf<TenantExportAccess["outcome"]>().toEqualTypeOf<ExportOutcome>();
    expectTypeOf<TenantExportAccess["detail"]>().toEqualTypeOf<{
      readonly exportId: string;
      readonly persons: number;
      readonly recipients: number;
      readonly events: number;
      readonly scheduledCommands: number;
      readonly deadLetters: number;
      readonly subscriberFailures: number;
      readonly answers: number;
      readonly readModelRows: number;
      readonly forgetLedgerEntries: number;
    }>();
    expectTypeOf<TenantExportAccess>().toExtend<PersonalDataAccess>();
    expectTypeOf<
      Extract<PersonalDataAccess, { operation: "exportTenant" }>
    >().toEqualTypeOf<TenantExportAccess>();
  });

  it("writes JSON Lines and reads them back, checked whole", () => {
    expectTypeOf(tenantExportJsonLines).toEqualTypeOf<TenantExportJsonLinesFunction>();
    expectTypeOf(tenantExportJsonLines)
      .parameter(0)
      .toEqualTypeOf<AsyncIterable<TenantExportPart>>();
    expectTypeOf(tenantExportJsonLines).returns.toEqualTypeOf<ReadableStream<Uint8Array>>();
    expectTypeOf(readTenantExport).toEqualTypeOf<ReadTenantExportFunction>();
    expectTypeOf(readTenantExport)
      .parameter(0)
      .toEqualTypeOf<AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>>();
    expectTypeOf(readTenantExport).returns.toEqualTypeOf<
      AsyncGenerator<TenantExportPart, void, undefined>
    >();
  });

  it("pages every store an adapter brings by a key no write changes", () => {
    expectTypeOf<ScanArgs>().toEqualTypeOf<{
      readonly after?: string | undefined;
      readonly limit: number;
    }>();
    expectTypeOf<Scheduler["scan"]>().toEqualTypeOf<
      (args: ScanArgs) => Promise<readonly ScheduledCommand[]>
    >();
    expectTypeOf<DeadLetterStore["scan"]>().toEqualTypeOf<
      (args: ScanArgs) => Promise<readonly StoredDeadLetter[]>
    >();
    expectTypeOf<PersonStore["scan"]>().toEqualTypeOf<
      (args: ScanArgs) => Promise<readonly StoredPerson[]>
    >();
    expectTypeOf<PersonalKeyStore["persons"]>().toEqualTypeOf<
      (args: ScanArgs) => Promise<readonly string[]>
    >();
  });

  it("reads what a page of persons' recipients are presumed to hold from the event store at once", () => {
    expectTypeOf<EventStore["firstPositions"]>().toEqualTypeOf<
      (persons: readonly string[]) => Promise<ReadonlyMap<string, number>>
    >();
    expectTypeOf<LoadManyArgs>().toEqualTypeOf<{
      readonly aggregateType: string;
      readonly aggregateIds: readonly string[];
    }>();
    expectTypeOf<EventStore["loadMany"]>().toEqualTypeOf<
      (args: LoadManyArgs) => Promise<ReadonlyMap<string, readonly StoredEvent[]>>
    >();
  });
});
