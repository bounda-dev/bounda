import type { AggregateModel, ProjectModel } from "../model.ts";
import { typeNameOf } from "../naming.ts";
import { type GeneratedFile, importPath } from "./paths.ts";

export interface StateTypeSource {
  /**
   * The literal type the generator inferred for an aggregate without `state.ts`, as TypeScript
   * source (`{ readonly status?: "placed" | "paid"; }`), or `null` to fall back to
   * `core.UnknownState`.
   */
  readonly inferred: string | null;
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

export interface CollaboratorsTypeNameFunction {
  (aggregateName: string): string;
}

export const collaboratorsTypeName: CollaboratorsTypeNameFunction = (aggregateName) =>
  `${typeNameOf(aggregateName)}Collaborators`;

export const COLLABORATORS_CONFIG_TYPE_NAME = "CollaboratorsConfig";

export const TEST_COLLABORATORS_TYPE_NAME = "TestCollaborators";

const typeofImport = (from: string, to: string): string =>
  `typeof import("${importPath({ from, to })}")`;

const emitState = (
  aggregate: AggregateModel,
  path: string,
  inferred: StateTypeSource | undefined,
): string => {
  const name = stateTypeName(aggregate.name);
  if (aggregate.state !== null) {
    return `export type ${name} = core.StateOf<${typeofImport(path, aggregate.state.path)}>;`;
  }
  if (inferred?.inferred !== undefined && inferred.inferred !== null) {
    return `export type ${name} = ${inferred.inferred};`;
  }
  return `export type ${name} = core.UnknownState;`;
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

const emitCollaborators = (aggregate: AggregateModel, path: string): string =>
  aggregate.collaborators.length === 0
    ? `export type ${collaboratorsTypeName(aggregate.name)} = core.EmptyPayload;`
    : [
        `export type ${collaboratorsTypeName(aggregate.name)} = {`,
        ...aggregate.collaborators.map(
          (port) =>
            `  readonly ${port.key}: import("${importPath({ from: path, to: port.contract.path })}").${port.typeName};`,
        ),
        "};",
      ].join("\n");

const implementationNames = (names: readonly string[]): string =>
  names.map((name) => JSON.stringify(name)).join(" | ");

/**
 * A port with one implementation may be left out of the configuration; one with several must be
 * named, and so must the aggregate that has such a port.
 */
const emitCollaboratorsConfig = (model: ProjectModel): string => {
  const aggregates = model.aggregates.filter((aggregate) => aggregate.collaborators.length > 0);
  if (aggregates.length === 0) {
    return `export type ${COLLABORATORS_CONFIG_TYPE_NAME} = Readonly<Record<string, never>>;`;
  }
  return [
    `export type ${COLLABORATORS_CONFIG_TYPE_NAME} = {`,
    ...aggregates.flatMap((aggregate) => {
      const required = aggregate.collaborators.some((port) => port.implementations.length > 1);
      return [
        `  readonly ${aggregate.name}${required ? "" : "?"}: {`,
        ...aggregate.collaborators.map(
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
const emitTestCollaborators = (model: ProjectModel): string => {
  const aggregates = model.aggregates.filter((aggregate) => aggregate.collaborators.length > 0);
  if (aggregates.length === 0) {
    return `export type ${TEST_COLLABORATORS_TYPE_NAME} = Readonly<Record<string, never>>;`;
  }
  return [
    `export type ${TEST_COLLABORATORS_TYPE_NAME} = {`,
    ...aggregates.flatMap((aggregate) => [
      `  readonly ${aggregate.name}?: {`,
      ...aggregate.collaborators.map(
        (port) =>
          `    readonly ${port.key}?: ${implementationNames(
            port.implementations.map((implementation) => implementation.name),
          )} | ${collaboratorsTypeName(aggregate.name)}["${port.key}"];`,
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
 * Renders `.bounda/types.ts`: each aggregate's `State`, `Events` and `Collaborators`, the app's
 * `Events`, the types of the `collaborators` of the configuration and of `createTestApp`, each
 * read model's `Row`, and the `Commands` and `Queries` facade types. Modules are referenced only
 * through `import(...)` types, so the file never imports the registry.
 */
export const emitTypes: EmitTypesFunction = ({ model, path, inferredStates = {} }) => {
  const sections: string[] = ['import type * as core from "@bounda-dev/core";'];
  for (const aggregate of model.aggregates) {
    sections.push(
      [
        emitState(aggregate, path, inferredStates[aggregate.name]),
        emitEvents(aggregate, path),
        emitCollaborators(aggregate, path),
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
  sections.push(emitCollaboratorsConfig(model));
  sections.push(emitTestCollaborators(model));
  const commandModules = model.aggregates.flatMap((aggregate) =>
    aggregate.commands.map((command) => [command.key, typeofImport(path, command.path)] as const),
  );
  sections.push(emitMap("Commands", "CommandsFacadeOf", commandModules));
  sections.push(emitMap("ReactionCommands", "ReactionCommandsFacadeOf", commandModules));
  for (const readModel of model.readModels) {
    sections.push(
      `export type ${rowTypeName(readModel.name)} = core.RowOf<${typeofImport(path, readModel.view.path)}>;`,
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
