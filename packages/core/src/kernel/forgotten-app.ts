import type { TenantForgetting } from "../adapter/storage/tenant-key-store.ts";
import type { ErrorText, ResolvedConfig } from "../config/types.ts";
import type { Clock } from "../contracts/clock.ts";
import {
  DeadLetterNotRetriableError,
  type TenantForgottenError,
  ValidationError,
} from "../contracts/errors.ts";
import type { IdGenerator } from "../contracts/ids.ts";
import type { Logger } from "../contracts/logger.ts";
import { checkActor } from "../contracts/metadata.ts";
import type { CommandsFacade, QueriesFacade, Registry } from "../modules/registry.ts";
import type { AppLag, BoundaApp, BoundaClient } from "./app.ts";
import { createDeadLetters, type DeadLetters } from "./dead-letters/dead-letters.ts";
import { createRecipientLetterRetry } from "./dead-letters/retry.ts";
import { createDispatcher } from "./dispatch/dispatcher.ts";
import type { SubscriberFailures } from "./dispatch/subscriber-failures.ts";
import type { AppStorage } from "./events/app-event-store.ts";
import type { GlobalStream } from "./events/global-stream.ts";
import type { RecordAccess } from "./personal-data/access.ts";
import { createTenantNoticeSubscriber, rejecting } from "./personal-data/forgotten-tenant.ts";
import type { TenantKeys } from "./personal-data/tenant-keys.ts";
import type { RecipientDelivery, RecipientNotices } from "./recipients/notices.ts";
import type { PendingRetries } from "./shared/pending-retries.ts";
import type { RestoreWatch } from "./shared/restores.ts";
import { runtimeText } from "./shared/runtime-text.ts";
import { type AppStatus, readAppStatus } from "./status.ts";
import type { TracerFunction } from "./telemetry.ts";

/**
 * What an app whose tenant was forgotten still runs: the notices to the recipients of the tenant's
 * data, through their own claims, retries and dead letters, and what reports on them.
 */
export interface ForgottenRunner {
  start(): void;
  stop(): Promise<void>;
  runUntilIdle(maxPasses: number): Promise<boolean>;
  nextDueAt(): Promise<Date | null>;
  getLag(): Promise<AppLag>;
  status(): Promise<AppStatus>;
  deadLetters(actor: string | undefined): DeadLetters;
}

export interface CreateForgottenRunnerArgs {
  readonly storage: AppStorage;
  readonly config: ResolvedConfig;
  readonly notices: RecipientNotices;
  readonly delivery: RecipientDelivery;
  readonly recordAccess: RecordAccess;
  readonly restores: RestoreWatch;
  readonly tenantKeys: Pick<TenantKeys, "status">;
  readonly forgotten: () => TenantForgottenError;
  /**
   * Settles the forgetting again in a database restored under the app.
   */
  readonly resettle: () => Promise<void>;
  /**
   * Runs once every recipient was told of the forgetting, its notices delivered or their dead
   * letters resolved: what the database still held for them can go.
   */
  readonly discharge: () => Promise<void>;
  readonly pendingRetries: PendingRetries;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly errorText: ErrorText;
  readonly tracer: TracerFunction;
}

export interface CreateForgottenRunnerFunction {
  (args: CreateForgottenRunnerArgs): ForgottenRunner;
}

export const createForgottenRunner: CreateForgottenRunnerFunction = ({
  storage,
  config,
  notices,
  delivery,
  recordAccess,
  restores,
  tenantKeys,
  forgotten,
  resettle,
  discharge,
  pendingRetries,
  ids,
  clock,
  logger,
  errorText,
  tracer,
}) => {
  let discharged = false;
  const dischargeOnceTold = async (): Promise<void> => {
    if (discharged) return;
    if ((await dispatcher.getLag()).maxLag > 0) return;
    if ((await storage.deadLetterStore.count({ kind: "recipient", status: "failed" })) > 0) return;
    // Every notice of the forgetting delivered or settled: its letters serve nobody any longer.
    await storage.deadLetterStore.clear();
    await discharge();
    discharged = true;
  };
  const dispatcher = createDispatcher({
    eventStore: storage.eventStore,
    checkpointStore: storage.checkpointStore,
    subscribers: [createTenantNoticeSubscriber({ delivery })],
    batchSize: config.runtime.dispatcher.batchSize,
    pollIntervalMs: config.runtime.dispatcher.pollIntervalMs,
    backoff: config.runtime.dispatcher.backoff,
    catchUp: config.runtime.dispatcher.catchUp,
    idleIntervalMs: config.runtime.dispatcher.idleIntervalMs,
    ...(storage.notifier === undefined ? {} : { notifier: storage.notifier }),
    // A copy restored under the app lacks what the forgetting removed: it is settled again first.
    beforePass: async () => {
      if ((await restores.check(clock.now())) !== null) await resettle();
      await dischargeOnceTold();
    },
    clock,
    logger,
    errorText,
    tracer,
  });
  const retries = createRecipientLetterRetry({ storage, notices, config, ids, clock });
  const getLag = async (): Promise<AppLag> => ({
    ...(await dispatcher.standings()),
    waitingDeadlines: 0,
    forgetLedger: null,
    personalDataBackfill: null,
  });
  return {
    start: () => {
      if (config.runtime.role !== "web") dispatcher.start();
    },
    stop: () => dispatcher.stop(),
    runUntilIdle: async (maxPasses) => {
      for (let round = 0; round < maxPasses; round += 1) {
        pendingRetries.startRound();
        if (await dispatcher.processOnce()) continue;
        if (
          !(await pendingRetries.skipToNext(
            async () => null,
            async () => null,
          ))
        ) {
          await dischargeOnceTold();
          return true;
        }
      }
      return false;
    },
    nextDueAt: async () => null,
    getLag,
    status: () =>
      readAppStatus({
        config,
        logger,
        lag: async () => ({
          ...(await dispatcher.standings()),
          waitingDeadlines: 0,
          forgetLedger: null,
        }),
        failures: storage.subscriberFailures,
        restores,
        tenant: () => tenantKeys.status(),
      }),
    deadLetters: (actor) =>
      createDeadLetters({
        storage,
        retries,
        processes: {
          parkedBehind: async () => 0,
          stillParked: async () => 0,
          abandon: async ({ letter }) => {
            throw new DeadLetterNotRetriableError(
              `Dead letter "${letter.id}" is a process's, and the tenant was forgotten: ${forgotten().message}`,
            );
          },
        },
        clock,
        logger,
        errorText,
        tracer,
        actor,
        recordAccess,
      }),
  };
};

export interface ForgottenAppArgs {
  readonly config: ResolvedConfig;
  readonly role: ResolvedConfig["runtime"]["role"];
  readonly runner: ForgottenRunner;
  readonly forgotten: () => TenantForgottenError;
  readonly forgetting: TenantForgetting;
  readonly tenant: string;
  /**
   * Closes everything the start opened.
   */
  readonly close: () => Promise<void>;
}

/**
 * An app started for a tenant forgotten already: every call rejects with `TenantForgottenError`
 * but the lag, the status, the dead letters, and `forgetTenant`, which resolves to the forgetting
 * as it was; its background work tells the recipients of the tenant's data.
 */
export const forgottenApp = <R extends Registry>({
  config,
  role,
  runner,
  forgotten,
  forgetting,
  tenant,
  close,
}: ForgottenAppArgs): BoundaApp<R> => {
  const reject = async (): Promise<never> => {
    throw forgotten();
  };
  const clientOf = (
    actor: string | undefined,
  ): BoundaClient<R> & {
    readonly deadLetters: DeadLetters;
  } => ({
    commands: rejecting(forgotten) as CommandsFacade<R>,
    queries: rejecting(forgotten) as QueriesFacade<R>,
    getLag: () => runner.getLag(),
    status: () => runner.status(),
    subscriberFailures: rejecting(forgotten) as SubscriberFailures,
    events: rejecting(forgotten) as GlobalStream,
    deadLetters: runner.deadLetters(actor),
    rebuildReadModel: reject,
    forget: reject,
    exportPersonalData: reject,
    streamPersonalData: reject,
    recipientsOf: reject,
    restrict: reject,
    unrestrict: reject,
    redact: reject,
    forgetTenant: async (name) => {
      if (name !== tenant) {
        throw runtimeText(
          new ValidationError(`forgetTenant names tenant ${name}, and the app serves another`, [
            { path: ["tenant"], message: "Expected the tenant the app serves" },
          ]),
        );
      }
      return { tenant, forgottenAt: forgetting.at, eventId: forgetting.eventId };
    },
    exportTenant: reject,
    rotateTenantKey: reject,
    retireTenantKeys: reject,
    as: (next) => {
      checkActor(next);
      return clientOf(next);
    },
  });
  let stopping: Promise<void> | undefined;
  return {
    ...clientOf(undefined),
    config,
    role,
    start: () => {
      if (stopping === undefined) runner.start();
    },
    stop: () => {
      stopping ??= (async () => {
        try {
          await runner.stop();
        } finally {
          await close();
        }
      })();
      return stopping;
    },
    runUntilIdle: async ({ maxPasses = Number.POSITIVE_INFINITY } = {}) => ({
      idle: await runner.runUntilIdle(maxPasses),
      rejections: [],
    }),
    nextDueAt: () => runner.nextDueAt(),
    catchUpReadModels: async () => undefined,
    rebuildReadModel: reject,
    pendingRebuilds: async () => [],
    forgetAgain: reject,
    restored: reject,
  };
};
