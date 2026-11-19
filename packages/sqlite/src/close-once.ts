import { createRequire } from "node:module";

interface NativeDatabase {
  readonly db: unknown;
  readonly open: boolean;
  prepare(sql: string): unknown;
  exec(sql: string): unknown;
  close(): void;
}

interface NativeDatabaseModule {
  readonly prototype: NativeDatabase;
}

export interface CloseConnectionsOnceFunction {
  (): void;
}

// Where a closed database keeps the statement that holds its connection.
export const CONNECTION_HOLDER = Symbol("bounda.connectionHolder");

let patched = false;

// libSQL's native module closes a connection twice when its own handle is the last thing holding
// it (tursodatabase/libsql#2251, fixed in crate 0.10, which no npm `libsql` 0.5 is built from yet:
// drop this once one is), whether the database is closed, collected unclosed, or left open when the
// process exits, which collects every handle left. The second close reads freed memory, which on
// Windows ends the process with an access violation. A statement still holding the connection
// turns the native close into a letting go, and the connection is closed once, when that statement
// is collected. A database dropped without a close is closed that way before its handle can be
// collected: the registry keeps the handle until then, and the process closes those left as it
// exits, since the registry's callbacks no longer run then. Patches the copy of the module
// @libsql/client loads; if that copy cannot be found, say in a bundle, the adapter works as before
// rather than failing.
export const closeConnectionsOnce: CloseConnectionsOnceFunction = () => {
  if (patched) return;
  patched = true;
  let prototype: NativeDatabase;
  try {
    const client = createRequire(import.meta.url).resolve("@libsql/client");
    ({ prototype } = createRequire(client)("libsql") as NativeDatabaseModule);
  } catch {
    return;
  }
  const { prepare, exec, close } = prototype;
  const closeHolding = (database: NativeDatabase): void => {
    try {
      if (database.open)
        Reflect.set(database, CONNECTION_HOLDER, prepare.call(database, "SELECT 1"));
    } finally {
      close.call(database);
    }
  };
  // The connections not closed yet, by handle, with their database until it is collected.
  const unclosed = new Map<unknown, WeakRef<NativeDatabase>>();
  const closeHandle = (db: unknown): void => {
    unclosed.delete(db);
    closeHolding({ db, open: true } as NativeDatabase);
  };
  const abandoned = new FinalizationRegistry<unknown>(closeHandle);
  // A database still held is closed itself, so it says so to whatever closes it after.
  process.once("exit", () => {
    for (const [db, held] of unclosed) {
      try {
        const database = held.deref();
        if (database === undefined) closeHandle(db);
        else database.close();
      } catch {
        // The process ends either way: the others are still closed.
      }
    }
  });
  const tracked = new WeakSet<NativeDatabase>();
  const track = (database: NativeDatabase): void => {
    if (tracked.has(database) || !database.open) return;
    tracked.add(database);
    unclosed.set(database.db, new WeakRef(database));
    abandoned.register(database, database.db, database);
  };
  prototype.prepare = function (this: NativeDatabase, sql: string): unknown {
    track(this);
    return prepare.call(this, sql);
  };
  prototype.exec = function (this: NativeDatabase, sql: string): unknown {
    track(this);
    return exec.call(this, sql);
  };
  prototype.close = function (this: NativeDatabase): void {
    abandoned.unregister(this);
    unclosed.delete(this.db);
    closeHolding(this);
  };
};
