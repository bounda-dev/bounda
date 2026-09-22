import type { EventNotifier } from "@bounda-dev/core/adapter";
import type { Sql } from "postgres";

export interface CreatePostgresqlEventNotifierArgs {
  readonly sql: Sql;
  /**
   * The `NOTIFY` channel the event store publishes on.
   */
  readonly channel: string;
}

export interface CreatePostgresqlEventNotifierFunction {
  (args: CreatePostgresqlEventNotifierArgs): EventNotifier;
}

/**
 * `LISTEN` on the channel the event store notifies after every committed append. Postgres.js
 * holds a dedicated connection for it and re-listens on its own after a reconnect; a
 * notification lost in between is covered by the dispatcher's idle poll. The payload is the
 * global position of the last event appended.
 */
export const createPostgresqlEventNotifier: CreatePostgresqlEventNotifierFunction = ({
  sql,
  channel,
}) => ({
  subscribe: async (listener) => {
    const { unlisten } = await sql.listen(channel, (payload) => {
      const position = Number(payload);
      listener(Number.isFinite(position) ? position : undefined);
    });
    return () => unlisten();
  },
});
