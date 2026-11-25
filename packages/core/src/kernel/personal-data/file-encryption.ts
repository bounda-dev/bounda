import type { FileEncryptionState } from "../../adapter/storage/encrypted-file.ts";
import type { ResolvedConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { Logger } from "../../contracts/logger.ts";
import { runtimeText } from "../shared/runtime-text.ts";
import { databasesOf, type EncryptedFileStatus } from "../status.ts";

/**
 * How often the worker tries again to encrypt a file left in the clear, or under an earlier key,
 * while another connection had it open.
 */
export const FILE_ENCRYPTION_RETRY_MS = 60_000;

export interface FileEncryptions {
  status(): readonly EncryptedFileStatus[];
  /**
   * Reads again the key in force of every file, as a rotation of the tenant's key changes it, and
   * encrypts under it the files that are not yet, at most once every `FILE_ENCRYPTION_RETRY_MS`.
   */
  settle(): Promise<void>;
  /**
   * Reads again the key in force of every file now, after this instance rotated the tenant's key:
   * the next `settle` moves them under it.
   */
  refresh(): Promise<void>;
  /**
   * Encrypts the files left in the clear, and throws while one still is: forgetting the tenant
   * would leave it readable.
   */
  refuseClear(): Promise<void>;
}

export interface CreateFileEncryptionsArgs {
  readonly config: ResolvedConfig;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface CreateFileEncryptionsFunction {
  (args: CreateFileEncryptionsArgs): FileEncryptions;
}

export const createFileEncryptions: CreateFileEncryptionsFunction = ({ config, clock, logger }) => {
  const files = databasesOf(config).flatMap(({ database, adapter }) =>
    adapter.fileEncryption === undefined ? [] : [{ database, encryption: adapter.fileEncryption }],
  );
  let triedAt: number | null = null;
  const refreshAll = async (): Promise<void> => {
    for (const { encryption } of files) {
      try {
        await encryption.refresh();
      } catch (error) {
        logger.error("bounda could not read the key of a database file", {
          file: encryption.database,
          error,
        });
      }
    }
  };
  const settleOne = async (
    encryption: (typeof files)[number]["encryption"],
  ): Promise<FileEncryptionState> => {
    const state = await encryption.settle();
    if (state === "current") {
      logger.info("bounda encrypted a database file under its tenant's key in force", {
        file: encryption.database,
      });
    }
    return state;
  };
  // What fails, or finds the file still held, is logged and tried again later: the worker's pass
  // goes on.
  const settleQuietly = async (encryption: (typeof files)[number]["encryption"]): Promise<void> => {
    try {
      const state = await settleOne(encryption);
      if (state !== "current") {
        logger.warn(
          "bounda left a database file as it is for now: another connection has it open, so the worker tries again later",
          { file: encryption.database, state },
        );
      }
    } catch (error) {
      logger.error("bounda could not encrypt a database file under its tenant's key", {
        file: encryption.database,
        error,
      });
    }
  };
  return {
    status: () =>
      files.map(({ database, encryption }) => ({
        database,
        file: encryption.database,
        state: encryption.state(),
      })),
    settle: async () => {
      const now = clock.now().getTime();
      if (files.length === 0) return;
      if (triedAt !== null && now - triedAt < FILE_ENCRYPTION_RETRY_MS && now >= triedAt) return;
      triedAt = now;
      await refreshAll();
      for (const { encryption } of files) {
        if (encryption.state() !== "current") await settleQuietly(encryption);
      }
    },
    refresh: async () => {
      await refreshAll();
      triedAt = null;
    },
    refuseClear: async () => {
      for (const { encryption } of files) {
        if (encryption.state() !== "clear") continue;
        if ((await settleOne(encryption)) === "clear") {
          throw runtimeText(
            new ConfigurationError(
              `The database file ${encryption.database} is still in the clear, so forgetting the tenant would leave it readable: stop every other connection to it, run bounda rekey, then forget the tenant again`,
            ),
          );
        }
      }
    },
  };
};
