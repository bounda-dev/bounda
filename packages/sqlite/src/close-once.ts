import { createRequire } from "node:module";

export interface NativeStatement {
  get(): unknown;
}

export interface NativeDatabase {
  readonly db: unknown;
  readonly open: boolean;
  prepare(sql: string): NativeStatement;
  exec(sql: string): unknown;
  close(): void;
}

export interface NativeDatabaseModule {
  new (path: string, options: { readonly encryptionKey?: string }): NativeDatabase;
  readonly prototype: NativeDatabase;
}

export interface LibsqlNativeFunction {
  (): NativeDatabaseModule | null;
}

export interface CloseConnectionsOnceFunction {
  (): void;
}

export interface CloseConnectionsLeftOpenFunction {
  (): void;
}

// Where a closed database keeps the statement that holds its connection.
export const CONNECTION_HOLDER = Symbol("bounda.connectionHolder");

let patched = false;
let closeLeftOpen = (): void => undefined;

let native: NativeDatabaseModule | null | undefined;

// libSQL's native module, the copy @libsql/client loads; `null` where it cannot be found, say in a
// bundle.
export const libsqlNative: LibsqlNativeFunction = () => {
  if (native !== undefined) return native;
  try {
    const client = createRequire(import.meta.url).resolve("@libsql/client");
    native = createRequire(client)("libsql") as NativeDatabaseModule;
  } catch {
    native = null;
  }
  return native;
};

// Closes the connections still open, each once, as the patch does when the process exits.
export const closeConnectionsLeftOpen: CloseConnectionsLeftOpenFunction = () => closeLeftOpen();

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
  const module = libsqlNative();
  if (module === null) return;
  const { prototype } = module;
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
    if (unclosed.delete(db)) closeHolding({ db, open: true } as NativeDatabase);
  };
  const abandoned = new FinalizationRegistry<unknown>(closeHandle);
  // A database still held is closed itself, so it says so to whatever closes it after.
  closeLeftOpen = () => {
    for (const [db, held] of unclosed) {
      try {
        const database = held.deref();
        if (database === undefined) closeHandle(db);
        else database.close();
      } catch {
        // One that fails to close leaves the others to.
      }
    }
  };
  process.once("exit", closeConnectionsLeftOpen);
  const tracked = new WeakSet<NativeDatabase>();
  const track = (database: NativeDatabase): void => {
    if (tracked.has(database) || !database.open) return;
    tracked.add(database);
    unclosed.set(database.db, new WeakRef(database));
    abandoned.register(database, database.db, database);
  };
  prototype.prepare = function (this: NativeDatabase, sql: string): NativeStatement {
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
