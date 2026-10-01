import { basename, dirname, join } from "node:path";
import type { AggregateModel, ProjectModel, ReadModelModel } from "../model.ts";
import { type GeneratedFile, importPath } from "./paths.ts";
import { collaboratorsTypeName, eventsTypeName, rowTypeName, stateTypeName } from "./types.ts";

export interface EmitPlusTypesArgs {
  readonly model: ProjectModel;
  /**
   * Absolute path of `.bounda/types.ts`.
   */
  readonly typesPath: string;
}

export interface EmitPlusTypesFunction {
  (args: EmitPlusTypesArgs): readonly GeneratedFile[];
}

export interface PlusTypesPathFunction {
  (modulePath: string): string;
}

/**
 * Where the `+types` file of a module goes: `commands/pay-order.ts` → `commands/+types/pay-order.ts`.
 */
export const plusTypesPath: PlusTypesPathFunction = (modulePath) =>
  join(dirname(modulePath), "+types", basename(modulePath));

const TIMEOUT_DEADLINE = "timeout";

const generic = (name: string, args: readonly string[]): string =>
  `${name}<\n${args.map((arg) => `    ${arg}`).join(",\n")}\n  >`;

interface Template {
  readonly imports: {
    readonly core?: boolean;
    readonly generated: boolean;
    readonly module: string | null;
    readonly moduleAlias?: string;
  };
  readonly extraTypes?: readonly string[];
  readonly namespace: string;
  readonly members: readonly (readonly [string, string])[];
}

const render = (path: string, typesPath: string, template: Template): GeneratedFile => {
  const lines: string[] = [];
  if (template.imports.core !== false) lines.push('import type * as core from "@bounda-dev/core";');
  if (template.imports.generated) {
    lines.push(`import type * as generated from "${importPath({ from: path, to: typesPath })}";`);
  }
  if (lines.length > 0) lines.push("");
  if (template.imports.module !== null) {
    lines.push(
      `type ${template.imports.moduleAlias ?? "Module"} = typeof import("${importPath({ from: path, to: template.imports.module })}");`,
    );
  }
  for (const extra of template.extraTypes ?? []) lines.push(extra);
  if (template.imports.module !== null || (template.extraTypes?.length ?? 0) > 0) lines.push("");
  lines.push(`export declare namespace ${template.namespace} {`);
  for (const [member, type] of template.members) lines.push(`  type ${member} = ${type};`);
  lines.push("}", "");
  return { path, content: lines.join("\n") };
};

const eventFiles = (aggregate: AggregateModel, typesPath: string): GeneratedFile[] =>
  aggregate.events.map((event) =>
    render(plusTypesPath(event.path), typesPath, {
      imports: { generated: true, module: event.path },
      namespace: "Event",
      members: [
        ["PayloadArgs", "core.PayloadArgs"],
        [
          "ApplyArgs",
          generic("core.EventApplyArgs", [
            `generated.${stateTypeName(aggregate.name)}`,
            `"${event.typeName}"`,
            "core.PayloadOf<Module>",
          ]),
        ],
        ["Upcasts", "core.Upcasts<core.PayloadOf<Module>>"],
      ],
    }),
  );

const collaboratorsType = (aggregate: AggregateModel): string =>
  `generated.${collaboratorsTypeName(aggregate.name)}`;

const implementationFiles = (aggregate: AggregateModel, typesPath: string): GeneratedFile[] =>
  aggregate.collaborators.flatMap((port) =>
    port.implementations.map((implementation) => {
      const path = plusTypesPath(implementation.path);
      return render(path, typesPath, {
        imports: { core: false, generated: false, module: null },
        extraTypes: [
          `type Port = import("${importPath({ from: path, to: port.contract.path })}").${port.typeName};`,
        ],
        namespace: "Implementation",
        members: [["Contract", "Port"]],
      });
    }),
  );

const commandFiles = (aggregate: AggregateModel, typesPath: string): GeneratedFile[] =>
  aggregate.commands.map((command) =>
    render(plusTypesPath(command.path), typesPath, {
      imports: { generated: true, module: command.path },
      namespace: "Command",
      members: [
        ["PayloadArgs", "core.PayloadArgs"],
        [
          "HandlerArgs",
          generic("core.CommandHandlerArgs", [
            `"${command.typeName}"`,
            "core.PayloadOf<Module>",
            `generated.${stateTypeName(aggregate.name)}`,
            `generated.${eventsTypeName(aggregate.name)}`,
            collaboratorsType(aggregate),
          ]),
        ],
      ],
    }),
  );

const storedEvent = (aggregate: AggregateModel, eventKey: string): string =>
  `core.StoredEventOf<generated.${eventsTypeName(aggregate.name)}, "${eventKey}">`;

const anyEvent = (aggregate: AggregateModel): string =>
  `core.StoredEventOf<generated.${eventsTypeName(aggregate.name)}, keyof generated.${eventsTypeName(aggregate.name)}>`;

const eventOf = (model: ProjectModel, aggregateName: string, eventKey: string | null): string => {
  const aggregate = model.aggregates.find((candidate) => candidate.name === aggregateName);
  if (aggregate === undefined) return "core.StoredEvent";
  return eventKey !== null && aggregate.events.some((event) => event.key === eventKey)
    ? storedEvent(aggregate, eventKey)
    : anyEvent(aggregate);
};

const policyFiles = (
  model: ProjectModel,
  aggregate: AggregateModel,
  typesPath: string,
): GeneratedFile[] =>
  aggregate.policies.map((policy) =>
    render(plusTypesPath(policy.path), typesPath, {
      imports: { generated: true, module: null },
      namespace: "Policy",
      members: [
        [
          "HandlerArgs",
          generic("core.PolicyHandlerArgs", [
            eventOf(model, policy.source ?? aggregate.name, policy.triggerKey),
            "generated.ReactionCommands",
            collaboratorsType(aggregate),
          ]),
        ],
      ],
    }),
  );

const handlerModuleType = (path: string): string =>
  `type HandlerModule = typeof import("${importPath({ from: plusTypesPath(path), to: path })}");`;

const returnCheck: readonly [string, string] = [
  "ReturnCheck",
  "core.ProcessHandlerReturnCheck<core.ProcessStateOf<ProcessModule>, HandlerModule>",
];

const processFiles = (
  model: ProjectModel,
  aggregate: AggregateModel,
  typesPath: string,
): GeneratedFile[] =>
  aggregate.processes.flatMap((process) => {
    const files = [
      render(plusTypesPath(process.path), typesPath, {
        imports: { generated: true, module: null },
        namespace: "Process",
        members: [
          ["ConfigArgs", "core.ProcessConfigArgs<generated.Events>"],
          ["StateArgs", "core.ProcessStateArgs"],
          ["Correlate", "core.ProcessCorrelate<generated.Events>"],
        ],
      }),
      ...process.handlers.map((handler) =>
        render(plusTypesPath(handler.path), typesPath, {
          imports: { generated: true, module: process.path, moduleAlias: "ProcessModule" },
          extraTypes: [handlerModuleType(handler.path)],
          namespace: "Process",
          members: [
            returnCheck,
            [
              "HandlerArgs",
              generic("core.ProcessHandlerArgs", [
                eventOf(model, handler.aggregate, handler.eventKey),
                "core.ProcessStateOf<ProcessModule>",
                "generated.ReactionCommands",
                collaboratorsType(aggregate),
              ]),
            ],
          ],
        }),
      ),
    ];
    for (const deadline of process.deadlines) {
      files.push(
        render(plusTypesPath(deadline.path), typesPath, {
          imports: { generated: true, module: process.path, moduleAlias: "ProcessModule" },
          extraTypes: [handlerModuleType(deadline.path)],
          namespace: "Process",
          members: [
            returnCheck,
            [
              "DeadlineArgs",
              generic("core.ProcessDeadlineArgs", [
                "core.ProcessStateOf<ProcessModule>",
                deadline.field === TIMEOUT_DEADLINE
                  ? "never"
                  : `core.ProcessDeadlineField<ProcessModule, ${JSON.stringify(deadline.field)}>`,
                "generated.ReactionCommands",
                collaboratorsType(aggregate),
              ]),
            ],
          ],
        }),
      );
    }
    return files;
  });

const readModelFiles = (
  model: ProjectModel,
  readModel: ReadModelModel,
  typesPath: string,
): GeneratedFile[] => {
  const row = `generated.${rowTypeName(readModel.name)}`;
  return [
    render(plusTypesPath(readModel.view.path), typesPath, {
      imports: { generated: false, module: null },
      namespace: "View",
      members: [["FieldsArgs", "core.FieldsArgs"]],
    }),
    ...readModel.projections.map((projection) => {
      const event = eventOf(model, projection.aggregate, projection.eventKey);
      return render(plusTypesPath(projection.path), typesPath, {
        imports: { generated: true, module: null },
        namespace: "Projection",
        members: [["Args", generic("core.ProjectionArgs", [event, row, "unknown"])]],
      });
    }),
    ...readModel.queries.map((query) =>
      render(plusTypesPath(query.path), typesPath, {
        imports: { generated: true, module: query.path },
        extraTypes: [`type Row = ${row};`],
        namespace: "Query",
        members: [
          ["PayloadArgs", "core.PayloadArgs"],
          [
            "RepositoryArgs",
            generic("core.QueryRepositoryArgs", ["core.PayloadOf<Module>", "Row", "unknown"]),
          ],
          [
            "HandlerArgs",
            generic("core.QueryHandlerArgs", [
              `"${query.typeName}"`,
              "core.PayloadOf<Module>",
              "core.RepositoryDataOf<Module>",
              "Row",
              "generated.Queries",
            ]),
          ],
        ],
      }),
    ),
  ];
};

/**
 * One `+types/<name>.ts` next to every user module, instantiating the generic argument types of
 * core with the maps from `.bounda/types.ts`. The same template always renders the same way:
 * these files are canonical output, not subject to the project's formatter.
 */
export const emitPlusTypes: EmitPlusTypesFunction = ({ model, typesPath }) => [
  ...model.aggregates.flatMap((aggregate) => [
    ...eventFiles(aggregate, typesPath),
    ...implementationFiles(aggregate, typesPath),
    ...commandFiles(aggregate, typesPath),
    ...policyFiles(model, aggregate, typesPath),
    ...processFiles(model, aggregate, typesPath),
  ]),
  ...model.readModels.flatMap((readModel) => readModelFiles(model, readModel, typesPath)),
];
