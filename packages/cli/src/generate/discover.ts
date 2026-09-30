import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type {
  AggregateModel,
  CommandModel,
  EventModel,
  ImplementationModel,
  ModuleRef,
  PolicyModel,
  PortModel,
  ProcessDeadlineModel,
  ProcessHandlerModel,
  ProcessModel,
  ProjectionModel,
  ProjectModel,
  QueryModel,
  ReadModelModel,
} from "./model.ts";
import {
  isKebabCase,
  joinKeys,
  keyOf,
  policyTriggerOf,
  processDeadlineOf,
  processHandlerEventOf,
  typeNameOf,
} from "./naming.ts";
import { createProblemCollector, type ProblemCollector } from "./problems.ts";

export interface DiscoverProjectArgs {
  readonly root: string;
  /**
   * The application directory under `root`, which the configuration calls `rootDir`. Defaults to
   * `app`.
   */
  readonly appDir?: string;
}

export interface DiscoverProjectFunction {
  (args: DiscoverProjectArgs): Promise<ProjectModel>;
}

const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set(["+types", "node_modules"]);
const IGNORED_SUFFIXES: readonly string[] = [".test.ts", ".test-d.ts", ".d.ts"];
const DOMAIN = "domain";
const READ = "read";
const STATE = "state";
const VIEW = "view";
const INDEX = "index";
const RENAMED_TIMEOUT_HANDLER = "on-timeout";
const UPCAST_SUFFIX = ".upcast";

interface Listing {
  readonly directories: readonly string[];
  readonly modules: readonly string[];
  readonly others: readonly string[];
}

const isIgnored = (entry: Dirent): boolean =>
  entry.name.startsWith("_") ||
  entry.name.startsWith(".") ||
  (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) ||
  (entry.isFile() && IGNORED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)));

const list = async (directory: string): Promise<Listing> => {
  const entries = (await readdir(directory, { withFileTypes: true })).filter(
    (entry) => !isIgnored(entry),
  );
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  return {
    directories: sorted.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    modules: sorted
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name.slice(0, -".ts".length)),
    others: sorted
      .filter((entry) => entry.isFile() && !entry.name.endsWith(".ts"))
      .map((entry) => entry.name),
  };
};

const byKey = <T extends { readonly key: string }>(a: T, b: T): number =>
  a.key.localeCompare(b.key);

interface Context {
  readonly root: string;
  readonly problems: ProblemCollector;
  /**
   * The keys of every aggregate of the app: a folder named after one holds that aggregate's events.
   */
  readonly aggregates: ReadonlySet<string>;
}

const moduleRef = (context: Context, path: string): ModuleRef => ({
  path,
  relativePath: relative(context.root, path).split("\\").join("/"),
});

const checkName = (context: Context, path: string, name: string, what: string): boolean => {
  if (isKebabCase(name)) return true;
  context.problems.add(
    path,
    `${what} names must be kebab-case (lower-case letters, digits and dashes)`,
  );
  return false;
};

const rejectOthers = (context: Context, directory: string, listing: Listing): void => {
  for (const name of listing.others) {
    context.problems.add(join(directory, name), "only .ts modules are allowed here");
  }
};

const COLLABORATORS_HINT =
  "collaborators live at the aggregate root, one directory per port: <port>/index.ts with its interface and <port>/<implementation>.ts";

const rejectCollaboratorFile = (context: Context, path: string, name: string): boolean => {
  if (!name.includes(".")) return false;
  context.problems.add(path, COLLABORATORS_HINT);
  return true;
};

const discoverCommands = async (
  context: Context,
  directory: string,
): Promise<readonly CommandModel[]> => {
  const listing = await list(directory);
  rejectOthers(context, directory, listing);
  for (const name of listing.directories) {
    context.problems.add(join(directory, name), `a command is a file; ${COLLABORATORS_HINT}`);
  }
  const commands: CommandModel[] = [];
  for (const name of listing.modules) {
    const path = join(directory, `${name}.ts`);
    if (rejectCollaboratorFile(context, path, name)) continue;
    if (!checkName(context, path, name, "Command")) continue;
    commands.push({
      ...moduleRef(context, path),
      key: keyOf(name),
      typeName: typeNameOf(keyOf(name)),
    });
  }
  return commands.sort(byKey);
};

interface PolicyFolder {
  readonly aggregate: string;
  /**
   * The aggregate whose events the folder's policies react to: the owner for `policies/`, the
   * folder's aggregate for `policies/<aggregate>/`.
   */
  readonly source: string;
}

const discoverPolicyModules = (
  context: Context,
  directory: string,
  listing: Listing,
  names: readonly string[],
  folder: PolicyFolder,
): readonly PolicyModel[] => {
  const foreign = folder.source !== folder.aggregate;
  for (const name of names) {
    context.problems.add(join(directory, name), `a policy is a file; ${COLLABORATORS_HINT}`);
  }
  const policies: PolicyModel[] = [];
  for (const name of listing.modules) {
    const path = join(directory, `${name}.ts`);
    if (rejectCollaboratorFile(context, path, name)) continue;
    if (!checkName(context, path, name, "Policy")) continue;
    policies.push({
      ...moduleRef(context, path),
      key: foreign ? joinKeys(folder.source, keyOf(name)) : keyOf(name),
      triggerKey: policyTriggerOf(name),
      source: foreign ? folder.source : null,
    });
  }
  return policies;
};

const discoverPolicies = async (
  context: Context,
  directory: string,
  aggregate: string,
): Promise<readonly PolicyModel[]> => {
  const listing = await list(directory);
  rejectOthers(context, directory, listing);
  const isAggregate = (name: string): boolean => context.aggregates.has(keyOf(name));
  const policies = [
    ...discoverPolicyModules(
      context,
      directory,
      listing,
      listing.directories.filter((name) => !isAggregate(name)),
      { aggregate, source: aggregate },
    ),
  ];
  for (const name of listing.directories.filter(isAggregate)) {
    const folder = join(directory, name);
    if (keyOf(name) === aggregate) {
      context.problems.add(
        folder,
        `these are ${aggregate}'s own policies; put them in policies/ directly`,
      );
      continue;
    }
    const inner = await list(folder);
    rejectOthers(context, folder, inner);
    if (inner.modules.includes(INDEX)) {
      context.problems.add(
        join(folder, `${INDEX}.ts`),
        `"${keyOf(name)}" is an aggregate, so policies/${name}/ holds policies for its events; name the policy differently`,
      );
    }
    for (const child of inner.directories.filter(isAggregate)) {
      context.problems.add(
        join(folder, child),
        "a folder of another aggregate's policies holds policies, not more aggregates",
      );
    }
    policies.push(
      ...discoverPolicyModules(
        context,
        folder,
        inner,
        inner.directories.filter((child) => !isAggregate(child)),
        { aggregate, source: keyOf(name) },
      ),
    );
  }
  return policies.sort(byKey);
};

const discoverProcess = async (
  context: Context,
  directory: string,
  name: string,
  aggregate: string,
  eventKeys: ReadonlySet<string>,
): Promise<ProcessModel | null> => {
  const index = join(directory, `${INDEX}.ts`);
  if (!(await exists(index))) {
    context.problems.add(directory, "a process directory needs an index.ts with its config");
    return null;
  }
  const listing = await list(directory);
  rejectOthers(context, directory, listing);
  const handlers: ProcessHandlerModel[] = [];
  for (const child of listing.directories) {
    const folder = join(directory, child);
    if (!context.aggregates.has(keyOf(child)) || keyOf(child) === aggregate) {
      context.problems.add(
        folder,
        keyOf(child) === aggregate
          ? `these are ${aggregate}'s own events; put their handlers in the process directory`
          : "a process directory holds only index.ts, on-*.ts and at-*.ts handlers and folders named after other aggregates",
      );
      continue;
    }
    const inner = await list(folder);
    rejectOthers(context, folder, inner);
    for (const nested of inner.directories) {
      context.problems.add(
        join(folder, nested),
        "a folder of another aggregate's handlers holds only on-<event>.ts",
      );
    }
    for (const module of inner.modules) {
      const path = join(folder, `${module}.ts`);
      const eventKey = processHandlerEventOf(module);
      if (eventKey === null) {
        context.problems.add(path, "process handlers are named on-<event>.ts");
        continue;
      }
      handlers.push({ ...moduleRef(context, path), aggregate: keyOf(child), eventKey });
    }
  }
  const deadlines: ProcessDeadlineModel[] = [];
  for (const module of listing.modules) {
    if (module === INDEX) continue;
    const path = join(directory, `${module}.ts`);
    if (rejectCollaboratorFile(context, path, module)) continue;
    if (module === RENAMED_TIMEOUT_HANDLER && !eventKeys.has("timeout")) {
      context.problems.add(path, "the timeout handler is at-timeout.ts now; rename the file");
      continue;
    }
    const field = processDeadlineOf(module);
    if (field !== null) {
      deadlines.push({ ...moduleRef(context, path), field });
      continue;
    }
    const eventKey = processHandlerEventOf(module);
    if (eventKey === null) {
      context.problems.add(path, "process handlers are named on-<event>.ts or at-<deadline>.ts");
      continue;
    }
    if (!eventKeys.has(eventKey)) {
      context.problems.add(path, `"${eventKey}" is not an event of this aggregate`);
      continue;
    }
    handlers.push({ ...moduleRef(context, path), aggregate, eventKey });
  }
  return {
    ...moduleRef(context, index),
    key: keyOf(name),
    typeName: typeNameOf(keyOf(name)),
    directory,
    handlers: handlers.sort(
      (a, b) =>
        Number(a.aggregate !== aggregate) - Number(b.aggregate !== aggregate) ||
        a.aggregate.localeCompare(b.aggregate) ||
        a.eventKey.localeCompare(b.eventKey),
    ),
    deadlines,
  };
};

const discoverProcesses = async (
  context: Context,
  directory: string,
  aggregate: string,
  eventKeys: ReadonlySet<string>,
): Promise<readonly ProcessModel[]> => {
  const listing = await list(directory);
  rejectOthers(context, directory, listing);
  for (const name of listing.modules) {
    context.problems.add(
      join(directory, `${name}.ts`),
      "a process is a directory with an index.ts",
    );
  }
  const processes: ProcessModel[] = [];
  for (const name of listing.directories) {
    const processDirectory = join(directory, name);
    if (!checkName(context, processDirectory, name, "Process")) continue;
    const process = await discoverProcess(context, processDirectory, name, aggregate, eventKeys);
    if (process !== null) processes.push(process);
  }
  return processes.sort(byKey);
};

const AGGREGATE_DIRECTORIES: ReadonlySet<string> = new Set(["commands", "policies", "processes"]);

/**
 * Names a port cannot take: the state module and every argument a handler of any kind already
 * receives, since the ports are spread next to them. The three module directories never get here.
 */
const RESERVED_PORT_KEYS: ReadonlySet<string> = new Set([
  "state",
  "command",
  "events",
  "idempotencyKey",
  "event",
  "signal",
  "aggregateId",
  "after",
]);

const PORT_DECLARATION = (typeName: string): RegExp =>
  new RegExp(`^export\\s+(?:type|interface)\\s+${typeName}\\b`, "m");

const discoverPort = async (
  context: Context,
  directory: string,
  name: string,
  eventKeys: ReadonlySet<string>,
): Promise<PortModel | null> => {
  if (!checkName(context, directory, name, "Collaborator")) return null;
  const key = keyOf(name);
  const typeName = typeNameOf(key);
  if (RESERVED_PORT_KEYS.has(key)) {
    context.problems.add(directory, `"${key}" is reserved; give the collaborator another name`);
    return null;
  }
  if (eventKeys.has(key)) {
    context.problems.add(
      directory,
      `"${key}" is also an event of this aggregate; give the collaborator another name`,
    );
    return null;
  }
  const index = join(directory, `${INDEX}.ts`);
  if (!(await exists(index))) {
    context.problems.add(
      directory,
      `a collaborator directory needs an index.ts exporting its interface: export interface ${typeName}`,
    );
    return null;
  }
  if (!PORT_DECLARATION(typeName).test(await readFile(index, "utf8"))) {
    context.problems.add(
      index,
      `must export the collaborator's interface, named after the directory: export interface ${typeName}`,
    );
    return null;
  }
  const listing = await list(directory);
  rejectOthers(context, directory, listing);
  for (const child of listing.directories) {
    context.problems.add(
      join(directory, child),
      "a collaborator directory holds only index.ts and its implementations",
    );
  }
  const implementations: ImplementationModel[] = [];
  for (const module of listing.modules) {
    if (module === INDEX) continue;
    const path = join(directory, `${module}.ts`);
    if (!checkName(context, path, module, "Implementation")) continue;
    implementations.push({ ...moduleRef(context, path), name: module });
  }
  if (implementations.length === 0) {
    context.problems.add(
      directory,
      `a collaborator needs at least one implementation next to its index.ts: ${name}/<implementation>.ts`,
    );
    return null;
  }
  return { key, typeName, contract: moduleRef(context, index), implementations };
};

const discoverAggregate = async (
  context: Context,
  directory: string,
  name: string,
): Promise<AggregateModel> => {
  const listing = await list(directory);
  rejectOthers(context, directory, listing);
  const events: EventModel[] = [];
  const upcasts = new Map<string, ModuleRef>();
  let state: ModuleRef | null = null;
  for (const module of listing.modules) {
    const path = join(directory, `${module}.ts`);
    if (module === STATE) {
      state = moduleRef(context, path);
      continue;
    }
    if (module.endsWith(UPCAST_SUFFIX)) {
      const eventName = module.slice(0, -UPCAST_SUFFIX.length);
      if (!checkName(context, path, eventName, "Event")) continue;
      if (!listing.modules.includes(eventName)) {
        context.problems.add(path, `an upcast module needs the event ${eventName}.ts next to it`);
        continue;
      }
      upcasts.set(keyOf(eventName), moduleRef(context, path));
      continue;
    }
    if (!checkName(context, path, module, "Event")) continue;
    events.push({
      ...moduleRef(context, path),
      key: keyOf(module),
      typeName: typeNameOf(keyOf(module)),
      upcasts: null,
    });
  }
  const eventsWithUpcasts = events.map((event) => ({
    ...event,
    upcasts: upcasts.get(event.key) ?? null,
  }));
  const has = (child: string): boolean => listing.directories.includes(child);
  const eventKeys = new Set(events.map((event) => event.key));
  const collaborators: PortModel[] = [];
  for (const child of listing.directories) {
    if (AGGREGATE_DIRECTORIES.has(child)) continue;
    const port = await discoverPort(context, join(directory, child), child, eventKeys);
    if (port !== null) collaborators.push(port);
  }
  return {
    name,
    directory,
    state,
    events: eventsWithUpcasts.sort(byKey),
    collaborators: collaborators.sort(byKey),
    commands: has("commands") ? await discoverCommands(context, join(directory, "commands")) : [],
    policies: has("policies")
      ? await discoverPolicies(context, join(directory, "policies"), name)
      : [],
    processes: has("processes")
      ? await discoverProcesses(context, join(directory, "processes"), name, eventKeys)
      : [],
  };
};

const discoverProjections = async (
  context: Context,
  directory: string,
): Promise<readonly ProjectionModel[]> => {
  const listing = await list(directory);
  rejectOthers(context, directory, listing);
  for (const name of listing.modules) {
    context.problems.add(
      join(directory, `${name}.ts`),
      "a projection lives in a folder named after the aggregate whose event it projects: projections/<aggregate>/<event>.ts",
    );
  }
  const projections: ProjectionModel[] = [];
  for (const folder of listing.directories) {
    const folderPath = join(directory, folder);
    if (!context.aggregates.has(keyOf(folder))) {
      context.problems.add(folderPath, `"${keyOf(folder)}" is not an aggregate of the app`);
      continue;
    }
    const inner = await list(folderPath);
    rejectOthers(context, folderPath, inner);
    for (const name of inner.directories) {
      context.problems.add(
        join(folderPath, name),
        "projections are single modules; directories are not allowed here",
      );
    }
    for (const name of inner.modules) {
      const path = join(folderPath, `${name}.ts`);
      if (!checkName(context, path, name, "Projection")) continue;
      projections.push({
        ...moduleRef(context, path),
        aggregate: keyOf(folder),
        eventKey: keyOf(name),
      });
    }
  }
  return projections;
};

const discoverQueries = async (
  context: Context,
  directory: string,
): Promise<readonly QueryModel[]> => {
  const listing = await list(directory);
  rejectOthers(context, directory, listing);
  for (const name of listing.directories) {
    context.problems.add(
      join(directory, name),
      "queries are single modules; directories are not allowed here",
    );
  }
  return listing.modules
    .filter((name) => checkName(context, join(directory, `${name}.ts`), name, "Query"))
    .map((name) => ({
      ...moduleRef(context, join(directory, `${name}.ts`)),
      key: keyOf(name),
      typeName: typeNameOf(keyOf(name)),
    }))
    .sort(byKey);
};

const READ_MODEL_DIRECTORIES: ReadonlySet<string> = new Set(["projections", "queries"]);

const discoverReadModel = async (
  context: Context,
  directory: string,
  name: string,
): Promise<ReadModelModel | null> => {
  const listing = await list(directory);
  rejectOthers(context, directory, listing);
  for (const module of listing.modules) {
    if (module !== VIEW) {
      context.problems.add(
        join(directory, `${module}.ts`),
        "a read model holds view.ts and the directories projections and queries",
      );
    }
  }
  for (const child of listing.directories) {
    if (!READ_MODEL_DIRECTORIES.has(child)) {
      context.problems.add(
        join(directory, child),
        "a read model holds view.ts and the directories projections and queries",
      );
    }
  }
  if (!listing.modules.includes(VIEW)) {
    context.problems.add(directory, "a read model needs a view.ts with its fields");
    return null;
  }
  const has = (child: string): boolean => listing.directories.includes(child);
  return {
    name,
    directory,
    view: moduleRef(context, join(directory, `${VIEW}.ts`)),
    projections: has("projections")
      ? await discoverProjections(context, join(directory, "projections"))
      : [],
    queries: has("queries") ? await discoverQueries(context, join(directory, "queries")) : [],
  };
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const discoverGroup = async <T>(
  context: Context,
  directory: string,
  what: string,
  discoverOne: (directory: string, name: string) => Promise<T | null>,
): Promise<readonly T[]> => {
  if (!(await exists(directory))) return [];
  const listing = await list(directory);
  rejectOthers(context, directory, listing);
  for (const name of listing.modules) {
    context.problems.add(join(directory, `${name}.ts`), `${what}s are directories, not modules`);
  }
  const found: T[] = [];
  for (const name of listing.directories) {
    const child = join(directory, name);
    if (!checkName(context, child, name, what)) continue;
    const one = await discoverOne(child, keyOf(name));
    if (one !== null) found.push(one);
  }
  return found;
};

const checkForeignHandlers = (context: Context, aggregates: readonly AggregateModel[]): void => {
  const eventsOf = new Map(
    aggregates.map((aggregate) => [
      aggregate.name,
      new Set(aggregate.events.map((event) => event.key)),
    ]),
  );
  for (const aggregate of aggregates) {
    for (const process of aggregate.processes) {
      for (const handler of process.handlers) {
        if (eventsOf.get(handler.aggregate)?.has(handler.eventKey) !== true) {
          context.problems.add(
            handler.path,
            `"${handler.eventKey}" is not an event of the aggregate "${handler.aggregate}"`,
          );
        }
      }
    }
  }
};

/**
 * Reads the project layout under `<root>/<appDir>` and returns what the generator needs. Names
 * come from files and directories only, and no module is imported. Every convention breach is
 * collected and thrown together as one `ConventionError`.
 */
export const discoverProject: DiscoverProjectFunction = async ({ root, appDir = "app" }) => {
  const problems = createProblemCollector();
  const app = join(root, appDir);
  if (!(await exists(app))) {
    problems.add(
      app,
      `the application directory does not exist; expected ${basename(app)}/ under ${root}`,
    );
    problems.throwIfAny();
  }
  const domain = join(app, DOMAIN);
  const context: Context = {
    root,
    problems,
    aggregates: new Set(
      (await exists(domain)) ? (await list(domain)).directories.map((name) => keyOf(name)) : [],
    ),
  };
  const aggregates = await discoverGroup(context, domain, "Aggregate", (directory, name) =>
    discoverAggregate(context, directory, name),
  );
  const readModels = await discoverGroup(
    context,
    join(app, READ),
    "Read model",
    (directory, name) => discoverReadModel(context, directory, name),
  );
  checkForeignHandlers(context, aggregates);
  problems.throwIfAny();
  return { root, appDir, aggregates, readModels };
};
