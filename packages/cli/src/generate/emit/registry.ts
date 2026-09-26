import type {
  AggregateModel,
  CollaboratorOwnerModel,
  ModuleRef,
  ProjectModel,
  ReadModelModel,
} from "../model.ts";
import { joinKeys, uniqueAliases } from "../naming.ts";
import { type GeneratedFile, importPath } from "./paths.ts";

interface ImportEntry {
  readonly alias: string;
  readonly owner: string;
  readonly path: string;
  readonly kind: "namespace" | "default";
}

interface Aliases {
  readonly of: (path: string) => string;
  readonly lines: readonly string[];
}

const collectImports = (model: ProjectModel): readonly ImportEntry[] => {
  const entries: ImportEntry[] = [];
  const add = (
    alias: string,
    owner: string,
    path: string,
    kind: ImportEntry["kind"] = "namespace",
  ) => {
    entries.push({ alias, owner, path, kind });
  };
  for (const aggregate of model.aggregates) {
    if (aggregate.state !== null)
      add(joinKeys(aggregate.name, "state"), aggregate.name, aggregate.state.path);
    for (const event of aggregate.events) {
      add(event.key, aggregate.name, event.path);
      if (event.upcasts !== null) {
        add(joinKeys(event.key, "upcasts"), aggregate.name, event.upcasts.path);
      }
    }
    const addCollaborators = (owner: CollaboratorOwnerModel, key: string) => {
      for (const collaborator of owner.collaborators) {
        add(
          joinKeys(collaborator.name, collaborator.implementation),
          key,
          collaborator.path,
          "default",
        );
      }
    };
    for (const command of aggregate.commands) {
      add(command.key, aggregate.name, command.path);
      addCollaborators(command, command.key);
    }
    for (const policy of aggregate.policies) {
      add(policy.key, aggregate.name, policy.path);
      addCollaborators(policy, policy.key);
    }
    for (const process of aggregate.processes) {
      add(process.key, aggregate.name, process.path);
      addCollaborators(process, process.key);
      for (const handler of process.handlers) {
        add(joinKeys(process.key, "on", handler.eventKey), aggregate.name, handler.path);
      }
      if (process.timeout !== null)
        add(joinKeys(process.key, "on", "timeout"), aggregate.name, process.timeout.path);
    }
  }
  for (const readModel of model.readModels) {
    add(joinKeys(readModel.name, "view"), readModel.name, readModel.view.path);
    for (const projection of readModel.projections) {
      add(joinKeys(readModel.name, "on", projection.eventKey), readModel.name, projection.path);
    }
    for (const query of readModel.queries) add(query.key, readModel.name, query.path);
  }
  return entries;
};

const resolveAliases = (model: ProjectModel, registryPath: string): Aliases => {
  const entries = collectImports(model);
  const aliases = uniqueAliases({ entries });
  const byPath = new Map(entries.map((entry, index) => [entry.path, aliases[index] as string]));
  const lines = entries
    .map((entry, index) => ({ entry, alias: aliases[index] as string }))
    .sort((a, b) => (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0))
    .map(({ entry, alias }) => {
      const specifier = importPath({ from: registryPath, to: entry.path });
      return entry.kind === "default"
        ? `import ${alias} from "${specifier}";`
        : `import * as ${alias} from "${specifier}";`;
    });
  return { of: (path) => byPath.get(path) as string, lines };
};

const record = (pairs: readonly (readonly [string, string])[]): string =>
  pairs.length === 0
    ? "{}"
    : `{ ${pairs.map(([key, value]) => (key === value ? key : `${key}: ${value}`)).join(", ")} }`;

const collaboratorsOf = (owner: CollaboratorOwnerModel, aliases: Aliases): string => {
  const byName = new Map<string, string[]>();
  for (const collaborator of owner.collaborators) {
    const implementations = byName.get(collaborator.name) ?? [];
    implementations.push(`${collaborator.implementation}: ${aliases.of(collaborator.path)}`);
    byName.set(collaborator.name, implementations);
  }
  return [...byName.entries()]
    .map(([name, implementations]) => `${name}: { ${implementations.join(", ")} }`)
    .join(", ");
};

interface OwnerEntry extends CollaboratorOwnerModel {
  readonly key: string;
}

const emitEntries = (owners: readonly OwnerEntry[], aliases: Aliases, indent: string): string => {
  if (owners.length === 0) return "{}";
  if (owners.every((owner) => owner.collaborators.length === 0)) {
    return record(owners.map((owner) => [owner.key, `{ module: ${aliases.of(owner.path)} }`]));
  }
  const inner = `${indent}  `;
  const lines = owners.map((owner) => {
    if (owner.collaborators.length === 0) {
      return `${inner}${owner.key}: { module: ${aliases.of(owner.path)} },`;
    }
    return [
      `${inner}${owner.key}: {`,
      `${inner}  module: ${aliases.of(owner.path)},`,
      `${inner}  collaborators: { ${collaboratorsOf(owner, aliases)} },`,
      `${inner}},`,
    ].join("\n");
  });
  return `{\n${lines.join("\n")}\n${indent}}`;
};

const emitProcesses = (aggregate: AggregateModel, aliases: Aliases, indent: string): string => {
  if (aggregate.processes.length === 0) return "{}";
  const inner = `${indent}  `;
  const lines = aggregate.processes.map((process) => {
    const handlers = record(
      process.handlers.map((handler) => [handler.eventKey, aliases.of(handler.path)]),
    );
    return [
      `${inner}${process.key}: {`,
      `${inner}  module: ${aliases.of(process.path)},`,
      `${inner}  handlers: ${handlers},`,
      ...(process.timeout === null
        ? []
        : [`${inner}  timeout: ${aliases.of(process.timeout.path)},`]),
      ...(process.collaborators.length === 0
        ? []
        : [`${inner}  collaborators: { ${collaboratorsOf(process, aliases)} },`]),
      `${inner}},`,
    ].join("\n");
  });
  return `{\n${lines.join("\n")}\n${indent}}`;
};

const emitUpcasts = (aggregate: AggregateModel, aliases: Aliases, indent: string): string[] => {
  const upcast = aggregate.events.filter((event) => event.upcasts !== null);
  if (upcast.length === 0) return [];
  return [
    `${indent}upcasts: ${record(
      upcast.map((event) => [event.key, aliases.of((event.upcasts as ModuleRef).path)]),
    )},`,
  ];
};

const emitAggregate = (aggregate: AggregateModel, aliases: Aliases): string => {
  const indent = "      ";
  return [
    `    ${aggregate.name}: {`,
    ...(aggregate.state === null ? [] : [`${indent}state: ${aliases.of(aggregate.state.path)},`]),
    `${indent}events: ${record(aggregate.events.map((event) => [event.key, aliases.of(event.path)]))},`,
    ...emitUpcasts(aggregate, aliases, indent),
    `${indent}commands: ${emitEntries(aggregate.commands, aliases, indent)},`,
    `${indent}policies: ${emitEntries(aggregate.policies, aliases, indent)},`,
    `${indent}processes: ${emitProcesses(aggregate, aliases, indent)},`,
    "    },",
  ].join("\n");
};

const emitReadModel = (readModel: ReadModelModel, aliases: Aliases): string => {
  const indent = "      ";
  return [
    `    ${readModel.name}: {`,
    `${indent}view: ${aliases.of(readModel.view.path)},`,
    `${indent}projections: ${record(readModel.projections.map((projection) => [projection.eventKey, aliases.of(projection.path)]))},`,
    `${indent}queries: ${record(readModel.queries.map((query) => [query.key, aliases.of(query.path)]))},`,
    "    },",
  ].join("\n");
};

const group = (name: string, entries: readonly string[]): readonly string[] =>
  entries.length === 0 ? [`  ${name}: {},`] : [`  ${name}: {`, ...entries, "  },"];

export interface EmitRegistryArgs {
  readonly model: ProjectModel;
  /**
   * Absolute path the registry will be written to; imports are relative to it.
   */
  readonly path: string;
}

export interface EmitRegistryFunction {
  (args: EmitRegistryArgs): GeneratedFile;
}

/**
 * `.bounda/registry.ts`: one namespace import per module, one default import per collaborator
 * implementation of a command, policy or process, and the structured registry `createApp`
 * consumes.
 */
export const emitRegistry: EmitRegistryFunction = ({ model, path }) => {
  const aliases = resolveAliases(model, path);
  const content = [
    'import type { Registry } from "@bounda-dev/core";',
    ...aliases.lines,
    "",
    "export const registry = {",
    ...group(
      "aggregates",
      model.aggregates.map((aggregate) => emitAggregate(aggregate, aliases)),
    ),
    ...group(
      "readModels",
      model.readModels.map((readModel) => emitReadModel(readModel, aliases)),
    ),
    "} as const satisfies Registry;",
    "",
  ].join("\n");
  return { path, content };
};
