import { dirname, resolve } from "node:path";
import type { StateTypeSource } from "../emit/types.ts";
import type { AggregateModel, EventModel, ProjectModel } from "../model.ts";

/**
 * Something the inference could not do for an aggregate; the generator still produces a usable
 * `State` and reports these.
 */
export interface StateWarning {
  readonly aggregate: string;
  readonly message: string;
}

export interface InferStatesArgs {
  readonly model: ProjectModel;
  /**
   * The project's `tsconfig.json`; the checker opens the project from it.
   */
  readonly tsconfigPath: string;
  /**
   * Absolute path of `.bounda/types.ts`. Its first-pass content, with `core.UnknownState` for
   * every aggregate without `state.ts`, must already be on disk.
   */
  readonly typesPath: string;
  /**
   * Renders `.bounda/types.ts` for a set of inferred states; used for the second pass and for
   * the validation of what it produced.
   */
  readonly renderTypes: (states: Readonly<Record<string, StateTypeSource>>) => string;
  /**
   * Writes a generated file.
   */
  readonly write: (path: string, content: string) => Promise<void>;
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

interface Checkers {
  readonly api: import("typescript/unstable/sync").API;
  readonly project: import("typescript/unstable/sync").Project;
  readonly enclosing: import("typescript/unstable/ast").Node;
}

const UNKNOWN = "unknown";

const renderState = (fields: Fields): string => {
  const names = [...fields.keys()].sort();
  if (names.length === 0) return "Record<never, never>";
  const lines = names.map((name) => {
    const members = [...(fields.get(name) as FieldTypes).members].sort();
    const type = members
      .join(" | ")
      .split("\n")
      .map((line, index) => (index === 0 || line.startsWith(" ") ? line : `  ${line}`))
      .join("\n");
    return `  readonly ${name}?: ${type};`;
  });
  return `{\n${lines.join("\n")}\n}`;
};

const exportedApply = (
  ts: typeof import("typescript/unstable/ast"),
  file: import("typescript/unstable/ast").SourceFile,
): import("typescript/unstable/ast").Node | null => {
  for (const statement of file.statements) {
    const isExported = (statement as { modifiers?: readonly { kind: number }[] }).modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!isExported) continue;
    if (statement.kind === ts.SyntaxKind.VariableStatement) {
      for (const declaration of (statement as import("typescript/unstable/ast").VariableStatement)
        .declarationList.declarations) {
        if (declaration.name.getText(file) === "apply") return declaration.name;
      }
    }
    if (statement.kind === ts.SyntaxKind.FunctionDeclaration) {
      const name = (statement as import("typescript/unstable/ast").FunctionDeclaration).name;
      if (name !== undefined && name.getText(file) === "apply") return name;
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
): Fields => {
  const fields: Fields = new Map();
  const { checker, program, emitter } = checkers.project;
  const flags = sync.NodeBuilderFlags.NoTruncation | sync.NodeBuilderFlags.UseFullyQualifiedType;
  const addField = (event: EventModel, name: string, type: string) => {
    const existing = fields.get(name) ?? { members: new Set<string>(), events: new Set<string>() };
    existing.members.add(type);
    existing.events.add(event.key);
    fields.set(name, existing);
  };
  for (const event of aggregate.events) {
    const file = program.getSourceFile(event.path);
    if (file === undefined) {
      warn(`${event.relativePath} is not part of the TypeScript project, so its apply was skipped`);
      continue;
    }
    const applyName = exportedApply(ts, file);
    if (applyName === null) continue;
    const symbol = checker.getSymbolAtLocation(applyName);
    const applyType = symbol === undefined ? undefined : checker.getTypeOfSymbol(symbol);
    const signature =
      applyType === undefined
        ? undefined
        : checker.getSignaturesOfType(applyType, sync.SignatureKind.Call)[0];
    const returned =
      signature === undefined ? undefined : checker.getReturnTypeOfSignature(signature);
    if (returned === undefined) {
      warn(`${event.relativePath}: apply has no call signature, so it was skipped`);
      continue;
    }
    for (const property of checker.getPropertiesOfType(returned)) {
      const propertyType = checker.getTypeOfSymbol(property);
      const node =
        propertyType === undefined
          ? undefined
          : checker.typeToTypeNode(propertyType, checkers.enclosing, flags);
      addField(event, property.name, node === undefined ? UNKNOWN : emitter.printNode(node));
    }
  }
  return fields;
};

interface FieldLocation {
  readonly aggregate: string;
  readonly field: string;
}

const fieldAtOffset = (content: string, offset: number): FieldLocation | null => {
  const before = content.slice(0, offset);
  const line = before.split("\n").length - 1;
  const lines = content.split("\n");
  let aggregate: string | null = null;
  for (let index = 0; index <= line && index < lines.length; index += 1) {
    const current = lines[index] ?? "";
    const start = /^export type (\w+)State = \{$/.exec(current);
    if (start?.[1] !== undefined) aggregate = start[1];
    if (/^\}?;?$/.test(current) && current.startsWith("}"))
      aggregate = index === line ? aggregate : null;
    if (index === line && aggregate !== null) {
      const field = /^ {2}readonly (\w+)\?: /.exec(current);
      if (field?.[1] !== undefined) return { aggregate, field: field[1] };
    }
  }
  return null;
};

const openProject = async (
  root: string,
  tsconfigPath: string,
  typesPath: string,
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
  const api = new sync.API({ cwd: root });
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
 * Infers `State` for every aggregate without `state.ts` from the return types of its events'
 * `apply` functions, using the TypeScript checker. Two passes: the first-pass `.bounda/types.ts`
 * (already on disk) types `state` as `core.UnknownState`, so each `apply` returns exactly the
 * fields it sets; those are collected, unioned per field and written back as a literal type with
 * every field optional. The result is then type-checked, and a field whose type is not reachable
 * from `.bounda/types.ts` (for example a non-exported interface) becomes `unknown` with a
 * warning. When the checker cannot run at all, every such aggregate keeps `core.UnknownState`.
 */
export const inferStates: InferStatesFunction = async ({
  model,
  tsconfigPath,
  typesPath,
  renderTypes,
  write,
}) => {
  const warnings: StateWarning[] = [];
  const pending = model.aggregates.filter((aggregate) => aggregate.state === null);
  if (pending.length === 0) return { states: {}, warnings };

  const opened = await openProject(model.root, resolve(tsconfigPath), typesPath);
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
  try {
    const fields = new Map<string, Fields>();
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
          { inferred: renderState(aggregateFields) },
        ]),
      );

    let states = render();
    let content = renderTypes(states);
    await write(typesPath, content);
    const validated = checkers.api.updateSnapshot({ fileChanges: { changed: [typesPath] } });
    const project =
      validated.getProject(checkers.project.configFileName) ?? validated.getProjects()[0];
    const diagnostics = project?.program.getSemanticDiagnostics(typesPath) ?? [];
    const downgraded = new Set<string>();
    for (const diagnostic of diagnostics) {
      const location = fieldAtOffset(content, diagnostic.pos);
      if (location === null) continue;
      const aggregateName =
        location.aggregate.charAt(0).toLowerCase() + location.aggregate.slice(1);
      const aggregateFields = fields.get(aggregateName);
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
    if (downgraded.size > 0) {
      states = render();
      content = renderTypes(states);
      await write(typesPath, content);
    }
    return { states, warnings };
  } finally {
    checkers.api.close();
  }
};
