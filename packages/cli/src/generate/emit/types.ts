import type { AggregateModel, CommandModel, ProjectModel } from "../model.ts";
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
   * Inferred state per aggregate name, for aggregates without `state.ts`.
   */
  readonly inferredStates?: Readonly<Record<string, StateTypeSource>>;
}

export interface EmitTypesFunction {
  (args: EmitTypesArgs): GeneratedFile;
}

export interface StateTypeNameFunction {
  (aggregateName: string): string;
}

/**
 * `order` → `OrderState`.
 */
export const stateTypeName: StateTypeNameFunction = (aggregateName) =>
  `${typeNameOf(aggregateName)}State`;

export interface EventsTypeNameFunction {
  (aggregateName: string): string;
}

/**
 * `order` → `OrderEvents`.
 */
export const eventsTypeName: EventsTypeNameFunction = (aggregateName) =>
  `${typeNameOf(aggregateName)}Events`;

export interface RowTypeNameFunction {
  (readModelName: string): string;
}

/**
 * `orderSummary` → `OrderSummaryRow`.
 */
export const rowTypeName: RowTypeNameFunction = (readModelName) =>
  `${typeNameOf(readModelName)}Row`;

export interface CollaboratorsTypeNameFunction {
  (command: CommandModel): string;
}

/**
 * `cancelOrder` → `CancelOrderCollaborators`.
 */
export const collaboratorsTypeName: CollaboratorsTypeNameFunction = (command) =>
  `${command.typeName}Collaborators`;

export interface InfersCollaboratorsFunction {
  (command: CommandModel): boolean;
}

/**
 * Whether the command's collaborator type comes from its implementations: it has collaborator
 * files and does not declare `Collaborators` itself.
 */
export const infersCollaborators: InfersCollaboratorsFunction = (command) =>
  command.collaborators.length > 0 && !command.declaresCollaborators;

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

const emitCollaborators = (command: CommandModel, path: string): string => {
  const byName = new Map<string, string[]>();
  for (const collaborator of command.collaborators) {
    const lines = byName.get(collaborator.name) ?? [];
    lines.push(
      `    readonly ${collaborator.implementation}: ${typeofImport(path, collaborator.path)}.default;`,
    );
    byName.set(collaborator.name, lines);
  }
  return [
    `export type ${collaboratorsTypeName(command)} = core.InferCollaborators<{`,
    ...[...byName.entries()].flatMap(([name, lines]) => [
      `  readonly ${name}: {`,
      ...lines,
      "  };",
    ]),
    "}>;",
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
 * `.bounda/types.ts`: per aggregate its `State` and `Events` maps, the inferred collaborator
 * types, the `Commands` facade type, per read model its `Row`, and the `Queries` facade type.
 * Everything is `typeof import(...)`, so the file never references the registry.
 */
export const emitTypes: EmitTypesFunction = ({ model, path, inferredStates = {} }) => {
  const sections: string[] = ['import type * as core from "@bounda-dev/core";'];
  for (const aggregate of model.aggregates) {
    sections.push(
      [
        emitState(aggregate, path, inferredStates[aggregate.name]),
        emitEvents(aggregate, path),
      ].join("\n"),
    );
  }
  const inferred = model.aggregates.flatMap((aggregate) =>
    aggregate.commands.filter(infersCollaborators),
  );
  for (const command of inferred) sections.push(emitCollaborators(command, path));
  sections.push(
    emitMap(
      "Commands",
      "CommandsFacadeOf",
      model.aggregates.flatMap((aggregate) =>
        aggregate.commands.map(
          (command) => [command.key, typeofImport(path, command.path)] as const,
        ),
      ),
    ),
  );
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
