import { createRequire } from "node:module";
import { join } from "node:path";

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

export interface LibsqlNativeFromFunction {
  (from: string): LibsqlNativeFunction;
}

export interface WhereCodeRunsFunction {
  (url: string | undefined): string;
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

// The code of the warning given when libSQL's native module is out of reach.
export const LIBSQL_NATIVE_MISSING = "BOUNDA_LIBSQL_NATIVE_MISSING";

const WITHOUT_IT =
  "Without it, a libSQL connection closed, collected or left open at exit can be closed twice, which on Windows ends the process with an access violation; and an encrypted file's keys are tried by opening the file under each, so one that does not open it can keep the file from being encrypted until garbage is collected. Leave @libsql/client and libsql out of the bundle, or install libsql at the version @libsql/client depends on.";

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type Lookup = { readonly module: NativeDatabaseModule } | { readonly missing: string };

// `libsql` as @libsql/client resolves it, then as code at `from` does, for a bundle that took the
// client in and left `libsql` out. Of the two, a copy already loaded is the one the client uses.
const lookUp = (from: string): Lookup => {
  let require: NodeJS.Require;
  try {
    require = createRequire(from);
  } catch (error) {
    return { missing: `cannot look modules up from ${from}: ${reasonOf(error)}` };
  }
  const paths = [
    () => createRequire(require.resolve("@libsql/client")).resolve("libsql"),
    () => require.resolve("libsql"),
  ].flatMap((resolve) => {
    try {
      return [resolve()];
    } catch {
      return [];
    }
  });
  const path = paths.find((candidate) => candidate in require.cache) ?? paths[0];
  if (path === undefined) {
    return { missing: "found it neither beside @libsql/client nor on its own" };
  }
  try {
    return { module: require(path) as NativeDatabaseModule };
  } catch (error) {
    return { missing: `could not load it from ${path}: ${reasonOf(error)}` };
  }
};

// libSQL's native module as code at `from` finds it, looked up on the first call and kept; `null`,
// with one warning, when it is out of reach.
export const libsqlNativeFrom: LibsqlNativeFromFunction = (from) => {
  let native: NativeDatabaseModule | null | undefined;
  return () => {
    if (native !== undefined) return native;
    const found = lookUp(from);
    if ("module" in found) {
      native = found.module;
    } else {
      native = null;
      process.emitWarning(
        `@bounda-dev/sqlite cannot reach libSQL's native module, libsql: it ${found.missing}. ${WITHOUT_IT}`,
        { code: LIBSQL_NATIVE_MISSING },
      );
    }
    return native;
  };
};

// Where code whose `import.meta.url` is `url` looks modules up from. A bundle emitted as CommonJS has
// none: its code finds them as the script the process runs does, or, with no script, as the
// working directory does.
export const whereCodeRuns: WhereCodeRunsFunction = (url) =>
  url ?? process.argv[1] ?? join(process.cwd(), "index.js");

// The copy @libsql/client loads, as this package's code finds it.
export const libsqlNative: LibsqlNativeFunction = libsqlNativeFrom(whereCodeRuns(import.meta.url));

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
// @libsql/client loads; out of reach, `libsqlNative` warns and the adapter runs unpatched rather
// than failing.
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
