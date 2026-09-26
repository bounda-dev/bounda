import { basename, dirname, join } from "node:path";
import type {
  AggregateModel,
  CollaboratorOwnerModel,
  ProjectModel,
  ReadModelModel,
} from "../model.ts";
import { type GeneratedFile, importPath } from "./paths.ts";
import { eventsTypeName, infersCollaborators, rowTypeName, stateTypeName } from "./types.ts";

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

const generic = (name: string, args: readonly string[]): string =>
  args.length === 1
    ? `${name}<${args[0]}>`
    : `${name}<\n${args.map((arg) => `    ${arg}`).join(",\n")}\n  >`;

interface Template {
  readonly imports: {
    readonly generated: boolean;
    readonly module: string | null;
    readonly moduleAlias?: string;
  };
  readonly extraTypes?: readonly string[];
  readonly namespace: string;
  readonly members: readonly (readonly [string, string])[];
}

const render = (path: string, typesPath: string, template: Template): GeneratedFile => {
  const lines = ['import type * as core from "@bounda-dev/core";'];
  if (template.imports.generated) {
    lines.push(`import type * as generated from "${importPath({ from: path, to: typesPath })}";`);
  }
  lines.push("");
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

const collaboratorsType = (owner: CollaboratorOwnerModel, from: string): string =>
  owner.declaresCollaborators
    ? `import("${importPath({ from, to: owner.path })}").Collaborators`
    : infersCollaborators(owner)
      ? `generated.${owner.collaboratorsTypeName}`
      : "core.EmptyPayload";

const withCollaborators = (
  args: readonly string[],
  owner: CollaboratorOwnerModel,
  from: string,
): readonly string[] =>
  owner.collaborators.length === 0 ? args : [...args, collaboratorsType(owner, from)];

const commandFiles = (aggregate: AggregateModel, typesPath: string): GeneratedFile[] =>
  aggregate.commands.map((command) => {
    const collaborators = collaboratorsType(command, plusTypesPath(command.path));
    return render(plusTypesPath(command.path), typesPath, {
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
            collaborators,
          ]),
        ],
      ],
    });
  });

const storedEvent = (aggregate: AggregateModel, eventKey: string): string =>
  `core.StoredEventOf<generated.${eventsTypeName(aggregate.name)}, "${eventKey}">`;

const policyFiles = (aggregate: AggregateModel, typesPath: string): GeneratedFile[] =>
  aggregate.policies.map((policy) =>
    render(plusTypesPath(policy.path), typesPath, {
      imports: { generated: true, module: null },
      namespace: "Policy",
      members: [
        [
          "HandlerArgs",
          generic(
            "core.PolicyHandlerArgs",
            withCollaborators(
              [
                policy.triggerKey === null
                  ? `core.StoredEventOf<generated.${eventsTypeName(aggregate.name)}, keyof generated.${eventsTypeName(aggregate.name)}>`
                  : storedEvent(aggregate, policy.triggerKey),
                "generated.Commands",
              ],
              policy,
              plusTypesPath(policy.path),
            ),
          ),
        ],
      ],
    }),
  );

const processFiles = (aggregate: AggregateModel, typesPath: string): GeneratedFile[] =>
  aggregate.processes.flatMap((process) => {
    const files = [
      render(plusTypesPath(process.path), typesPath, {
        imports: { generated: true, module: null },
        namespace: "Process",
        members: [
          [
            "ConfigArgs",
            `core.ProcessConfigArgs<core.EventTypeNames<generated.${eventsTypeName(aggregate.name)}>>`,
          ],
          ["StateArgs", "core.ProcessStateArgs"],
        ],
      }),
      ...process.handlers.map((handler) =>
        render(plusTypesPath(handler.path), typesPath, {
          imports: { generated: true, module: process.path, moduleAlias: "ProcessModule" },
          namespace: "Process",
          members: [
            [
              "HandlerArgs",
              generic(
                "core.ProcessHandlerArgs",
                withCollaborators(
                  [
                    storedEvent(aggregate, handler.eventKey),
                    "core.ProcessStateOf<ProcessModule>",
                    "generated.Commands",
                  ],
                  process,
                  plusTypesPath(handler.path),
                ),
              ),
            ],
          ],
        }),
      ),
    ];
    if (process.timeout !== null) {
      files.push(
        render(plusTypesPath(process.timeout.path), typesPath, {
          imports: { generated: true, module: process.path, moduleAlias: "ProcessModule" },
          namespace: "Process",
          members: [
            [
              "TimeoutArgs",
              generic(
                "core.ProcessTimeoutArgs",
                withCollaborators(
                  ["core.ProcessStateOf<ProcessModule>", "generated.Commands"],
                  process,
                  plusTypesPath(process.timeout.path),
                ),
              ),
            ],
          ],
        }),
      );
    }
    return files;
  });

const eventOwner = (model: ProjectModel, eventKey: string): AggregateModel | undefined =>
  model.aggregates.find((aggregate) => aggregate.events.some((event) => event.key === eventKey));

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
      const owner = eventOwner(model, projection.eventKey);
      const event =
        owner === undefined ? "core.StoredEvent" : storedEvent(owner, projection.eventKey);
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
    ...commandFiles(aggregate, typesPath),
    ...policyFiles(aggregate, typesPath),
    ...processFiles(aggregate, typesPath),
  ]),
  ...model.readModels.flatMap((readModel) => readModelFiles(model, readModel, typesPath)),
];
