import type { AggregateModel, ModuleRef, ProjectModel, ReadModelModel } from "../model.ts";
import { joinKeys, keyOf, uniqueAliases } from "../naming.ts";
import { type GeneratedFile, importPath } from "./paths.ts";

interface ImportEntry {
  readonly alias: string;
  readonly owner: string;
  readonly path: string;
  readonly kind: "namespace" | "type";
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
    // The port is the owner, not the aggregate: an event named `<aggregate>-<port>` would
    // otherwise share both the alias and the prefix that makes aliases unique.
    for (const port of aggregate.ports) {
      add(joinKeys(aggregate.name, port.key), port.key, port.contract.path, "type");
      for (const implementation of port.implementations) {
        add(
          joinKeys(aggregate.name, port.key, keyOf(implementation.name)),
          port.key,
          implementation.path,
        );
      }
    }
    for (const command of aggregate.commands) add(command.key, aggregate.name, command.path);
    for (const policy of aggregate.policies) add(policy.key, aggregate.name, policy.path);
    for (const process of aggregate.processes) {
      add(process.key, aggregate.name, process.path);
      for (const handler of process.handlers) {
        add(
          handler.aggregate === aggregate.name
            ? joinKeys(process.key, "on", handler.eventKey)
            : joinKeys(process.key, "on", handler.aggregate, handler.eventKey),
          aggregate.name,
          handler.path,
        );
      }
      for (const deadline of process.deadlines) {
        add(joinKeys(process.key, "at", deadline.field), aggregate.name, deadline.path);
      }
    }
  }
  for (const readModel of model.readModels) {
    add(joinKeys(readModel.name, "view"), readModel.name, readModel.view.path);
    for (const projection of readModel.projections) {
      add(
        joinKeys(readModel.name, "on", projection.aggregate, projection.eventKey),
        readModel.name,
        projection.path,
      );
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
      return entry.kind === "type"
        ? `import type * as ${alias} from "${specifier}";`
        : `import * as ${alias} from "${specifier}";`;
    });
  return { of: (path) => byPath.get(path) as string, lines };
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const propertyKey = (key: string): string => (IDENTIFIER.test(key) ? key : JSON.stringify(key));

const record = (pairs: readonly (readonly [string, string])[]): string =>
  pairs.length === 0
    ? "{}"
    : `{ ${pairs.map(([key, value]) => (key === value ? key : `${propertyKey(key)}: ${value}`)).join(", ")} }`;

interface OwnerEntry extends ModuleRef {
  readonly key: string;
  readonly source?: string | null;
}

const sourceOf = (owner: OwnerEntry): string =>
  owner.source === undefined || owner.source === null ? "" : `, source: "${owner.source}"`;

const emitEntries = (owners: readonly OwnerEntry[], aliases: Aliases): string =>
  record(
    owners.map((owner) => [owner.key, `{ module: ${aliases.of(owner.path)}${sourceOf(owner)} }`]),
  );

/**
 * Every implementation is checked against the port's interface here, so `tsc` fails on one that
 * does not fulfil it whether or not the module says `satisfies` itself.
 */
const emitPorts = (aggregate: AggregateModel, aliases: Aliases, indent: string): string[] => {
  if (aggregate.ports.length === 0) return [];
  const inner = `${indent}  `;
  return [
    `${indent}ports: {`,
    ...aggregate.ports.flatMap((port) => [
      `${inner}${port.key}: {`,
      ...port.implementations.map(
        (implementation) =>
          `${inner}  ${propertyKey(implementation.name)}: ${aliases.of(implementation.path)} satisfies ImplementationModule<${aliases.of(port.contract.path)}.${port.typeName}>,`,
      ),
      `${inner}},`,
    ]),
    `${indent}},`,
  ];
};

const emitProcesses = (aggregate: AggregateModel, aliases: Aliases, indent: string): string => {
  if (aggregate.processes.length === 0) return "{}";
  const inner = `${indent}  `;
  const lines = aggregate.processes.map((process) => {
    const byAggregate = new Map<string, (readonly [string, string])[]>();
    for (const handler of process.handlers) {
      const pairs = byAggregate.get(handler.aggregate) ?? [];
      pairs.push([handler.eventKey, aliases.of(handler.path)]);
      byAggregate.set(handler.aggregate, pairs);
    }
    const handlers = record(
      [...byAggregate.entries()].map(([source, pairs]) => [source, record(pairs)]),
    );
    return [
      `${inner}${process.key}: {`,
      `${inner}  module: ${aliases.of(process.path)},`,
      `${inner}  handlers: ${handlers},`,
      ...(process.deadlines.length === 0
        ? []
        : [
            `${inner}  deadlines: ${record(
              process.deadlines.map((deadline) => [deadline.field, aliases.of(deadline.path)]),
            )},`,
          ]),
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
    ...emitPorts(aggregate, aliases, indent),
    `${indent}commands: ${emitEntries(aggregate.commands, aliases)},`,
    `${indent}policies: ${emitEntries(aggregate.policies, aliases)},`,
    `${indent}processes: ${emitProcesses(aggregate, aliases, indent)},`,
    "    },",
  ].join("\n");
};

const emitProjections = (readModel: ReadModelModel, aliases: Aliases): string => {
  const byAggregate = new Map<string, (readonly [string, string])[]>();
  for (const projection of readModel.projections) {
    const pairs = byAggregate.get(projection.aggregate) ?? [];
    pairs.push([projection.eventKey, aliases.of(projection.path)]);
    byAggregate.set(projection.aggregate, pairs);
  }
  return record([...byAggregate.entries()].map(([aggregate, pairs]) => [aggregate, record(pairs)]));
};

const emitReadModel = (readModel: ReadModelModel, aliases: Aliases): string => {
  const indent = "      ";
  return [
    `    ${readModel.name}: {`,
    `${indent}view: ${aliases.of(readModel.view.path)},`,
    `${indent}projections: ${emitProjections(readModel, aliases)},`,
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
 * `.bounda/registry.ts`: one namespace import per module, a type import per port, and the
 * structured registry `createApp` consumes.
 */
export const emitRegistry: EmitRegistryFunction = ({ model, path }) => {
  const aliases = resolveAliases(model, path);
  const hasPorts = model.aggregates.some((aggregate) => aggregate.ports.length > 0);
  const content = [
    hasPorts
      ? 'import type { ImplementationModule, Registry } from "@bounda-dev/core";'
      : 'import type { Registry } from "@bounda-dev/core";',
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
