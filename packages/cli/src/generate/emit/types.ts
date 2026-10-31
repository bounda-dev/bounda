import { BOUNDA_AGGREGATE } from "@bounda-dev/core";
import type { AggregateModel, ProjectModel, ReadModelModel } from "../model.ts";
import { typeNameOf } from "../naming.ts";
import { type GeneratedFile, importPath } from "./paths.ts";

export interface StateTypeSource {
  /**
   * The literal type the generator inferred for an aggregate without `state.ts`, as TypeScript
   * source (`{ readonly status?: "placed" | "paid"; }`), or `null` to fall back to
   * `core.UnknownState`.
   */
  readonly inferred: string | null;
  /**
   * Whether one of the aggregate's events exports `begin`: `inferred` is then the state of the
   * created aggregate, and the state a command handler sees is that or `core.NotCreated` of it.
   */
  readonly created?: boolean;
}

export interface EmitTypesArgs {
  readonly model: ProjectModel;
  /**
   * Absolute path the file will be written to; `typeof import(...)` paths are relative to it.
   */
  readonly path: string;
  /**
   * By aggregate name; an aggregate with `state.ts` ignores its entry.
   */
  readonly inferredStates?: Readonly<Record<string, StateTypeSource>>;
}

export interface EmitTypesFunction {
  (args: EmitTypesArgs): GeneratedFile;
}

export interface StateTypeNameFunction {
  (aggregateName: string): string;
}

export const stateTypeName: StateTypeNameFunction = (aggregateName) =>
  `${typeNameOf(aggregateName)}State`;

export interface CreatedStateTypeNameFunction {
  (aggregateName: string): string;
}

export const createdStateTypeName: CreatedStateTypeNameFunction = (aggregateName) =>
  `${typeNameOf(aggregateName)}CreatedState`;

export interface EventsTypeNameFunction {
  (aggregateName: string): string;
}

export const eventsTypeName: EventsTypeNameFunction = (aggregateName) =>
  `${typeNameOf(aggregateName)}Events`;

export interface RowTypeNameFunction {
  (readModelName: string): string;
}

export const rowTypeName: RowTypeNameFunction = (readModelName) =>
  `${typeNameOf(readModelName)}Row`;

export interface ForgettingTypeNameFunction {
  (readModelName: string): string;
}

export const forgettingTypeName: ForgettingTypeNameFunction = (readModelName) =>
  `${typeNameOf(readModelName)}Forgetting`;

export interface PortsTypeNameFunction {
  (moduleName: string): string;
}

export const portsTypeName: PortsTypeNameFunction = (moduleName) =>
  `${typeNameOf(moduleName)}Ports`;

export const PORTS_CONFIG_TYPE_NAME = "PortsConfig";

const EVENTS_TYPE_NAME = "Events";
const COMMANDS_TYPE_NAME = "Commands";
const REACTION_COMMANDS_TYPE_NAME = "ReactionCommands";
const QUERIES_TYPE_NAME = "Queries";

export const TEST_PORTS_TYPE_NAME = "TestPorts";

/**
 * The types `.bounda/types.ts` declares once for the whole app, next to those of each aggregate
 * and read model.
 */
export const APP_TYPE_NAMES: readonly string[] = [
  EVENTS_TYPE_NAME,
  COMMANDS_TYPE_NAME,
  REACTION_COMMANDS_TYPE_NAME,
  QUERIES_TYPE_NAME,
  PORTS_CONFIG_TYPE_NAME,
  TEST_PORTS_TYPE_NAME,
];

const typeofImport = (from: string, to: string): string =>
  `typeof import("${importPath({ from, to })}")`;

const emitState = (
  aggregate: AggregateModel,
  path: string,
  inferred: StateTypeSource | undefined,
): string => {
  const name = stateTypeName(aggregate.name);
  const created = createdStateTypeName(aggregate.name);
  const whole = (type: string): string =>
    `export type ${name} = ${type};\nexport type ${created} = ${name};`;
  if (aggregate.state !== null) {
    return whole(`core.StateOf<${typeofImport(path, aggregate.state.path)}>`);
  }
  if (inferred?.inferred === undefined || inferred.inferred === null) {
    return whole("core.UnknownState");
  }
  if (inferred.created !== true) return whole(inferred.inferred);
  return [
    `export type ${created} = ${inferred.inferred};`,
    `export type ${name} = core.NotCreated<${created}> | ${created};`,
  ].join("\n");
};

const emitEvents = (aggregate: AggregateModel, path: string): string =>
  aggregate.events.length === 0
    ? `export type ${eventsTypeName(aggregate.name)} = Record<never, never>;`
    : [
        `export type ${eventsTypeName(aggregate.name)} = {`,
        ...aggregate.events.map(
          (event) => `  readonly ${event.key}: ${typeofImport(path, event.path)};`,
        ),
        "};",
      ].join("\n");

type PortsOwner = Pick<AggregateModel | ReadModelModel, "name" | "ports">;

const portsOwners = (model: ProjectModel): readonly PortsOwner[] =>
  [...model.aggregates, ...model.readModels].filter((owner) => owner.ports.length > 0);

const emitPorts = (owner: PortsOwner, path: string): string =>
  owner.ports.length === 0
    ? `export type ${portsTypeName(owner.name)} = core.EmptyPayload;`
    : [
        `export type ${portsTypeName(owner.name)} = {`,
        ...owner.ports.map(
          (port) =>
            `  readonly ${port.key}: import("${importPath({ from: path, to: port.path })}").${port.typeName};`,
        ),
        "};",
      ].join("\n");

const implementationNames = (names: readonly string[]): string =>
  names.map((name) => JSON.stringify(name)).join(" | ");

/**
 * A port with one implementation may be left out of the configuration; one with several must be
 * named, and so must the aggregate or read model that has such a port.
 */
const emitPortsConfig = (model: ProjectModel): string => {
  const owners = portsOwners(model);
  if (owners.length === 0) {
    return `export type ${PORTS_CONFIG_TYPE_NAME} = Readonly<Record<string, never>>;`;
  }
  return [
    `export type ${PORTS_CONFIG_TYPE_NAME} = {`,
    ...owners.flatMap((owner) => {
      const required = owner.ports.some((port) => port.implementations.length > 1);
      return [
        `  readonly ${owner.name}${required ? "" : "?"}: {`,
        ...owner.ports.map(
          (port) =>
            `    readonly ${port.key}${port.implementations.length > 1 ? "" : "?"}: ${implementationNames(
              port.implementations.map((implementation) => implementation.name),
            )};`,
        ),
        "  };",
      ];
    }),
    "};",
  ].join("\n");
};

/**
 * Everything is optional, since a test only passes the ports it exercises, and each port takes a
 * double of its interface as well as an implementation name.
 */
const emitTestPorts = (model: ProjectModel): string => {
  const owners = portsOwners(model);
  if (owners.length === 0) {
    return `export type ${TEST_PORTS_TYPE_NAME} = Readonly<Record<string, never>>;`;
  }
  return [
    `export type ${TEST_PORTS_TYPE_NAME} = {`,
    ...owners.flatMap((owner) => [
      `  readonly ${owner.name}?: {`,
      ...owner.ports.map(
        (port) =>
          `    readonly ${port.key}?: ${implementationNames(
            port.implementations.map((implementation) => implementation.name),
          )} | ${portsTypeName(owner.name)}["${port.key}"];`,
      ),
      "  };",
    ]),
    "};",
  ].join("\n");
};

const FORGOTTEN_EVENT_KEY = "personalDataForgotten";
const EXPECT_TYPE_NAME = "Expect";

/**
 * The event modules a read model projects: each event its projections name, or every event of
 * the aggregate for a projection that exports `on`. The runtime's own events carry no personal
 * data, and no aggregate of the model is theirs.
 */
const projectedModules = (model: ProjectModel, readModel: ReadModelModel, path: string) => {
  const sources = new Set<string>();
  for (const projection of readModel.projections) {
    const aggregate = model.aggregates.find((candidate) => candidate.name === projection.aggregate);
    if (aggregate === undefined) continue;
    const event = aggregate.events.find((candidate) => candidate.key === projection.eventKey);
    const events = eventsTypeName(aggregate.name);
    sources.add(
      event === undefined ? `${events}[keyof ${events}]` : typeofImport(path, event.path),
    );
  }
  return [...sources];
};

/**
 * A type that fails to compile while the read model projects an event with personal fields and
 * has no projection of `PersonalDataForgotten`; `null` for a read model that projects no module.
 */
const emitForgetting = (
  model: ProjectModel,
  readModel: ReadModelModel,
  path: string,
): string | null => {
  const modules = projectedModules(model, readModel, path);
  if (modules.length === 0) return null;
  const handles = readModel.projections.some(
    (projection) =>
      projection.aggregate === BOUNDA_AGGREGATE && projection.eventKey === FORGOTTEN_EVENT_KEY,
  );
  return [
    `export type ${forgettingTypeName(readModel.name)} = ${EXPECT_TYPE_NAME}<`,
    "  core.ForgetsPersonalData<",
    `    "${readModel.name}",`,
    ...(modules.length === 1
      ? [`    ${modules[0]},`]
      : modules.map(
          (module, index) => `    | ${module}${index === modules.length - 1 ? "," : ""}`,
        )),
    `    ${handles}`,
    "  >",
    ">;",
  ].join("\n");
};

const emitMap = (
  name: string,
  wrapper: string,
  entries: readonly (readonly [string, string])[],
): string =>
  entries.length === 0
    ? `export type ${name} = core.${wrapper}<Record<never, never>>;`
    : [
        `export type ${name} = core.${wrapper}<{`,
        ...entries.map(([key, source]) => `  readonly ${key}: ${source};`),
        "}>;",
      ].join("\n");

/**
 * Renders `.bounda/types.ts`: each aggregate's `State`, `Events` and `Ports`, the app's
 * `Events`, the types of the `ports` of the configuration and of `createTestApp`, each
 * read model's `Row` and `Ports`, and the `Commands` and `Queries` facade types. Modules are referenced only
 * through `import(...)` types, so the file never imports the registry.
 */
export const emitTypes: EmitTypesFunction = ({ model, path, inferredStates = {} }) => {
  const sections: string[] = ['import type * as core from "@bounda-dev/core";'];
  for (const aggregate of model.aggregates) {
    sections.push(
      [
        emitState(aggregate, path, inferredStates[aggregate.name]),
        emitEvents(aggregate, path),
        emitPorts(aggregate, path),
      ].join("\n"),
    );
  }
  sections.push(
    model.aggregates.length === 0
      ? `export type ${EVENTS_TYPE_NAME} = Record<never, never>;`
      : [
          `export type ${EVENTS_TYPE_NAME} = {`,
          ...model.aggregates.map(
            (aggregate) => `  readonly ${aggregate.name}: ${eventsTypeName(aggregate.name)};`,
          ),
          "};",
        ].join("\n"),
  );
  sections.push(emitPortsConfig(model));
  sections.push(emitTestPorts(model));
  const commandModules = model.aggregates.flatMap((aggregate) =>
    aggregate.commands.map((command) => [command.key, typeofImport(path, command.path)] as const),
  );
  sections.push(emitMap(COMMANDS_TYPE_NAME, "CommandsFacadeOf", commandModules));
  sections.push(emitMap(REACTION_COMMANDS_TYPE_NAME, "ReactionCommandsFacadeOf", commandModules));
  const forgetting = model.readModels.map((readModel) => emitForgetting(model, readModel, path));
  if (forgetting.some((check) => check !== null)) {
    sections.push(`type ${EXPECT_TYPE_NAME}<Check extends true> = Check;`);
  }
  for (const [index, readModel] of model.readModels.entries()) {
    sections.push(
      [
        `export type ${rowTypeName(readModel.name)} = core.RowOf<${typeofImport(path, readModel.view.path)}>;`,
        emitPorts(readModel, path),
        ...(forgetting[index] === null ? [] : [forgetting[index]]),
      ].join("\n"),
    );
  }
  sections.push(
    emitMap(
      QUERIES_TYPE_NAME,
      "QueriesFacadeOf",
      model.readModels.flatMap((readModel) =>
        readModel.queries.map((query) => [query.key, typeofImport(path, query.path)] as const),
      ),
    ),
  );
  return { path, content: `${sections.join("\n\n")}\n` };
};
