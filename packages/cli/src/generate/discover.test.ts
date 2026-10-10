import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverProject } from "./discover.ts";
import type { ProjectModel } from "./model.ts";
import { ConventionError } from "./problems.ts";

const fixtureRoot = resolve(import.meta.dirname, "../../../core/test-types/fixtures/order-app");

const temporaryRoots: string[] = [];

// A module at an aggregate's root is an event only when it exports an event's function, so that
// is what one gets unless the test gives the content.
const contentOf = (file: string): string => {
  const module = /^[^/]+\/domain\/[^/]+\/([^/]+)\.ts$/.exec(file)?.[1];
  return module === undefined || module === "state" || module.endsWith(".upcast")
    ? "export {};\n"
    : "export const evolve = () => ({});\n";
};

const project = async (
  files: readonly (string | readonly [file: string, content: string])[],
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bounda-discover-"));
  temporaryRoots.push(root);
  for (const entry of files) {
    const [file, content] = typeof entry === "string" ? [entry, contentOf(entry)] : entry;
    const path = join(root, file);
    if (file.endsWith("/")) {
      await mkdir(path, { recursive: true });
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return root;
};

const problemsOf = async (root: string): Promise<readonly string[]> => {
  try {
    await discoverProject({ root });
  } catch (error) {
    if (error instanceof ConventionError) {
      return error.problems.map(
        (problem) => `${relative(root, problem.path).split(sep).join("/")}: ${problem.message}`,
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
    ports: aggregate.ports.map((port) => ({
      key: port.key,
      typeName: port.typeName,
      path: port.relativePath,
      implementations: port.implementations.map((implementation) => [
        implementation.name,
        implementation.relativePath,
      ]),
    })),
    commands: aggregate.commands.map((command) => [
      command.key,
      command.typeName,
      command.relativePath,
    ]),
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
    ports: readModel.ports.map((port) => [
      port.key,
      port.relativePath,
      port.implementations.map((implementation) => implementation.relativePath),
    ]),
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
          ports: [],
          commands: [
            [
              "registerCustomer",
              "RegisterCustomer",
              "app/domain/customer/commands/register-customer.ts",
            ],
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
          ports: [
            {
              key: "auditLog",
              typeName: "AuditLog",
              path: "app/domain/order/audit-log.ts",
              implementations: [["memory", "app/domain/order/infrastructure/audit-log/memory.ts"]],
            },
            {
              key: "inventory",
              typeName: "Inventory",
              path: "app/domain/order/inventory.ts",
              implementations: [
                ["fake", "app/domain/order/infrastructure/inventory/fake.ts"],
                ["http", "app/domain/order/infrastructure/inventory/http.ts"],
                ["memory", "app/domain/order/infrastructure/inventory/memory.ts"],
              ],
            },
            {
              key: "mailer",
              typeName: "Mailer",
              path: "app/domain/order/mailer.ts",
              implementations: [["memory", "app/domain/order/infrastructure/mailer/memory.ts"]],
            },
            {
              key: "reminders",
              typeName: "Reminders",
              path: "app/domain/order/reminders.ts",
              implementations: [["fake", "app/domain/order/infrastructure/reminders/fake.ts"]],
            },
          ],
          commands: [
            ["cancelOrder", "CancelOrder", "app/domain/order/commands/cancel-order.ts"],
            ["payOrder", "PayOrder", "app/domain/order/commands/pay-order.ts"],
            ["placeOrder", "PlaceOrder", "app/domain/order/commands/place-order.ts"],
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
              "app/domain/order/policies/notify-on-order-placed.ts",
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
          ports: [
            [
              "rates",
              "app/read/order-summary/rates.ts",
              ["app/read/order-summary/infrastructure/rates/fixed.ts"],
            ],
          ],
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
      "app/domain/order/commands/audit.memory.ts: a port is <port>.ts at the aggregate root; its implementations live in infrastructure/<port>/<implementation>.ts",
      "app/domain/order/commands/pay_order.ts: Command names must be kebab-case (lower-case letters, digits and dashes)",
      "app/domain/order/policies/nested: a policy is a file; a port is <port>.ts at the aggregate root; its implementations live in infrastructure/<port>/<implementation>.ts",
      "app/domain/orders_v2: Aggregate names must be kebab-case (lower-case letters, digits and dashes)",
      "app/read/broken: a read model needs a view.ts with its fields",
      "app/read/order-summary/README.md: only .ts modules are allowed here",
    ]);
  });

  it("ties an upcast module to the event next to it and rejects orphans", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/order-placed.upcast.ts",
      "app/domain/order/order-shipped.upcast.ts",
      "app/domain/order/Order_Paid.upcast.ts",
      ["app/domain/order/order-refunded.ts", "export const refund = () => ({});\n"],
      "app/domain/order/order-refunded.upcast.ts",
    ]);
    expect(await problemsOf(root)).toEqual([
      "app/domain/order/Order_Paid.upcast.ts: Event names must be kebab-case (lower-case letters, digits and dashes)",
      "app/domain/order/order-refunded.upcast.ts: order-refunded.ts is not an event: an event exports payload, begin or evolve",
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
    expect(problems).toHaveLength(12);
    expect(problems).toEqual(
      expect.arrayContaining([
        "app/domain/order/commands/Bad.ts: Command names must be kebab-case (lower-case letters, digits and dashes)",
        "app/domain/order/commands/notes.md: only .ts modules are allowed here",
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

  it("takes for an event the root module that exports an event's function, and leaves the rest alone", async () => {
    const root = await project([
      [
        "app/domain/order/order-placed.ts",
        'import type { Event } from "./+types/order-placed";\nexport const payload = ({ z }: Event.PayloadArgs) => z.object({});\nexport const begin = () => ({});\n',
      ],
      ["app/domain/order/order-paid.ts", "export function evolve() {\n  return {};\n}\n"],
      [
        "app/domain/order/order-shipped.ts",
        "const evolve = () => ({});\ninterface Shipped {}\nexport { type Shipped, evolve, };\n",
      ],
      [
        "app/domain/order/money.ts",
        "export interface Money {}\nexport const create = () => ({});\nexport const apply = () => ({});\n",
      ],
      ["app/domain/order/pricing.ts", "export async function totalOf() {\n  return 0;\n}\n"],
      [
        "app/domain/order/notes.ts",
        "// export const evolve = () => ({});\nexport type Note = string;\n",
      ],
      [
        "app/domain/order/draft.ts",
        "/*\nexport const evolve = () => ({});\n*/\nexport * from './notes.ts';\n",
      ],
      "app/domain/order/helpers/format.ts",
    ]);
    const model = await discoverProject({ root });
    expect(model.aggregates[0]?.events.map((event) => event.key)).toEqual([
      "orderPaid",
      "orderPlaced",
      "orderShipped",
    ]);
    expect(model.aggregates[0]?.ports).toEqual([]);
  });

  it("rejects a root module that exports an event's function next to anything else", async () => {
    const root = await project([
      [
        "app/domain/order/order-cancelled.ts",
        "export const evolve = () => ({});\nexport const reasons = [];\nexport function limitOf() {}\n",
      ],
      [
        "app/domain/order/discount.ts",
        "const apply = () => 0;\nexport { apply as evolve, apply };\nexport type { Discount } from './x';\n",
      ],
      [
        "app/domain/order/order-refunded.ts",
        "export const evolve = () => ({});\nexport enum Reason {}\nexport default evolve;\nexport * from './x';\n",
      ],
    ]);
    expect(await problemsOf(root)).toEqual([
      'app/domain/order/discount.ts: exports "evolve", an event\'s, and "apply" besides: an event exports only payload, begin and evolve',
      'app/domain/order/order-cancelled.ts: exports "evolve", an event\'s, and "reasons", "limitOf" besides: an event exports only payload, begin and evolve',
      'app/domain/order/order-refunded.ts: exports "evolve", an event\'s, and "Reason", "default", "*" besides: an event exports only payload, begin and evolve',
    ]);
  });

  it("warns about a module that imports its own +types without being an event, and about misspelled directories", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      [
        "app/domain/order/order-paid.ts",
        '// Paid in full.\nimport type { Event } from "./+types/order-paid";\nexport const apply = ({ state }: Event.EvolveArgs) => state;\n',
      ],
      [
        "app/domain/order/order-shipped.ts",
        "import type {\n  Event,\n} from './+types/order-shipped.js';\nexport const evolv = (_: Event.EvolveArgs) => ({});\n",
      ],
      ["app/domain/order/money.ts", "export const create = () => ({});\n"],
      [
        "app/domain/order/pricing.ts",
        'import type { Event } from "./+types/order-placed";\nexport const discountOf = (_: Event.BeginArgs) => 0;\n',
      ],
      "app/domain/order/commands/place-order.ts",
      "app/domain/order/command/place-order.ts",
      "app/domain/order/Policies/notify-on-order-placed.ts",
      "app/domain/order/policys/",
      "app/domain/order/proceses/",
      "app/domain/order/infra/",
      "app/domain/order/infrastucture/",
      "app/domain/order/common/",
      "app/domain/order/helpers/",
      "app/domain/order/model/",
    ]);
    const { warnings } = await discoverProject({ root });
    const notRead = "the generator does not read this directory; rename it to";
    expect(warnings).toEqual([
      {
        module: "order",
        message:
          "app/domain/order/order-paid.ts: imports ./+types/order-paid but exports no payload, begin or evolve, so it is not an event",
      },
      {
        module: "order",
        message:
          "app/domain/order/order-shipped.ts: imports ./+types/order-shipped but exports no payload, begin or evolve, so it is not an event",
      },
      {
        module: "order",
        message: `app/domain/order/Policies: ${notRead} policies if that is what it holds`,
      },
      {
        module: "order",
        message: `app/domain/order/command: ${notRead} commands if that is what it holds`,
      },
      {
        module: "order",
        message: `app/domain/order/infra: ${notRead} infrastructure if that is what it holds`,
      },
      {
        module: "order",
        message: `app/domain/order/infrastucture: ${notRead} infrastructure if that is what it holds`,
      },
      {
        module: "order",
        message: `app/domain/order/policys: ${notRead} policies if that is what it holds`,
      },
      {
        module: "order",
        message: `app/domain/order/proceses: ${notRead} processes if that is what it holds`,
      },
    ]);
  });

  it("finds the ports of an aggregate with their module and implementations, sorted", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      [
        "app/domain/order/notifier.ts",
        "export type Notifier = (message: string) => Promise<void>;\n",
      ],
      "app/domain/order/infrastructure/notifier/smtp.ts",
      "app/domain/order/infrastructure/notifier/in-memory.ts",
      "app/domain/order/infrastructure/notifier/_shared.ts",
      "app/domain/order/infrastructure/notifier/+types/smtp.ts",
      "app/domain/order/infrastructure/notifier/smtp.test.ts",
      [
        "app/domain/order/audit-log.ts",
        "import type { X } from './x';\nexport interface AuditLog {\n  record(entry: string): void;\n}\n",
      ],
      "app/domain/order/infrastructure/audit-log/memory.ts",
      ["app/domain/order/money.ts", "export interface Money {}\n"],
    ]);
    const model = await discoverProject({ root });
    expect(
      model.aggregates[0]?.ports.map((port) => ({
        key: port.key,
        typeName: port.typeName,
        path: relative(root, port.path),
        implementations: port.implementations.map((implementation) => [
          implementation.name,
          relative(root, implementation.path),
        ]),
      })),
    ).toEqual([
      {
        key: "auditLog",
        typeName: "AuditLog",
        path: "app/domain/order/audit-log.ts",
        implementations: [["memory", "app/domain/order/infrastructure/audit-log/memory.ts"]],
      },
      {
        key: "notifier",
        typeName: "Notifier",
        path: "app/domain/order/notifier.ts",
        implementations: [
          ["in-memory", "app/domain/order/infrastructure/notifier/in-memory.ts"],
          ["smtp", "app/domain/order/infrastructure/notifier/smtp.ts"],
        ],
      },
    ]);
    expect(model.aggregates[0]?.events.map((event) => event.key)).toEqual(["orderPlaced"]);
  });

  it("rejects a port without a module, interface or implementations, with extra entries, reserved or named like an event", async () => {
    const infrastructure = "app/domain/order/infrastructure";
    const root = await project([
      "app/domain/order/order-placed.ts",
      `${infrastructure}/order-placed/memory.ts`,
      `${infrastructure}/state/memory.ts`,
      ["app/domain/order/signal.ts", "export interface Signal {}\n"],
      `${infrastructure}/signal/memory.ts`,
      ["app/domain/order/commands.ts", "export interface Commands {}\n"],
      `${infrastructure}/commands/memory.ts`,
      `${infrastructure}/idempotency-key/memory.ts`,
      `${infrastructure}/no-port/memory.ts`,
      ["app/domain/order/no-interface.ts", "export const noInterface = 1;\n"],
      `${infrastructure}/no-interface/memory.ts`,
      ["app/domain/order/no-implementation.ts", "export interface NoImplementation {}\n"],
      `${infrastructure}/no-implementation/`,
      `${infrastructure}/Bad_Port/memory.ts`,
      ["app/domain/order/notes.ts", "export interface Notes {}\n"],
      `${infrastructure}/notes/memory.ts`,
      `${infrastructure}/notes/Bad_Impl.ts`,
      `${infrastructure}/notes/README.md`,
      `${infrastructure}/notes/deep/`,
      `${infrastructure}/loose.ts`,
      `${infrastructure}/README.md`,
    ]);
    expect(await problemsOf(root)).toEqual([
      `${infrastructure}/README.md: only .ts modules are allowed here`,
      `${infrastructure}/loose.ts: infrastructure holds one directory per port: infrastructure/<port>/<implementation>.ts`,
      `${infrastructure}/Bad_Port: Port names must be kebab-case (lower-case letters, digits and dashes)`,
      `${infrastructure}/commands: "commands" is reserved; give the port another name`,
      `${infrastructure}/idempotency-key: "idempotencyKey" is reserved; give the port another name`,
      `${infrastructure}/no-implementation: a port needs at least one implementation: infrastructure/no-implementation/<implementation>.ts`,
      "app/domain/order/no-interface.ts: must export the port's interface, named after the file: export interface NoInterface",
      `${infrastructure}/no-port: has no port: add no-port.ts at the aggregate root exporting interface NoPort`,
      `${infrastructure}/notes/README.md: only .ts modules are allowed here`,
      `${infrastructure}/notes/deep: a port's directory in infrastructure holds only its implementations`,
      `${infrastructure}/notes/Bad_Impl.ts: Implementation names must be kebab-case (lower-case letters, digits and dashes)`,
      `${infrastructure}/order-placed: order-placed.ts is an event of this aggregate; give the port another name`,
      `${infrastructure}/signal: "signal" is reserved; give the port another name`,
      `${infrastructure}/state: "state" is reserved; give the port another name`,
    ]);
  });

  it("finds a read model's ports and leaves its other modules alone", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/read/order-summary/view.ts",
      ["app/read/order-summary/rates.ts", "export type Rates = () => Promise<number>;\n"],
      "app/read/order-summary/infrastructure/rates/fixed.ts",
      "app/read/order-summary/infrastructure/rates/ecb.ts",
      ["app/read/order-summary/rounding.ts", "export const roundCents = (n: number) => n;\n"],
      "app/read/order-summary/formatting/currency.ts",
      "app/read/order-summary/queries/get-order.ts",
    ]);
    const model = await discoverProject({ root });
    expect(
      model.readModels[0]?.ports.map((port) => ({
        key: port.key,
        typeName: port.typeName,
        path: relative(root, port.path),
        implementations: port.implementations.map((implementation) => implementation.name),
      })),
    ).toEqual([
      {
        key: "rates",
        typeName: "Rates",
        path: "app/read/order-summary/rates.ts",
        implementations: ["ecb", "fixed"],
      },
    ]);
    expect(model.warnings).toEqual([]);
  });

  it("rejects a read model's port that is reserved, the view or without a module, and warns about misspelled directories", async () => {
    const infrastructure = "app/read/order-summary/infrastructure";
    const root = await project([
      "app/read/order-summary/view.ts",
      ["app/read/order-summary/table.ts", "export interface Table {}\n"],
      `${infrastructure}/table/memory.ts`,
      `${infrastructure}/view/memory.ts`,
      `${infrastructure}/repository-data/memory.ts`,
      `${infrastructure}/search/memory.ts`,
      "app/read/order-summary/query/list-orders.ts",
      "app/read/order-summary/projection/",
      "app/read/order-summary/infra/",
      ["app/read/order-summary/order-placed.ts", "export const project = () => {};\n"],
      [
        "app/read/order-summary/get-order.ts",
        "export const repository = () => null;\nexport const handler = () => null;\n",
      ],
    ]);
    expect(await problemsOf(root)).toEqual([
      `${infrastructure}/repository-data: "repositoryData" is reserved; give the port another name`,
      `${infrastructure}/search: has no port: add search.ts at the read model root exporting interface Search`,
      `${infrastructure}/table: "table" is reserved; give the port another name`,
      `${infrastructure}/view: "view" is reserved; give the port another name`,
    ]);
    await rm(join(root, "app/read/order-summary/infrastructure"), { recursive: true });
    const notRead = "the generator does not read this directory; rename it to";
    const misplaced = "which only a projection or a query does, so it is neither: move it to";
    expect((await discoverProject({ root })).warnings).toEqual([
      {
        module: "orderSummary",
        message: `app/read/order-summary/get-order.ts: exports "repository", "handler", ${misplaced} projections/<aggregate>/get-order.ts or queries/get-order.ts`,
      },
      {
        module: "orderSummary",
        message: `app/read/order-summary/order-placed.ts: exports "project", ${misplaced} projections/<aggregate>/order-placed.ts or queries/order-placed.ts`,
      },
      {
        module: "orderSummary",
        message: `app/read/order-summary/infra: ${notRead} infrastructure if that is what it holds`,
      },
      {
        module: "orderSummary",
        message: `app/read/order-summary/projection: ${notRead} projections if that is what it holds`,
      },
      {
        module: "orderSummary",
        message: `app/read/order-summary/query: ${notRead} queries if that is what it holds`,
      },
    ]);
  });

  it("rejects a read model named like an aggregate", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/read/order/view.ts",
      "app/read/order-summary/view.ts",
    ]);
    expect(await problemsOf(root)).toEqual([
      'app/read/order: "order" is also an aggregate; give the read model another name',
    ]);
  });

  it("rejects a policy and a process of one aggregate with the same name, and two policies whose keys meet", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/policies/checkout.ts",
      "app/domain/order/processes/checkout/index.ts",
      "app/domain/order/policies/payment-refund-on-payment-failed.ts",
      "app/domain/order/policies/payment/refund-on-payment-failed.ts",
      "app/domain/payment/payment-failed.ts",
      "app/domain/payment/policies/checkout.ts",
    ]);
    const distinct = "the policies and processes of an aggregate need distinct names";
    expect(await problemsOf(root)).toEqual([
      `app/domain/order/policies/payment/refund-on-payment-failed.ts: "paymentRefundOnPaymentFailed" is also the name of app/domain/order/policies/payment-refund-on-payment-failed.ts; ${distinct}, so give the policy another name`,
      `app/domain/order/processes/checkout: "checkout" is also the name of app/domain/order/policies/checkout.ts; ${distinct}, so give the process another name`,
    ]);
  });

  it("rejects command and policy directories, and port files next to commands, policies and process handlers", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/commands/pay-order.ts",
      "app/domain/order/commands/place-order/index.ts",
      "app/domain/order/commands/inventory.fake.ts",
      "app/domain/order/policies/audit-on-order-placed.ts",
      "app/domain/order/policies/mailer.smtp.ts",
      "app/domain/order/policies/mail-on-order-placed/index.ts",
      "app/domain/order/policies/payment/refund-on-payment-failed/index.ts",
      "app/domain/order/processes/payment/index.ts",
      "app/domain/order/processes/payment/gateway.stripe.ts",
      "app/domain/payment/payment-failed.ts",
    ]);
    const hint =
      "a port is <port>.ts at the aggregate root; its implementations live in infrastructure/<port>/<implementation>.ts";
    expect(await problemsOf(root)).toEqual([
      `app/domain/order/commands/place-order: a command is a file; ${hint}`,
      `app/domain/order/commands/inventory.fake.ts: ${hint}`,
      `app/domain/order/policies/mail-on-order-placed: a policy is a file; ${hint}`,
      `app/domain/order/policies/mailer.smtp.ts: ${hint}`,
      `app/domain/order/policies/payment/refund-on-payment-failed: a policy is a file; ${hint}`,
      `app/domain/order/processes/payment/gateway.stripe.ts: ${hint}`,
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
      "app/domain/order/processes/payment/steps: a process directory holds only index.ts, on-*.ts and at-*.ts handlers and folders named after other aggregates",
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
      "app/domain/order/policies/payment/charge-on-payment-requested.ts",
      "app/domain/payment/payment-failed.ts",
      "app/domain/payment/payment-requested.ts",
      "app/read/payments/view.ts",
      "app/read/payments/projections/payment/payment-failed.ts",
    ]);
    const model = await discoverProject({ root });
    const order = model.aggregates.find((aggregate) => aggregate.name === "order");
    expect(order?.policies.map((policy) => [policy.key, policy.source, policy.triggerKey])).toEqual(
      [
        ["notifyOnOrderPlaced", null, "orderPlaced"],
        ["paymentChargeOnPaymentRequested", "payment", "paymentRequested"],
        ["paymentRefundOnPaymentFailed", "payment", "paymentFailed"],
      ],
    );
    expect(model.readModels[0]?.projections.map((projection) => projection.aggregate)).toEqual([
      "payment",
    ]);
  });

  it("types a policy with the event core derives from its key, and warns when boot would refuse it", async () => {
    const root = await project([
      "app/domain/order/payment-failed.ts",
      "app/domain/order/order-placed.ts",
      "app/domain/order/policies/put-on-hold-on-payment-failed.ts",
      "app/domain/order/policies/archive-on-paymnet-failed.ts",
      [
        "app/domain/order/policies/notify-on-order-placed.ts",
        'export const on = ["OrderPlaced", "PaymentFailed"];\nexport const handler = () => {};\n',
      ],
      ["app/domain/order/policies/hold.ts", 'export const on = "PaymentFailed";\n'],
      "app/domain/order/policies/add-on/notify-on-add-on-removed.ts",
      "app/domain/order/policies/add-on/on-removed.ts",
      "app/domain/add-on/add-on-removed.ts",
      "app/domain/add-on/removed.ts",
    ]);
    const model = await discoverProject({ root });
    const order = model.aggregates.find((aggregate) => aggregate.name === "order");
    expect(order?.policies.map((policy) => [policy.key, policy.triggerKey])).toEqual([
      ["addOnNotifyOnAddOnRemoved", "addOnRemoved"],
      ["addOnOnRemoved", "removed"],
      ["archiveOnPaymnetFailed", null],
      ["hold", null],
      ["notifyOnOrderPlaced", null],
      ["putOnHoldOnPaymentFailed", "paymentFailed"],
    ]);
    expect(model.warnings).toEqual([
      {
        module: "order",
        message:
          'app/domain/order/policies/archive-on-paymnet-failed.ts: its name ends with no event of "order" after "-on-" and it exports no "on", so boot refuses it; is the event misspelled?',
      },
    ]);
  });

  it("warns about a projection named after no event that exports no on", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/order-paid.ts",
      "app/domain/customer/customer-registered.ts",
      "app/read/orders/view.ts",
      ["app/read/orders/projections/order/order-placed.ts", "export const project = () => {};\n"],
      [
        "app/read/orders/projections/customer/customer-registered.ts",
        "export const project = () => {};\n",
      ],
      ["app/read/orders/projections/order/order-plcaed.ts", "export const project = () => {};\n"],
      [
        "app/read/orders/projections/order/any-order.ts",
        'export const on = "OrderPlaced";\nexport const project = () => {};\n',
      ],
    ]);
    expect((await discoverProject({ root })).warnings).toEqual([
      {
        module: "orders",
        message:
          'app/read/orders/projections/order/order-plcaed.ts: "orderPlcaed" is not an event of "order" and the module exports no "on"; is the event misspelled?',
      },
    ]);
  });

  it("rejects a command or a query whose key another aggregate or read model already has", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order/commands/create.ts",
      "app/domain/customer/customer-registered.ts",
      "app/domain/customer/commands/create.ts",
      "app/read/orders/view.ts",
      "app/read/orders/queries/count.ts",
      "app/read/customers/view.ts",
      "app/read/customers/queries/count.ts",
    ]);
    expect(await problemsOf(root)).toEqual([
      'app/domain/order/commands/create.ts: the command "create" is also app/domain/customer/commands/create.ts; commands share one namespace across the app, so give one of them another name',
      'app/read/orders/queries/count.ts: the query "count" is also app/read/customers/queries/count.ts; queries share one namespace across the app, so give one of them another name',
    ]);
  });

  it("rejects an aggregate or read model whose generated types meet others", async () => {
    const root = await project([
      "app/domain/order/order-placed.ts",
      "app/domain/order-created/order-created-placed.ts",
      "app/domain/test/test-run.ts",
      "app/read/orders/view.ts",
    ]);
    expect(await problemsOf(root)).toEqual([
      "app/domain/order-created: its generated type OrderCreatedState is also that of app/domain/order; give it another name",
      "app/domain/test: its generated type TestPorts is also one of Bounda's own; give it another name",
    ]);
    const readModel = await project(["app/domain/order/order-placed.ts", "app/read/test/view.ts"]);
    expect(await problemsOf(readModel)).toEqual([
      "app/read/test: its generated type TestPorts is also one of Bounda's own; give it another name",
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
      /1 problem in the project layout:\n {2}.*app[\\/]domain[\\/]orders_v2: Aggregate names must be kebab-case/,
    );
  });
});
