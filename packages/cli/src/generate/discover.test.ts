import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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
    events: aggregate.events.map((event) => [
      event.key,
      event.typeName,
      event.relativePath,
      event.upcasts?.relativePath ?? null,
    ]),
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
      deadlines: process.deadlines.map((deadline) => [deadline.field, deadline.relativePath]),
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
              null,
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
            ["orderCancelled", "OrderCancelled", "app/domain/order/order-cancelled.ts", null],
            ["orderPaid", "OrderPaid", "app/domain/order/order-paid.ts", null],
            [
              "orderPlaced",
              "OrderPlaced",
              "app/domain/order/order-placed.ts",
              "app/domain/order/order-placed.upcast.ts",
            ],
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
              "customerGreetOnCustomerRegistered",
              "customerRegistered",
              "app/domain/order/policies/customer/greet-on-customer-registered.ts",
            ],
            [
              "notifyOnOrderPlaced",
              "orderPlaced",
              "app/domain/order/policies/notify-on-order-placed/index.ts",
            ],
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
                [
                  "customerRegistered",
                  "app/domain/order/processes/order-payment/customer/on-customer-registered.ts",
                ],
              ],
              deadlines: [
                ["nextReminder", "app/domain/order/processes/order-payment/at-next-reminder.ts"],
                ["timeout", "app/domain/order/processes/order-payment/at-timeout.ts"],
              ],
            },
          ],
        },
      ],
      readModels: [
        {
          name: "orderSummary",
          view: "app/read/order-summary/view.ts",
          projections: [
            ["orderPaid", "app/read/order-summary/projections/order/order-paid.ts"],
            ["orderPlaced", "app/read/order-summary/projections/order/order-placed.ts"],
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
      "app/domain/order/policies/nested: a policy directory needs an index.ts",
      "app/domain/orders_v2: Aggregate names must be kebab-case (lower-case letters, digits and dashes)",
      "app/read/broken: a read model needs a view.ts with its fields",
      "app/read/order-summary/README.md: only .ts modules are allowed here",
      "app/read/order-summary/extra.ts: a read model holds view.ts and the directories projections and queries",
      "app/read/order-summary/lists: a read model holds view.ts and the directories projections and queries",
    ]);
  });

  it("ties an upcast module to the event next to it and rejects orphans", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/order-placed.upcast.ts",
      "app/domain/order/order-shipped.upcast.ts",
      "app/domain/order/Order_Paid.upcast.ts",
    ]);
    expect(await problemsOf(root)).toEqual([
      "app/domain/order/Order_Paid.upcast.ts: Event names must be kebab-case (lower-case letters, digits and dashes)",
      "app/domain/order/order-shipped.upcast.ts: an upcast module needs the event order-shipped.ts next to it",
    ]);
    const valid = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/order-placed.upcast.ts",
      "app/domain/order/order-paid.ts",
    ]);
    const model = await discoverProject({ root: valid });
    expect(relativePaths(model)).toMatchObject({
      aggregates: [
        {
          name: "order",
          events: [
            ["orderPaid", "OrderPaid", "app/domain/order/order-paid.ts", null],
            [
              "orderPlaced",
              "OrderPlaced",
              "app/domain/order/order-placed.ts",
              "app/domain/order/order-placed.upcast.ts",
            ],
          ],
        },
      ],
    });
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
      "app/read/order-summary/projections/order/Bad.ts",
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
        "app/read/order-summary/projections/order/Bad.ts: Projection names must be kebab-case (lower-case letters, digits and dashes)",
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

  it("finds collaborators of policy directories and processes", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/policies/audit-on-order-placed.ts",
      "app/domain/order/policies/mail-on-order-placed/index.ts",
      "app/domain/order/policies/mail-on-order-placed/mailer.smtp.ts",
      "app/domain/order/policies/mail-on-order-placed/mailer.memory.ts",
      "app/domain/order/processes/payment/index.ts",
      "app/domain/order/processes/payment/on-order-placed.ts",
      "app/domain/order/processes/payment/at-timeout.ts",
      "app/domain/order/processes/payment/gateway.stripe.ts",
    ]);
    await writeFile(
      join(root, "app/domain/order/processes/payment/index.ts"),
      "export interface Collaborators { gateway: unknown }\n",
    );
    const model = await discoverProject({ root });
    const [order] = model.aggregates;
    expect(
      order?.policies.map((policy) => ({
        key: policy.key,
        triggerKey: policy.triggerKey,
        directory: policy.directory === null ? null : relative(root, policy.directory),
        path: policy.relativePath,
        collaborators: policy.collaborators.map((c) => `${c.name}.${c.implementation}`),
        declares: policy.declaresCollaborators,
        typeName: policy.collaboratorsTypeName,
      })),
    ).toEqual([
      {
        key: "auditOnOrderPlaced",
        triggerKey: "orderPlaced",
        directory: null,
        path: "app/domain/order/policies/audit-on-order-placed.ts",
        collaborators: [],
        declares: false,
        typeName: "OrderAuditOnOrderPlacedPolicyCollaborators",
      },
      {
        key: "mailOnOrderPlaced",
        triggerKey: "orderPlaced",
        directory: "app/domain/order/policies/mail-on-order-placed",
        path: "app/domain/order/policies/mail-on-order-placed/index.ts",
        collaborators: ["mailer.memory", "mailer.smtp"],
        declares: false,
        typeName: "OrderMailOnOrderPlacedPolicyCollaborators",
      },
    ]);
    const [payment] = order?.processes ?? [];
    expect(payment?.handlers.map((handler) => handler.eventKey)).toEqual(["orderPlaced"]);
    expect(payment?.deadlines.map((deadline) => deadline.relativePath)).toEqual([
      "app/domain/order/processes/payment/at-timeout.ts",
    ]);
    expect(payment?.collaborators.map((c) => `${c.name}.${c.implementation}`)).toEqual([
      "gateway.stripe",
    ]);
    expect(payment?.declaresCollaborators).toBe(true);
    expect(payment?.collaboratorsTypeName).toBe("OrderPaymentProcessCollaborators");
  });

  it("rejects misplaced policy collaborators, policies defined twice and reserved names", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/policies/mailer.smtp.ts",
      "app/domain/order/policies/audit-on-order-placed.ts",
      "app/domain/order/policies/mail-on-order-placed.ts",
      "app/domain/order/policies/Bad_Policy/index.ts",
      "app/domain/order/policies/mail-on-order-placed/index.ts",
      "app/domain/order/policies/sync-on-order-placed/index.ts",
      "app/domain/order/policies/sync-on-order-placed/commands.http.ts",
      "app/domain/order/policies/sync-on-order-placed/signal.http.ts",
      "app/domain/order/policies/sync-on-order-placed/deep/",
      "app/domain/order/commands/place-order/index.ts",
      "app/domain/order/commands/place-order/idempotency-key.fixed.ts",
      "app/domain/order/processes/payment/index.ts",
      "app/domain/order/processes/payment/aggregate-id.memory.ts",
      "app/domain/order/processes/payment/after.memory.ts",
      "app/domain/order/processes/payment/signal.memory.ts",
    ]);
    expect(await problemsOf(root)).toEqual([
      'app/domain/order/commands/place-order/idempotency-key.fixed.ts: a command handler already receives "idempotencyKey"; give the collaborator another name',
      "app/domain/order/policies/mailer.smtp.ts: collaborators live inside the policy's directory",
      "app/domain/order/policies/Bad_Policy: Policy names must be kebab-case (lower-case letters, digits and dashes)",
      'app/domain/order/policies/mail-on-order-placed: policy "mailOnOrderPlaced" is also defined as mail-on-order-placed.ts',
      "app/domain/order/policies/sync-on-order-placed/deep: a policy directory holds only index.ts and collaborators",
      'app/domain/order/policies/sync-on-order-placed/commands.http.ts: a policy handler already receives "commands"; give the collaborator another name',
      'app/domain/order/policies/sync-on-order-placed/signal.http.ts: a policy handler already receives "signal"; give the collaborator another name',
      'app/domain/order/processes/payment/after.memory.ts: a process handler already receives "after"; give the collaborator another name',
      'app/domain/order/processes/payment/aggregate-id.memory.ts: a process handler already receives "aggregateId"; give the collaborator another name',
      'app/domain/order/processes/payment/signal.memory.ts: a process handler already receives "signal"; give the collaborator another name',
    ]);
  });

  it("finds a process's handlers for other aggregates' events in folders named after them", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/processes/checkout/index.ts",
      "app/domain/order/processes/checkout/on-order-placed.ts",
      "app/domain/order/processes/checkout/payment/on-payment-failed.ts",
      "app/domain/payment/payment-failed.ts",
    ]);
    const model = await discoverProject({ root });
    const order = model.aggregates.find((aggregate) => aggregate.name === "order");
    expect(
      order?.processes[0]?.handlers.map((handler) => [handler.aggregate, handler.eventKey]),
    ).toEqual([
      ["order", "orderPlaced"],
      ["payment", "paymentFailed"],
    ]);
  });

  it("rejects handlers of events another aggregate lacks and misplaced aggregate folders", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/processes/checkout/index.ts",
      "app/domain/order/processes/checkout/order/on-order-placed.ts",
      "app/domain/order/processes/checkout/payment/on-payment-lost.ts",
      "app/domain/order/processes/checkout/payment/payment-failed.ts",
      "app/domain/order/processes/checkout/payment/deeper/",
      "app/domain/order/processes/checkout/payment/notes.md",
      "app/domain/order/policies/payment/notes.md",
      "app/domain/payment/payment-failed.ts",
      "app/read/payments/view.ts",
      "app/read/payments/projections/payment/notes.md",
    ]);
    expect(await problemsOf(root)).toEqual([
      "app/domain/order/policies/payment/notes.md: only .ts modules are allowed here",
      "app/domain/order/processes/checkout/order: these are order's own events; put their handlers in the process directory",
      "app/domain/order/processes/checkout/payment/notes.md: only .ts modules are allowed here",
      "app/domain/order/processes/checkout/payment/deeper: a folder of another aggregate's handlers holds only on-<event>.ts",
      "app/domain/order/processes/checkout/payment/payment-failed.ts: process handlers are named on-<event>.ts",
      "app/read/payments/projections/payment/notes.md: only .ts modules are allowed here",
      'app/domain/order/processes/checkout/payment/on-payment-lost.ts: "paymentLost" is not an event of the aggregate "payment"',
    ]);
  });

  it("reads on-timeout.ts as the handler of an aggregate's Timeout event", async () => {
    const root = await project([
      "app/domain/order/timeout.ts",
      "app/domain/order/processes/payment/index.ts",
      "app/domain/order/processes/payment/on-timeout.ts",
    ]);
    expect(await problemsOf(root)).toEqual([]);
    const model = await discoverProject({ root });
    expect(model.aggregates[0]?.processes[0]?.handlers.map((handler) => handler.eventKey)).toEqual([
      "timeout",
    ]);
  });

  it("rejects process handlers that do not match an event of the aggregate", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/processes/payment/index.ts",
      "app/domain/order/processes/payment/on-order-placed.ts",
      "app/domain/order/processes/payment/on-order-shipped.ts",
      "app/domain/order/processes/payment/order-paid.ts",
      "app/domain/order/processes/payment/on-timeout.ts",
      "app/domain/order/processes/payment/steps/",
      "app/domain/order/processes/loose.ts",
      "app/domain/order/processes/empty/",
    ]);
    expect(await problemsOf(root)).toEqual([
      "app/domain/order/processes/loose.ts: a process is a directory with an index.ts",
      "app/domain/order/processes/empty: a process directory needs an index.ts with its config",
      "app/domain/order/processes/payment/steps: a process directory holds only index.ts, on-*.ts and at-*.ts handlers, collaborators and folders named after other aggregates",
      'app/domain/order/processes/payment/on-order-shipped.ts: "orderShipped" is not an event of this aggregate',
      "app/domain/order/processes/payment/on-timeout.ts: the timeout handler is at-timeout.ts now; rename the file",
      "app/domain/order/processes/payment/order-paid.ts: process handlers are named on-<event>.ts or at-<deadline>.ts",
    ]);
  });

  it("puts projections in folders named after aggregates and rejects anything else", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/read/order-summary/view.ts",
      "app/read/order-summary/projections/order/order-placed.ts",
      "app/read/order-summary/projections/order/deeper/",
      "app/read/order-summary/projections/order-placed.ts",
      "app/read/order-summary/projections/nested/",
      "app/read/order-summary/queries/get-order.ts",
      "app/read/order-summary/queries/Nested/",
    ]);
    expect(await problemsOf(root)).toEqual([
      "app/read/order-summary/projections/order-placed.ts: a projection lives in a folder named after the aggregate whose event it projects: projections/<aggregate>/<event>.ts",
      'app/read/order-summary/projections/nested: "nested" is not an aggregate of the app',
      "app/read/order-summary/projections/order/deeper: projections are single modules; directories are not allowed here",
      "app/read/order-summary/queries/Nested: queries are single modules; directories are not allowed here",
    ]);
  });

  it("finds the policies an aggregate keeps for another aggregate's events", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/policies/notify-on-order-placed.ts",
      "app/domain/order/policies/payment/refund-on-payment-failed.ts",
      "app/domain/order/policies/payment/charge-on-payment-requested/index.ts",
      "app/domain/order/policies/payment/charge-on-payment-requested/gateway.fake.ts",
      "app/domain/payment/payment-failed.ts",
      "app/domain/payment/payment-requested.ts",
      "app/read/payments/view.ts",
      "app/read/payments/projections/payment/payment-failed.ts",
    ]);
    const model = await discoverProject({ root });
    const order = model.aggregates.find((aggregate) => aggregate.name === "order");
    expect(
      order?.policies.map((policy) => [
        policy.key,
        policy.source,
        policy.triggerKey,
        policy.collaborators.length,
        policy.collaboratorsTypeName,
      ]),
    ).toEqual([
      [
        "notifyOnOrderPlaced",
        null,
        "orderPlaced",
        0,
        "OrderNotifyOnOrderPlacedPolicyCollaborators",
      ],
      [
        "paymentChargeOnPaymentRequested",
        "payment",
        "paymentRequested",
        1,
        "OrderPaymentChargeOnPaymentRequestedPolicyCollaborators",
      ],
      [
        "paymentRefundOnPaymentFailed",
        "payment",
        "paymentFailed",
        0,
        "OrderPaymentRefundOnPaymentFailedPolicyCollaborators",
      ],
    ]);
    expect(model.readModels[0]?.projections.map((projection) => projection.aggregate)).toEqual([
      "payment",
    ]);
  });

  it("rejects an aggregate's own folder and aggregate folders inside another's", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/policies/order/notify-on-order-placed.ts",
      "app/domain/order/policies/payment/customer/x.ts",
      "app/domain/order/policies/payment/index.ts",
      "app/domain/customer/customer-registered.ts",
      "app/domain/payment/payment-failed.ts",
    ]);
    expect(await problemsOf(root)).toEqual([
      "app/domain/order/policies/order: these are order's own policies; put them in policies/ directly",
      'app/domain/order/policies/payment/index.ts: "payment" is an aggregate, so policies/payment/ holds policies for its events; name the policy differently',
      "app/domain/order/policies/payment/customer: a folder of another aggregate's policies holds policies, not more aggregates",
    ]);
  });

  it("formats the error message with every problem", async () => {
    const root = await project(["app/domain/orders_v2/x.ts"]);
    await expect(discoverProject({ root })).rejects.toThrow(
      /1 problem in the project layout:\n {2}.*app\/domain\/orders_v2: Aggregate names must be kebab-case/,
    );
  });
});
