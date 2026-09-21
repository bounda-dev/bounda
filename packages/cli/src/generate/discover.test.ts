import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverProject } from "./discover.ts";
import type { ProjectModel } from "./model.ts";
import { ConventionError } from "./problems.ts";

const fixtureRoot = resolve(import.meta.dirname, "../../../core/test-types/fixtures/order-app");

const temporaryRoots: string[] = [];

const project = async (files: readonly string[]): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bounda-discover-"));
  temporaryRoots.push(root);
  for (const file of files) {
    const path = join(root, file);
    if (file.endsWith("/")) {
      await mkdir(path, { recursive: true });
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "export {};\n");
  }
  return root;
};

const problemsOf = async (root: string): Promise<readonly string[]> => {
  try {
    await discoverProject({ root });
  } catch (error) {
    if (error instanceof ConventionError) {
      return error.problems.map(
        (problem) => `${problem.path.slice(root.length + 1)}: ${problem.message}`,
      );
    }
    throw error;
  }
  return [];
};

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

const relativePaths = (model: ProjectModel): Record<string, unknown> => ({
  aggregates: model.aggregates.map((aggregate) => ({
    name: aggregate.name,
    state: aggregate.state?.relativePath ?? null,
    events: aggregate.events.map((event) => [event.key, event.typeName, event.relativePath]),
    commands: aggregate.commands.map((command) => ({
      key: command.key,
      typeName: command.typeName,
      path: command.relativePath,
      directory: command.directory === null ? null : command.directory.slice(model.root.length + 1),
      declaresCollaborators: command.declaresCollaborators,
      collaborators: command.collaborators.map((collaborator) => [
        collaborator.name,
        collaborator.implementation,
        collaborator.relativePath,
      ]),
    })),
    policies: aggregate.policies.map((policy) => [
      policy.key,
      policy.triggerKey,
      policy.relativePath,
    ]),
    processes: aggregate.processes.map((process) => ({
      key: process.key,
      typeName: process.typeName,
      path: process.relativePath,
      handlers: process.handlers.map((handler) => [handler.eventKey, handler.relativePath]),
      timeout: process.timeout?.relativePath ?? null,
    })),
  })),
  readModels: model.readModels.map((readModel) => ({
    name: readModel.name,
    view: readModel.view.relativePath,
    projections: readModel.projections.map((projection) => [
      projection.eventKey,
      projection.relativePath,
    ]),
    queries: readModel.queries.map((query) => [query.key, query.typeName, query.relativePath]),
  })),
});

describe("discoverProject on the order-app fixture", () => {
  it("finds every module by convention, in a stable order", async () => {
    const model = await discoverProject({ root: fixtureRoot });
    expect(model.root).toBe(fixtureRoot);
    expect(model.appDir).toBe("app");
    expect(relativePaths(model)).toEqual({
      aggregates: [
        {
          name: "customer",
          state: "app/domain/customer/state.ts",
          events: [
            [
              "customerRegistered",
              "CustomerRegistered",
              "app/domain/customer/customer-registered.ts",
            ],
          ],
          commands: [
            {
              key: "registerCustomer",
              declaresCollaborators: false,
              typeName: "RegisterCustomer",
              path: "app/domain/customer/commands/register-customer.ts",
              directory: null,
              collaborators: [],
            },
          ],
          policies: [],
          processes: [],
        },
        {
          name: "order",
          state: "app/domain/order/state.ts",
          events: [
            ["orderCancelled", "OrderCancelled", "app/domain/order/order-cancelled.ts"],
            ["orderPaid", "OrderPaid", "app/domain/order/order-paid.ts"],
            ["orderPlaced", "OrderPlaced", "app/domain/order/order-placed.ts"],
          ],
          commands: [
            {
              key: "cancelOrder",
              declaresCollaborators: false,
              typeName: "CancelOrder",
              path: "app/domain/order/commands/cancel-order/index.ts",
              directory: "app/domain/order/commands/cancel-order",
              collaborators: [
                [
                  "auditLog",
                  "memory",
                  "app/domain/order/commands/cancel-order/audit-log.memory.ts",
                ],
              ],
            },
            {
              key: "payOrder",
              declaresCollaborators: false,
              typeName: "PayOrder",
              path: "app/domain/order/commands/pay-order.ts",
              directory: null,
              collaborators: [],
            },
            {
              key: "placeOrder",
              declaresCollaborators: true,
              typeName: "PlaceOrder",
              path: "app/domain/order/commands/place-order/index.ts",
              directory: "app/domain/order/commands/place-order",
              collaborators: [
                ["inventory", "fake", "app/domain/order/commands/place-order/inventory.fake.ts"],
              ],
            },
          ],
          policies: [
            [
              "sendReceiptOnOrderPaid",
              "orderPaid",
              "app/domain/order/policies/send-receipt-on-order-paid.ts",
            ],
          ],
          processes: [
            {
              key: "orderPayment",
              typeName: "OrderPayment",
              path: "app/domain/order/processes/order-payment/index.ts",
              handlers: [
                ["orderPaid", "app/domain/order/processes/order-payment/on-order-paid.ts"],
              ],
              timeout: "app/domain/order/processes/order-payment/on-timeout.ts",
            },
          ],
        },
      ],
      readModels: [
        {
          name: "orderSummary",
          view: "app/read/order-summary/view.ts",
          projections: [
            ["orderPaid", "app/read/order-summary/projections/order-paid.ts"],
            ["orderPlaced", "app/read/order-summary/projections/order-placed.ts"],
          ],
          queries: [
            [
              "customerOverview",
              "CustomerOverview",
              "app/read/order-summary/queries/customer-overview.ts",
            ],
            ["getOrder", "GetOrder", "app/read/order-summary/queries/get-order.ts"],
            [
              "listUnpaidOrders",
              "ListUnpaidOrders",
              "app/read/order-summary/queries/list-unpaid-orders.ts",
            ],
          ],
        },
      ],
    });
  });

  it("ignores +types, tests, declarations and underscored files", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/order-placed.test.ts",
      "app/domain/order/order-placed.test-d.ts",
      "app/domain/order/types.d.ts",
      "app/domain/order/_draft.ts",
      "app/domain/order/+types/order-placed.ts",
      "app/domain/order/commands/+types/",
      "app/domain/order/.hidden/",
      "app/read/summary/view.ts",
      "app/read/summary/+types/view.ts",
    ]);
    const model = await discoverProject({ root });
    expect(model.aggregates[0]?.events.map((event) => event.key)).toEqual(["orderPlaced"]);
    expect(model.aggregates[0]?.state).toBeNull();
    expect(model.readModels[0]?.projections).toEqual([]);
  });

  it("ignores what is not domain/ or read/ at the application root", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/read/summary/view.ts",
      "app/routes/home.tsx",
      "app/routes.ts",
      "app/root.tsx",
      "app/app.css",
      "app/bounda.server.ts",
    ]);
    const model = await discoverProject({ root });
    expect(model.aggregates.map((aggregate) => aggregate.name)).toEqual(["order"]);
    expect(model.readModels.map((readModel) => readModel.name)).toEqual(["summary"]);
  });

  it("accepts an app with only one side and a custom appDir", async () => {
    const root = await project(["src/read/summary/view.ts"]);
    const model = await discoverProject({ root, appDir: "src" });
    expect(model.aggregates).toEqual([]);
    expect(model.readModels.map((readModel) => readModel.name)).toEqual(["summary"]);
  });
});

describe("discoverProject convention problems", () => {
  it("fails when the application directory is missing", async () => {
    const root = await project([]);
    expect(await problemsOf(root)).toEqual([
      `app: the application directory does not exist; expected app/ under ${root}`,
    ]);
  });

  it("reports every naming problem at once, with the offending path", async () => {
    const root = await project([
      "app/domain/orders_v2/order-placed.ts",
      "app/domain/order/orderPlaced.ts",
      "app/domain/order/commands/pay_order.ts",
      "app/domain/order/commands/audit.memory.ts",
      "app/domain/order/policies/nested/x.ts",
      "app/domain/order/notes.md",
      "app/domain/order/helpers/util.ts",
      "app/read/order-summary/view.ts",
      "app/read/order-summary/README.md",
      "app/read/order-summary/extra.ts",
      "app/read/order-summary/lists/x.ts",
      "app/read/broken/projections/order-placed.ts",
      "app/domain/loose.ts",
    ]);
    expect(await problemsOf(root)).toEqual([
      "app/domain/loose.ts: Aggregates are directories, not modules",
      "app/domain/order/notes.md: only .ts modules are allowed here",
      "app/domain/order/orderPlaced.ts: Event names must be kebab-case (lower-case letters, digits and dashes)",
      "app/domain/order/helpers: an aggregate holds events, state.ts and the directories commands, policies and processes",
      "app/domain/order/commands/audit.memory.ts: Command names must be kebab-case (lower-case letters, digits and dashes)",
      "app/domain/order/commands/pay_order.ts: Command names must be kebab-case (lower-case letters, digits and dashes)",
      "app/domain/order/policies/nested: policies are single modules; directories are not allowed here",
      "app/domain/orders_v2: Aggregate names must be kebab-case (lower-case letters, digits and dashes)",
      "app/read/broken: a read model needs a view.ts with its fields",
      "app/read/order-summary/README.md: only .ts modules are allowed here",
      "app/read/order-summary/extra.ts: a read model holds view.ts and the directories projections and queries",
      "app/read/order-summary/lists: a read model holds view.ts and the directories projections and queries",
    ]);
  });

  it("checks names and stray files in every kind of directory", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/commands/Bad.ts",
      "app/domain/order/commands/notes.md",
      "app/domain/order/commands/pay-order/index.ts",
      "app/domain/order/commands/pay-order/README.md",
      "app/domain/order/policies/Bad.ts",
      "app/domain/order/policies/notes.md",
      "app/domain/order/processes/Bad/index.ts",
      "app/domain/order/processes/notes.md",
      "app/domain/order/processes/payment/index.ts",
      "app/domain/order/processes/payment/notes.md",
      "app/read/order-summary/view.ts",
      "app/read/order-summary/projections/Bad.ts",
      "app/read/order-summary/projections/notes.md",
      "app/read/order-summary/queries/Bad.ts",
      "app/read/order-summary/queries/notes.md",
      "app/read/Bad/view.ts",
    ]);
    const problems = await problemsOf(root);
    expect(problems).toHaveLength(13);
    expect(problems).toEqual(
      expect.arrayContaining([
        "app/domain/order/commands/Bad.ts: Command names must be kebab-case (lower-case letters, digits and dashes)",
        "app/domain/order/commands/notes.md: only .ts modules are allowed here",
        "app/domain/order/commands/pay-order/README.md: only .ts modules are allowed here",
        "app/domain/order/policies/Bad.ts: Policy names must be kebab-case (lower-case letters, digits and dashes)",
        "app/domain/order/policies/notes.md: only .ts modules are allowed here",
        "app/domain/order/processes/Bad: Process names must be kebab-case (lower-case letters, digits and dashes)",
        "app/domain/order/processes/notes.md: only .ts modules are allowed here",
        "app/domain/order/processes/payment/notes.md: only .ts modules are allowed here",
        "app/read/Bad: Read model names must be kebab-case (lower-case letters, digits and dashes)",
        "app/read/order-summary/projections/Bad.ts: Projection names must be kebab-case (lower-case letters, digits and dashes)",
        "app/read/order-summary/projections/notes.md: only .ts modules are allowed here",
        "app/read/order-summary/queries/Bad.ts: Query names must be kebab-case (lower-case letters, digits and dashes)",
        "app/read/order-summary/queries/notes.md: only .ts modules are allowed here",
      ]),
    );
  });

  it("marks a command as declaring collaborators only when it has some", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/commands/declared-alone/index.ts",
      "app/domain/order/commands/declared-with/index.ts",
      "app/domain/order/commands/declared-with/audit.memory.ts",
      "app/domain/order/commands/undeclared-with/index.ts",
      "app/domain/order/commands/undeclared-with/audit.memory.ts",
    ]);
    const declaration = "export type Collaborators = { audit: unknown };\n";
    await writeFile(join(root, "app/domain/order/commands/declared-alone/index.ts"), declaration);
    await writeFile(join(root, "app/domain/order/commands/declared-with/index.ts"), declaration);
    const model = await discoverProject({ root });
    const commands = model.aggregates[0]?.commands ?? [];
    expect(commands.map((command) => [command.key, command.declaresCollaborators])).toEqual([
      ["declaredAlone", false],
      ["declaredWith", true],
      ["undeclaredWith", false],
    ]);
  });

  it("rejects a command defined twice and command directories without index.ts", async () => {
    const root = await project([
      "app/domain/order/commands/pay-order.ts",
      "app/domain/order/commands/pay-order/index.ts",
      "app/domain/order/commands/place-order/inventory.fake.ts",
      "app/domain/order/commands/cancel-order/index.ts",
      "app/domain/order/commands/cancel-order/audit-log.ts",
      "app/domain/order/commands/cancel-order/deep/",
    ]);
    expect(await problemsOf(root)).toEqual([
      "app/domain/order/commands/cancel-order/deep: a command directory holds only index.ts and collaborators",
      "app/domain/order/commands/cancel-order/audit-log.ts: expected a collaborator named <collaborator>.<implementation>.ts",
      'app/domain/order/commands/pay-order: command "payOrder" is also defined as pay-order.ts',
      "app/domain/order/commands/place-order: a command directory needs an index.ts",
    ]);
  });

  it("rejects process handlers that do not match an event of the aggregate", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/processes/payment/index.ts",
      "app/domain/order/processes/payment/on-order-placed.ts",
      "app/domain/order/processes/payment/on-order-shipped.ts",
      "app/domain/order/processes/payment/order-paid.ts",
      "app/domain/order/processes/payment/steps/",
      "app/domain/order/processes/loose.ts",
      "app/domain/order/processes/empty/",
    ]);
    expect(await problemsOf(root)).toEqual([
      "app/domain/order/processes/loose.ts: a process is a directory with an index.ts",
      "app/domain/order/processes/empty: a process directory needs an index.ts with its config",
      "app/domain/order/processes/payment/steps: a process directory holds only index.ts and on-*.ts handlers",
      'app/domain/order/processes/payment/on-order-shipped.ts: "orderShipped" is not an event of this aggregate',
      "app/domain/order/processes/payment/order-paid.ts: process handlers are named on-<event>.ts or on-timeout.ts",
    ]);
  });

  it("rejects directories under projections and queries", async () => {
    const root = await project([
      "app/read/order-summary/view.ts",
      "app/read/order-summary/projections/order-placed.ts",
      "app/read/order-summary/projections/nested/",
      "app/read/order-summary/queries/get-order.ts",
      "app/read/order-summary/queries/Nested/",
    ]);
    expect(await problemsOf(root)).toEqual([
      "app/read/order-summary/projections/nested: projections are single modules; directories are not allowed here",
      "app/read/order-summary/queries/Nested: queries are single modules; directories are not allowed here",
    ]);
  });

  it("formats the error message with every problem", async () => {
    const root = await project(["app/domain/orders_v2/x.ts"]);
    await expect(discoverProject({ root })).rejects.toThrow(
      /1 problem in the project layout:\n {2}.*app\/domain\/orders_v2: Aggregate names must be kebab-case/,
    );
  });
});
