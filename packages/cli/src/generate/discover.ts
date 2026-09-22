import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type {
  AggregateModel,
  CollaboratorModel,
  CommandModel,
  EventModel,
  ModuleRef,
  PolicyModel,
  ProcessHandlerModel,
  ProcessModel,
  ProjectionModel,
  ProjectModel,
  QueryModel,
  ReadModelModel,
} from "./model.ts";
import {
  collaboratorPartsOf,
  isKebabCase,
  keyOf,
  policyTriggerOf,
  processHandlerEventOf,
  typeNameOf,
} from "./naming.ts";
import { createProblemCollector, type ProblemCollector } from "./problems.ts";

export interface DiscoverProjectArgs {
  readonly root: string;
  /**
   * The application directory under `root`. Defaults to `app`, like `rootDir` in the
   * configuration.
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
const TIMEOUT_HANDLER = "on-timeout";
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

const discoverCollaborators = async (
  context: Context,
  directory: string,
): Promise<readonly CollaboratorModel[]> => {
  const listing = await list(directory);
  rejectOthers(context, directory, listing);
  for (const name of listing.directories) {
    context.problems.add(
      join(directory, name),
      "a command directory holds only index.ts and collaborators",
    );
  }
  const collaborators: CollaboratorModel[] = [];
  for (const name of listing.modules) {
    if (name === INDEX) continue;
    const path = join(directory, `${name}.ts`);
    const parts = collaboratorPartsOf(name);
    if (parts === null) {
      context.problems.add(
        path,
        "expected a collaborator named <collaborator>.<implementation>.ts",
      );
      continue;
    }
    collaborators.push({ ...moduleRef(context, path), ...parts });
  }
  return collaborators.sort(
    (a, b) => a.name.localeCompare(b.name) || a.implementation.localeCompare(b.implementation),
  );
};

const discoverCommands = async (
  context: Context,
  directory: string,
): Promise<readonly CommandModel[]> => {
  const listing = await list(directory);
  rejectOthers(context, directory, listing);
  const commands: CommandModel[] = [];
  for (const name of listing.modules) {
    const path = join(directory, `${name}.ts`);
    if (!checkName(context, path, name, "Command")) continue;
    if (name.includes(".")) {
      context.problems.add(path, "collaborators live inside the command's directory");
      continue;
    }
    commands.push({
      ...moduleRef(context, path),
      key: keyOf(name),
      typeName: typeNameOf(keyOf(name)),
      directory: null,
      collaborators: [],
      declaresCollaborators: false,
    });
  }
  for (const name of listing.directories) {
    const commandDirectory = join(directory, name);
    if (!checkName(context, commandDirectory, name, "Command")) continue;
    const index = join(commandDirectory, `${INDEX}.ts`);
    if (!(await exists(index))) {
      context.problems.add(commandDirectory, "a command directory needs an index.ts");
      continue;
    }
    if (commands.some((command) => command.key === keyOf(name))) {
      context.problems.add(
        commandDirectory,
        `command "${keyOf(name)}" is also defined as ${name}.ts`,
      );
      continue;
    }
    const collaborators = await discoverCollaborators(context, commandDirectory);
    commands.push({
      ...moduleRef(context, index),
      key: keyOf(name),
      typeName: typeNameOf(keyOf(name)),
      directory: commandDirectory,
      collaborators,
      declaresCollaborators: collaborators.length > 0 && (await declaresCollaborators(index)),
    });
  }
  return commands.sort(byKey);
};

const discoverPolicies = async (
  context: Context,
  directory: string,
): Promise<readonly PolicyModel[]> => {
  const listing = await list(directory);
  rejectOthers(context, directory, listing);
  for (const name of listing.directories) {
    context.problems.add(
      join(directory, name),
      "policies are single modules; directories are not allowed here",
    );
  }
  return listing.modules
    .filter((name) => checkName(context, join(directory, `${name}.ts`), name, "Policy"))
    .map((name) => ({
      ...moduleRef(context, join(directory, `${name}.ts`)),
      key: keyOf(name),
      triggerKey: policyTriggerOf(name),
    }))
    .sort(byKey);
};

const discoverProcess = async (
  context: Context,
  directory: string,
  name: string,
  eventKeys: ReadonlySet<string>,
): Promise<ProcessModel | null> => {
  const index = join(directory, `${INDEX}.ts`);
  if (!(await exists(index))) {
    context.problems.add(directory, "a process directory needs an index.ts with its config");
    return null;
  }
  const listing = await list(directory);
  rejectOthers(context, directory, listing);
  for (const child of listing.directories) {
    context.problems.add(
      join(directory, child),
      "a process directory holds only index.ts and on-*.ts handlers",
    );
  }
  const handlers: ProcessHandlerModel[] = [];
  let timeout: ModuleRef | null = null;
  for (const module of listing.modules) {
    if (module === INDEX) continue;
    const path = join(directory, `${module}.ts`);
    if (module === TIMEOUT_HANDLER) {
      timeout = moduleRef(context, path);
      continue;
    }
    const eventKey = processHandlerEventOf(module);
    if (eventKey === null) {
      context.problems.add(path, "process handlers are named on-<event>.ts or on-timeout.ts");
      continue;
    }
    if (!eventKeys.has(eventKey)) {
      context.problems.add(path, `"${eventKey}" is not an event of this aggregate`);
      continue;
    }
    handlers.push({ ...moduleRef(context, path), eventKey });
  }
  return {
    ...moduleRef(context, index),
    key: keyOf(name),
    typeName: typeNameOf(keyOf(name)),
    directory,
    handlers: handlers.sort((a, b) => a.eventKey.localeCompare(b.eventKey)),
    timeout,
  };
};

const discoverProcesses = async (
  context: Context,
  directory: string,
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
    const process = await discoverProcess(context, processDirectory, name, eventKeys);
    if (process !== null) processes.push(process);
  }
  return processes.sort(byKey);
};

const AGGREGATE_DIRECTORIES: ReadonlySet<string> = new Set(["commands", "policies", "processes"]);

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
  for (const child of listing.directories) {
    if (!AGGREGATE_DIRECTORIES.has(child)) {
      context.problems.add(
        join(directory, child),
        "an aggregate holds events, state.ts and the directories commands, policies and processes",
      );
    }
  }
  const has = (child: string): boolean => listing.directories.includes(child);
  const eventKeys = new Set(events.map((event) => event.key));
  return {
    name,
    directory,
    state,
    events: eventsWithUpcasts.sort(byKey),
    commands: has("commands") ? await discoverCommands(context, join(directory, "commands")) : [],
    policies: has("policies") ? await discoverPolicies(context, join(directory, "policies")) : [],
    processes: has("processes")
      ? await discoverProcesses(context, join(directory, "processes"), eventKeys)
      : [],
  };
};

const discoverProjections = async (
  context: Context,
  directory: string,
): Promise<readonly ProjectionModel[]> => {
  const listing = await list(directory);
  rejectOthers(context, directory, listing);
  for (const name of listing.directories) {
    context.problems.add(
      join(directory, name),
      "projections are single modules; directories are not allowed here",
    );
  }
  return listing.modules
    .filter((name) => checkName(context, join(directory, `${name}.ts`), name, "Projection"))
    .map((name) => ({
      ...moduleRef(context, join(directory, `${name}.ts`)),
      eventKey: keyOf(name),
    }))
    .sort((a, b) => a.eventKey.localeCompare(b.eventKey));
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

const COLLABORATORS_DECLARATION = /^export\s+(?:type|interface)\s+Collaborators\b/m;

const declaresCollaborators = async (modulePath: string): Promise<boolean> =>
  COLLABORATORS_DECLARATION.test(await readFile(modulePath, "utf8"));

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

/**
 * Reads the project layout under `<root>/<appDir>` and returns what the generator needs. Names
 * come from files and directories only; no module is imported or parsed. Convention breaches
 * are collected and thrown together as a `ConventionError`.
 */
export const discoverProject: DiscoverProjectFunction = async ({ root, appDir = "app" }) => {
  const problems = createProblemCollector();
  const context: Context = { root, problems };
  const app = join(root, appDir);
  if (!(await exists(app))) {
    problems.add(
      app,
      `the application directory does not exist; expected ${basename(app)}/ under ${root}`,
    );
    problems.throwIfAny();
  }
  const aggregates = await discoverGroup(
    context,
    join(app, DOMAIN),
    "Aggregate",
    (directory, name) => discoverAggregate(context, directory, name),
  );
  const readModels = await discoverGroup(
    context,
    join(app, READ),
    "Read model",
    (directory, name) => discoverReadModel(context, directory, name),
  );
  problems.throwIfAny();
  return { root, appDir, aggregates, readModels };
};
