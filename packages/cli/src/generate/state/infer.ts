import { dirname, resolve } from "node:path";
import { createdStateTypeName, type StateTypeSource, stateTypeName } from "../emit/types.ts";
import type { EventModel, ProjectModel } from "../model.ts";

export interface StateWarning {
  readonly aggregate: string;
  readonly message: string;
}

export interface InferStatesArgs {
  readonly model: ProjectModel;
  readonly tsconfigPath: string;
  // Absolute: TypeScript's reads are matched against it. The file must exist on disk so the
  // project includes it, though its content is served from memory.
  readonly typesPath: string;
  // Types every state to infer as `core.UnknownState`, which is what makes each `evolve` return
  // only the fields it sets.
  readonly typesContent: string;
  readonly renderTypes: (states: Readonly<Record<string, StateTypeSource>>) => string;
}

export interface InferStatesResult {
  readonly states: Readonly<Record<string, StateTypeSource>>;
  readonly warnings: readonly StateWarning[];
}

export interface InferStatesFunction {
  (args: InferStatesArgs): Promise<InferStatesResult>;
}

interface FieldTypes {
  readonly members: Set<string>;
  readonly events: Set<string>;
}

type Fields = Map<string, FieldTypes>;

interface AggregateFields {
  readonly fields: Fields;
  /**
   * The fields every `begin` always sets, required once the aggregate exists; `null` when no
   * event exports `begin`.
   */
  readonly required: ReadonlySet<string> | null;
}

interface Checkers {
  readonly api: import("typescript/unstable/sync").API;
  readonly project: import("typescript/unstable/sync").Project;
  readonly enclosing: import("typescript/unstable/ast").Node;
}

const UNKNOWN = "unknown";

const renderState = ({ fields, required }: AggregateFields): string => {
  const names = [...fields.keys()].sort();
  if (names.length === 0) return "Record<never, never>";
  const lines = names.map((name) => {
    const members = [...(fields.get(name) as FieldTypes).members].sort();
    const type = members
      .join(" | ")
      .split("\n")
      .map((line, index) => (index === 0 || line.startsWith(" ") ? line : `  ${line}`))
      .join("\n");
    return `  readonly ${name}${required?.has(name) === true ? "" : "?"}: ${type};`;
  });
  return `{\n${lines.join("\n")}\n}`;
};

const statesOf = (
  fields: ReadonlyMap<string, AggregateFields>,
): Readonly<Record<string, StateTypeSource>> =>
  Object.fromEntries(
    [...fields.entries()].map(([name, aggregateFields]) => [
      name,
      { inferred: renderState(aggregateFields), created: aggregateFields.required !== null },
    ]),
  );

// Enough for a field computed from another field computed from the state, and so on: each pass
// types one more link of the chain.
const MAX_PASSES = 5;

// What reading a field off a state with no type yet leaves in a printed type, outside a string
// literal: `any` once it is computed with, `unknown` when it is taken as it is.
const UNTYPED = /(?<![\w"'`])(?:any|unknown)(?![\w"'`])/;
const TAINTED = /(?<![\w"'`])any(?![\w"'`])/;

// The states to read the next pass against: each field without its `any` members, or `unknown`
// when nothing else is left.
const untainted = (
  fields: ReadonlyMap<string, AggregateFields>,
): ReadonlyMap<string, AggregateFields> =>
  new Map(
    [...fields].map(([name, { fields: aggregateFields, required }]) => [
      name,
      {
        required,
        fields: new Map(
          [...aggregateFields].map(([field, { members, events }]) => {
            const clean = [...members].filter((member) => !TAINTED.test(member));
            return [field, { members: new Set(clean.length > 0 ? clean : [UNKNOWN]), events }];
          }),
        ),
      },
    ]),
  );

// Serves `content` as `.bounda/types.ts` and returns the checkers of the project that reads it.
const serveTypes = (
  checkers: Checkers,
  typesPath: string,
  types: TypesInMemory,
  content: string,
): Checkers => {
  types.content = content;
  const snapshot = checkers.api.updateSnapshot({ fileChanges: { changed: [typesPath] } });
  const project =
    snapshot.getProject(checkers.project.configFileName) ??
    snapshot.getProjects()[0] ??
    checkers.project;
  const typesFile = project.program.getSourceFile(typesPath);
  const enclosing = typesFile?.statements[typesFile.statements.length - 1] ?? checkers.enclosing;
  return { api: checkers.api, project, enclosing };
};

// The node naming a top-level `const` or `function` called `name`; only an exported one when
// `exported` is set.
const declaredName = (
  ts: typeof import("typescript/unstable/ast"),
  file: import("typescript/unstable/ast").SourceFile,
  name: string,
  exported: boolean,
): import("typescript/unstable/ast").Node | null => {
  for (const statement of file.statements) {
    const isExported = (statement as { modifiers?: readonly { kind: number }[] }).modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (exported && !isExported) continue;
    if (statement.kind === ts.SyntaxKind.VariableStatement) {
      for (const declaration of (statement as import("typescript/unstable/ast").VariableStatement)
        .declarationList.declarations) {
        if (declaration.name.getText(file) === name) return declaration.name;
      }
    }
    if (statement.kind === ts.SyntaxKind.FunctionDeclaration) {
      const declared = (statement as import("typescript/unstable/ast").FunctionDeclaration).name;
      if (declared !== undefined && declared.getText(file) === name) return declared;
    }
  }
  return null;
};

/**
 * The declaration a module exports under `exportName`, as `export const`, `export function` or
 * an `export { local as exportName }` list, which discovery counts as an export too.
 */
const exportedFunction = (
  ts: typeof import("typescript/unstable/ast"),
  file: import("typescript/unstable/ast").SourceFile,
  exportName: "evolve" | "begin",
): import("typescript/unstable/ast").Node | null => {
  const declared = declaredName(ts, file, exportName, true);
  if (declared !== null) return declared;
  for (const statement of file.statements) {
    if (statement.kind !== ts.SyntaxKind.ExportDeclaration) continue;
    const declaration = statement as import("typescript/unstable/ast").ExportDeclaration;
    const clause = declaration.exportClause;
    if (declaration.moduleSpecifier !== undefined || clause?.kind !== ts.SyntaxKind.NamedExports) {
      continue;
    }
    for (const element of (clause as import("typescript/unstable/ast").NamedExports).elements) {
      if (element.name.getText(file) !== exportName) continue;
      return declaredName(ts, file, (element.propertyName ?? element.name).getText(file), false);
    }
  }
  return null;
};

// What a `begin` or an `evolve` returns: each field's printed type, and whether it may be absent.
type Returned = ReadonlyMap<string, { readonly type: string; readonly absent: boolean }>;

interface EventReturns {
  readonly event: EventModel;
  readonly begin: Returned | null;
  readonly evolve: Returned | null;
  // Whether what `evolve` returns depends on the types of the state: it came out untyped from the
  // first pass, which reads it against `core.UnknownState`. Only such an `evolve` is read again.
  readonly readsState: boolean;
}

// Reads what an event's `begin` and `evolve` return, or, given what an earlier pass read, only
// its `evolve` again when that one reads the state.
const readReturns = (
  sync: typeof import("typescript/unstable/sync"),
  ts: typeof import("typescript/unstable/ast"),
  checkers: Checkers,
  event: EventModel,
  previous: EventReturns | undefined,
  warn: (message: string) => void,
): EventReturns | null => {
  if (previous !== undefined && !previous.readsState) return previous;
  const { checker, program, emitter } = checkers.project;
  const file = program.getSourceFile(event.path);
  if (file === undefined) {
    warn(
      `${event.relativePath} is not part of the TypeScript project, so its begin and evolve were skipped`,
    );
    return null;
  }
  const flags = sync.NodeBuilderFlags.NoTruncation | sync.NodeBuilderFlags.UseFullyQualifiedType;
  const maybeAbsent =
    sync.TypeFlags.Any | sync.TypeFlags.Unknown | sync.TypeFlags.Undefined | sync.TypeFlags.Void;
  const print = (type: import("typescript/unstable/sync").Type): string => {
    const node = checker.typeToTypeNode(type, checkers.enclosing, flags);
    return node === undefined ? UNKNOWN : emitter.printNode(node);
  };
  // Spreading a state field whose type is a union, `{ ...state.prices, [zone]: price }`, gives a
  // union of objects that print the same; kept apart, they would grow the type on every pass.
  const printUnique = (type: import("typescript/unstable/sync").Type): string => {
    const members = type.isUnionType() ? (type.getTypes() ?? []) : [];
    const unique = [...new Set(members.map(print))];
    return unique.length === members.length ? print(type) : unique.join(" | ");
  };
  const read = (exportName: "evolve" | "begin"): Returned | null => {
    const name = exportedFunction(ts, file, exportName);
    if (name === null) return null;
    const symbol = checker.getSymbolAtLocation(name);
    const type = symbol === undefined ? undefined : checker.getTypeOfSymbol(symbol);
    const signature =
      type === undefined
        ? undefined
        : checker.getSignaturesOfType(type, sync.SignatureKind.Call)[0];
    const returned =
      signature === undefined ? undefined : checker.getReturnTypeOfSignature(signature);
    if (returned === undefined) {
      warn(`${event.relativePath}: ${exportName} has no call signature, so it was skipped`);
      return null;
    }
    return new Map(
      checker.getPropertiesOfType(returned).map((property) => {
        const propertyType = checker.getTypeOfSymbol(property);
        const absent =
          (property.flags & sync.SymbolFlags.Optional) !== 0 ||
          propertyType === undefined ||
          [
            propertyType,
            ...(propertyType.isUnionType() ? (propertyType.getTypes() ?? []) : []),
          ].some((member) => (member.flags & maybeAbsent) !== 0);
        return [
          property.name,
          { type: propertyType === undefined ? UNKNOWN : printUnique(propertyType), absent },
        ];
      }),
    );
  };
  if (previous !== undefined) return { ...previous, evolve: read("evolve") };
  const begin = read("begin");
  const evolve = read("evolve");
  const readsState = [...(evolve?.values() ?? [])].some(({ type }) => UNTYPED.test(type));
  return { event, begin, evolve, readsState };
};

const fieldsOf = (returns: readonly EventReturns[]): AggregateFields => {
  const fields: Fields = new Map();
  // What each `begin` always sets.
  const opening: ReadonlySet<string>[] = [];
  for (const { event, begin, evolve } of returns) {
    for (const returned of [begin, evolve]) {
      for (const [name, { type }] of returned ?? []) {
        const field = fields.get(name) ?? { members: new Set<string>(), events: new Set<string>() };
        field.members.add(type);
        field.events.add(event.key);
        fields.set(name, field);
      }
    }
    if (begin !== null) {
      opening.push(new Set([...begin].filter(([, { absent }]) => !absent).map(([name]) => name)));
    }
  }
  const [first, ...rest] = opening;
  const required =
    first === undefined
      ? null
      : new Set([...first].filter((name) => rest.every((always) => always.has(name))));
  return { fields, required };
};

interface FieldLocation {
  readonly aggregate: string;
  readonly field: string;
}

// `aggregates` maps every state alias the generator writes, `OrderState` and `OrderCreatedState`,
// to its aggregate.
const fieldAtOffset = (
  content: string,
  offset: number,
  aggregates: ReadonlyMap<string, string>,
): FieldLocation | null => {
  const before = content.slice(0, offset);
  const line = before.split("\n").length - 1;
  const lines = content.split("\n");
  let aggregate: string | null = null;
  // A field's type may run over several lines: what is diagnosed on any of them is the field's.
  let field: string | null = null;
  for (let index = 0; index <= line && index < lines.length; index += 1) {
    const current = lines[index] ?? "";
    const start = /^export type (\w+) = \{$/.exec(current);
    if (start?.[1] !== undefined) {
      aggregate = aggregates.get(start[1]) ?? null;
      field = null;
    }
    const own = /^ {2}readonly (\w+)\??: /.exec(current);
    if (own?.[1] !== undefined) field = own[1];
    if (current.startsWith("}")) {
      aggregate = null;
      field = null;
    }
    if (index === line) {
      return aggregate !== null && field !== null ? { aggregate, field } : null;
    }
  }
  return null;
};

// What TypeScript reads as `.bounda/types.ts`, in place of the file on disk.
interface TypesInMemory {
  content: string;
}

const openProject = async (
  root: string,
  tsconfigPath: string,
  typesPath: string,
  types: TypesInMemory,
): Promise<
  | {
      readonly checkers: Checkers;
      readonly sync: typeof import("typescript/unstable/sync");
      readonly ts: typeof import("typescript/unstable/ast");
    }
  | string
> => {
  let sync: typeof import("typescript/unstable/sync");
  let ts: typeof import("typescript/unstable/ast");
  try {
    sync = await import("typescript/unstable/sync");
    ts = await import("typescript/unstable/ast");
  } catch {
    return "TypeScript 7 is not installed; the generator needs it to infer state without state.ts";
  }
  const api = new sync.API({
    cwd: root,
    fs: { readFile: (fileName) => (resolve(fileName) === typesPath ? types.content : undefined) },
  });
  try {
    api.parseConfigFile(tsconfigPath);
    const snapshot = api.updateSnapshot({ openProjects: [tsconfigPath] });
    const project = snapshot.getProject(tsconfigPath) ?? snapshot.getProjects()[0];
    if (project === undefined) {
      api.close();
      return `no TypeScript project could be opened from ${tsconfigPath}`;
    }
    const typesFile = project.program.getSourceFile(typesPath);
    if (typesFile === undefined) {
      api.close();
      return `${typesPath} is not part of the TypeScript project at ${tsconfigPath}; include it so state can be inferred`;
    }
    const enclosing = typesFile.statements[typesFile.statements.length - 1] ?? typesFile;
    return { checkers: { api, project, enclosing }, sync, ts };
  } catch (error) {
    api.close();
    return `TypeScript could not open ${tsconfigPath}: ${error instanceof Error ? error.message : String(error)}`;
  }
};

export const inferStates: InferStatesFunction = async ({
  model,
  tsconfigPath,
  typesPath,
  typesContent,
  renderTypes,
}) => {
  const warnings: StateWarning[] = [];
  const pending = model.aggregates.filter((aggregate) => aggregate.state === null);
  if (pending.length === 0) return { states: {}, warnings };

  const types: TypesInMemory = { content: typesContent };
  const opened = await openProject(model.root, resolve(tsconfigPath), typesPath, types);
  if (typeof opened === "string") {
    for (const aggregate of pending) {
      warnings.push({
        aggregate: aggregate.name,
        message: `${opened}. State stays core.UnknownState; add ${dirname(aggregate.events[0]?.relativePath ?? aggregate.directory)}/state.ts to type it`,
      });
    }
    return { states: {}, warnings };
  }
  const { sync, ts } = opened;
  let checkers = opened.checkers;
  const aliases = new Map(
    pending.flatMap((aggregate) => [
      [stateTypeName(aggregate.name), aggregate.name],
      [createdStateTypeName(aggregate.name), aggregate.name],
    ]),
  );
  try {
    type Returns = ReadonlyMap<string, readonly EventReturns[]>;
    const readAll = (previous: Returns | null): Returns =>
      new Map(
        pending.map((aggregate) => [
          aggregate.name,
          aggregate.events.flatMap((event) => {
            const before = previous?.get(aggregate.name)?.find((read) => read.event === event);
            const returns = readReturns(sync, ts, checkers, event, before, (message) =>
              warnings.push({ aggregate: aggregate.name, message }),
            );
            return returns === null ? [] : [returns];
          }),
        ]),
      );
    const fieldsOfAll = (returns: Returns): Map<string, AggregateFields> =>
      new Map([...returns].map(([name, events]) => [name, fieldsOf(events)]));
    // The first pass reads every `evolve` against `core.UnknownState`, so a field it computes from
    // the state comes out as `any` or `unknown`. Each later pass reads those again against what
    // the one before inferred, without its `any`, until a pass learns nothing new.
    let returns = readAll(null);
    let fields = fieldsOfAll(returns);
    if ([...returns.values()].some((events) => events.some(({ readsState }) => readsState))) {
      for (let pass = 1; pass < MAX_PASSES; pass += 1) {
        const seed = renderTypes(statesOf(untainted(fields)));
        checkers = serveTypes(checkers, typesPath, types, seed);
        returns = readAll(returns);
        fields = fieldsOfAll(returns);
        if (renderTypes(statesOf(untainted(fields))) === seed) break;
      }
    }
    for (const [aggregateName, { fields: aggregateFields }] of fields) {
      for (const [name, field] of aggregateFields) {
        if (![...field.members].some((member) => TAINTED.test(member))) continue;
        warnings.push({
          aggregate: aggregateName,
          message: `field "${name}" (set by ${[...field.events].join(", ")}) is computed from the state in a way its type could not be inferred from; it is typed as unknown. Give it a type where the aggregate begins, or add state.ts`,
        });
        aggregateFields.set(name, { members: new Set([UNKNOWN]), events: field.events });
      }
    }

    let states = statesOf(fields);
    const content = renderTypes(states);
    if (content !== types.content) checkers = serveTypes(checkers, typesPath, types, content);
    const diagnostics = checkers.project.program.getSemanticDiagnostics(typesPath);
    const downgraded = new Set<string>();
    for (const diagnostic of diagnostics) {
      const location = fieldAtOffset(content, diagnostic.pos, aliases);
      if (location === null) continue;
      const aggregateName = location.aggregate;
      const aggregateFields = fields.get(aggregateName)?.fields;
      const field = aggregateFields?.get(location.field);
      if (aggregateFields === undefined || field === undefined) continue;
      const key = `${aggregateName}.${location.field}`;
      if (downgraded.has(key)) continue;
      downgraded.add(key);
      warnings.push({
        aggregate: aggregateName,
        message: `field "${location.field}" (set by ${[...field.events].join(", ")}) has a type that is not visible from .bounda/types.ts (${diagnostic.text}); it is typed as unknown. Export the type or add state.ts`,
      });
      aggregateFields.set(location.field, { members: new Set([UNKNOWN]), events: field.events });
    }
    if (downgraded.size > 0) states = statesOf(fields);
    return { states, warnings };
  } finally {
    checkers.api.close();
  }
};
