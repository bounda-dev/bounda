import type { Clock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";
import {
  type AccessOutcome,
  MAX_ACCESS_PERSONS,
  type OnPersonalDataAccess,
  type PersonalDataAccess,
} from "../../modules/audit.ts";
import type { AppEnv } from "../../register/index.ts";

export const PERSONAL_DATA_ACCESSED = "personal data accessed";

type Operation = PersonalDataAccess["operation"];

export interface RecordAccessArgs<Op extends Operation> {
  readonly operation: Op;
  readonly detail: (PersonalDataAccess & { readonly operation: Op })["detail"];
  readonly actor: string | undefined;
  readonly persons: Iterable<string>;
  readonly outcome: AccessOutcome;
  /**
   * For a query only; any other record leaves it out.
   */
  readonly unattributed?: boolean;
}

/**
 * Records one access; rejects with what the app's hook throws.
 */
export interface RecordAccess {
  <Op extends Operation>(args: RecordAccessArgs<Op>): Promise<void>;
}

export interface CreateAccessLogArgs {
  readonly hook: OnPersonalDataAccess | undefined;
  readonly env: AppEnv;
  readonly tenant: string | undefined;
  readonly logger: Logger;
  readonly clock: Clock;
}

export interface CreateAccessLogFunction {
  (args: CreateAccessLogArgs): RecordAccess;
}

export const createAccessLog: CreateAccessLogFunction = ({ hook, env, tenant, logger, clock }) => {
  const recordAccess = async <Op extends Operation>({
    operation,
    detail,
    actor,
    persons,
    outcome,
    unattributed = false,
  }: RecordAccessArgs<Op>): Promise<void> => {
    const distinct = [...new Set(persons)];
    const access = {
      operation,
      actor: actor ?? null,
      persons: distinct.slice(0, MAX_ACCESS_PERSONS),
      personCount: distinct.length,
      at: clock.now().toISOString(),
      outcome,
      ...(operation === "query" ? { unattributed } : {}),
      detail,
    } as PersonalDataAccess;
    if (hook === undefined) {
      logger.info(PERSONAL_DATA_ACCESSED, { ...access });
      return;
    }
    await hook({ access, env, ...(tenant === undefined ? {} : { tenant }), logger });
  };
  return recordAccess;
};

export interface RecordedFunction {
  <Result>(
    record: (outcome: AccessOutcome) => Promise<void>,
    run: () => Promise<Result>,
  ): Promise<Result>;
}

/**
 * Runs what reads personal data and records it however it settles. A failure is recorded before
 * its error is thrown on, since the error may quote what was read; a record that fails rejects in
 * its place, so neither the result nor that error goes out unrecorded.
 */
export const recorded: RecordedFunction = async (record, run) => {
  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run();
  } catch (error) {
    await record("failed");
    throw error;
  }
  await record("ok");
  return result;
};
