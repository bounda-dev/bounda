import { dirname, resolve } from "node:path";
import { createdStateTypeName, type StateTypeSource, stateTypeName } from "../emit/types.ts";
import type { AggregateModel, EventModel, ProjectModel } from "../model.ts";

/**
 * Something inference could not do for an aggregate, which still gets a usable `State`.
 */
export interface StateWarning {
  readonly aggregate: string;
  readonly message: string;
}

export interface InferStatesArgs {
  readonly model: ProjectModel;
  readonly tsconfigPath: string;
  /**
   * Absolute path of `.bounda/types.ts`, which must exist so the project includes it. TypeScript
   * reads it from memory, never from disk, so nothing is written while states are inferred.
   */
  readonly typesPath: string;
  /**
   * The first-pass content of `.bounda/types.ts`: typing every state to infer as
   * `core.UnknownState` is what makes each `evolve` return only the fields it sets.
   */
  readonly typesContent: string;
  /**
   * Renders `.bounda/types.ts` for a set of inferred states; what it renders is type-checked.
   */
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

const collectFields = (
  sync: typeof import("typescript/unstable/sync"),
  ts: typeof import("typescript/unstable/ast"),
  checkers: Checkers,
  aggregate: AggregateModel,
  warn: (message: string) => void,
): AggregateFields => {
  const fields: Fields = new Map();
  // What each `begin` always sets.
  const opening: ReadonlySet<string>[] = [];
  const { checker, program, emitter } = checkers.project;
  const flags = sync.NodeBuilderFlags.NoTruncation | sync.NodeBuilderFlags.UseFullyQualifiedType;
  const maybeAbsent =
    sync.TypeFlags.Any | sync.TypeFlags.Unknown | sync.TypeFlags.Undefined | sync.TypeFlags.Void;
  const addField = (event: EventModel, name: string, type: string) => {
    const existing = fields.get(name) ?? { members: new Set<string>(), events: new Set<string>() };
    existing.members.add(type);
    existing.events.add(event.key);
    fields.set(name, existing);
  };
  const returnedBy = (
    event: EventModel,
    file: import("typescript/unstable/ast").SourceFile,
    exportName: "evolve" | "begin",
  ) => {
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
    return checker.getPropertiesOfType(returned);
  };
  for (const event of aggregate.events) {
    const file = program.getSourceFile(event.path);
    if (file === undefined) {
      warn(
        `${event.relativePath} is not part of the TypeScript project, so its begin and evolve were skipped`,
      );
      continue;
    }
    for (const exportName of ["begin", "evolve"] as const) {
      const properties = returnedBy(event, file, exportName);
      if (properties === null) continue;
      const always = new Set<string>();
      for (const property of properties) {
        const propertyType = checker.getTypeOfSymbol(property);
        const node =
          propertyType === undefined
            ? undefined
            : checker.typeToTypeNode(propertyType, checkers.enclosing, flags);
        addField(event, property.name, node === undefined ? UNKNOWN : emitter.printNode(node));
        const absent =
          (property.flags & sync.SymbolFlags.Optional) !== 0 ||
          propertyType === undefined ||
          [
            propertyType,
            ...(propertyType.isUnionType() ? (propertyType.getTypes() ?? []) : []),
          ].some((member) => (member.flags & maybeAbsent) !== 0);
        if (!absent) always.add(property.name);
      }
      if (exportName === "begin") opening.push(always);
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

/**
 * Infers `State` for every aggregate without `state.ts` from what its events' exported `begin`
 * and `evolve` functions return, each field typed as the union of what they set. Every field is
 * optional, unless an event exports `begin`: then the state is the created one, where the
 * fields every `begin` always sets are required, or `core.NotCreated` of it. Writes nothing:
 * the caller renders `typesPath` from the states it returns. A field whose type is not visible from there (a non-exported interface, say)
 * becomes `unknown` with a warning; when TypeScript cannot run on the project, every such
 * aggregate keeps `core.UnknownState`, with a warning each.
 */
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
  const { checkers, sync, ts } = opened;
  const aliases = new Map(
    pending.flatMap((aggregate) => [
      [stateTypeName(aggregate.name), aggregate.name],
      [createdStateTypeName(aggregate.name), aggregate.name],
    ]),
  );
  try {
    const fields = new Map<string, AggregateFields>();
    for (const aggregate of pending) {
      fields.set(
        aggregate.name,
        collectFields(sync, ts, checkers, aggregate, (message) =>
          warnings.push({ aggregate: aggregate.name, message }),
        ),
      );
    }
    const render = (): Readonly<Record<string, StateTypeSource>> =>
      Object.fromEntries(
        [...fields.entries()].map(([name, aggregateFields]) => [
          name,
          { inferred: renderState(aggregateFields), created: aggregateFields.required !== null },
        ]),
      );

    let states = render();
    const content = renderTypes(states);
    types.content = content;
    const validated = checkers.api.updateSnapshot({ fileChanges: { changed: [typesPath] } });
    const project =
      validated.getProject(checkers.project.configFileName) ?? validated.getProjects()[0];
    const diagnostics = project?.program.getSemanticDiagnostics(typesPath) ?? [];
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
    if (downgraded.size > 0) states = render();
    return { states, warnings };
  } finally {
    checkers.api.close();
  }
};
