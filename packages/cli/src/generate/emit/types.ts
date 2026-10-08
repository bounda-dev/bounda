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

export interface PortsTypeNameFunction {
  (moduleName: string): string;
}

export const portsTypeName: PortsTypeNameFunction = (moduleName) =>
  `${typeNameOf(moduleName)}Ports`;

export const PORTS_CONFIG_TYPE_NAME = "PortsConfig";

export const TEST_PORTS_TYPE_NAME = "TestPorts";

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
      ? "export type Events = Record<never, never>;"
      : [
          "export type Events = {",
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
  sections.push(emitMap("Commands", "CommandsFacadeOf", commandModules));
  sections.push(emitMap("ReactionCommands", "ReactionCommandsFacadeOf", commandModules));
  for (const readModel of model.readModels) {
    sections.push(
      [
        `export type ${rowTypeName(readModel.name)} = core.RowOf<${typeofImport(path, readModel.view.path)}>;`,
        emitPorts(readModel, path),
      ].join("\n"),
    );
  }
  sections.push(
    emitMap(
      "Queries",
      "QueriesFacadeOf",
      model.readModels.flatMap((readModel) =>
        readModel.queries.map((query) => [query.key, typeofImport(path, query.path)] as const),
      ),
    ),
  );
  return { path, content: `${sections.join("\n\n")}\n` };
};
