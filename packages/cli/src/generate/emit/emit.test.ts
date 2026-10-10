import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverProject } from "../discover.ts";
import type { ProjectModel } from "../model.ts";
import { emitProject } from "./index.ts";
import { importPath } from "./paths.ts";
import { emitRegistry } from "./registry.ts";
import { emitTypes } from "./types.ts";

const fixtureRoot = resolve(import.meta.dirname, "../../../../core/test-types/fixtures/order-app");
const updateGolden = process.env.UPDATE_GOLDEN === "1";
// A path with `/` on every platform, to match it against the ones written below.
const slashed = (path: string): string => path.split(sep).join("/");

const generatedFilesOnDisk = async (root: string): Promise<readonly string[]> => {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        await walk(path);
      } else if (slashed(path).includes("/+types/") || slashed(path).includes("/.bounda/")) {
        found.push(path);
      }
    }
  };
  await walk(root);
  return found.sort();
};

describe("emitProject on the order-app fixture (golden)", () => {
  it("reproduces every generated file of the fixture byte for byte", async () => {
    const model = await discoverProject({ root: fixtureRoot });
    const files = emitProject({ model });
    if (updateGolden) {
      for (const file of files) {
        await mkdir(dirname(file.path), { recursive: true });
        await writeFile(file.path, file.content);
      }
    }
    for (const file of files) {
      const onDisk = await readFile(file.path, "utf8").catch(() => null);
      expect(onDisk, relative(fixtureRoot, file.path)).toBe(file.content);
    }
    const emitted = files.map((file) => file.path).sort();
    expect(await generatedFilesOnDisk(fixtureRoot)).toEqual(emitted);
  });
});

const model: ProjectModel = {
  root: "/project",
  appDir: "app",
  aggregates: [
    {
      name: "order",
      directory: "/project/app/domain/order",
      state: null,
      events: [],
      ports: [],
      commands: [],
      policies: [
        {
          key: "audit",
          triggerKey: null,
          source: null,
          path: "/project/app/domain/order/policies/audit.ts",
          relativePath: "app/domain/order/policies/audit.ts",
        },
      ],
      processes: [
        {
          key: "followUp",
          typeName: "FollowUp",
          directory: "/project/app/domain/order/processes/follow-up",
          path: "/project/app/domain/order/processes/follow-up/index.ts",
          relativePath: "app/domain/order/processes/follow-up/index.ts",
          handlers: [],
          deadlines: [],
        },
      ],
    },
    {
      name: "shipment",
      directory: "/project/app/domain/shipment",
      state: null,
      events: [
        {
          key: "created",
          typeName: "Created",
          path: "/project/app/domain/shipment/created.ts",
          relativePath: "app/domain/shipment/created.ts",
          upcasts: null,
        },
      ],
      ports: [],
      commands: [],
      policies: [],
      processes: [],
    },
    {
      name: "ticket",
      directory: "/project/app/domain/ticket",
      state: null,
      events: [
        {
          key: "created",
          typeName: "Created",
          path: "/project/app/domain/ticket/created.ts",
          relativePath: "app/domain/ticket/created.ts",
          upcasts: null,
        },
      ],
      ports: [],
      commands: [],
      policies: [],
      processes: [],
    },
  ],
  readModels: [
    {
      name: "shipments",
      directory: "/project/app/read/shipments",
      view: {
        path: "/project/app/read/shipments/view.ts",
        relativePath: "app/read/shipments/view.ts",
      },
      ports: [],
      projections: [
        {
          aggregate: "shipment",
          eventKey: "created",
          path: "/project/app/read/shipments/projections/shipment/created.ts",
          relativePath: "app/read/shipments/projections/shipment/created.ts",
        },
      ],
      queries: [],
    },
  ],
};

const port = (name: string, typeName: string, implementations: readonly string[]) => ({
  key: name,
  typeName,
  path: `/project/app/domain/order/${name}.ts`,
  relativePath: `app/domain/order/${name}.ts`,
  implementations: implementations.map((implementation) => ({
    name: implementation,
    path: `/project/app/domain/order/infrastructure/${name}/${implementation}.ts`,
    relativePath: `app/domain/order/infrastructure/${name}/${implementation}.ts`,
  })),
});

const withPorts: ProjectModel = {
  ...model,
  aggregates: [
    {
      ...(model.aggregates[0] as ProjectModel["aggregates"][number]),
      ports: [port("mailer", "Mailer", ["in-memory", "smtp"]), port("sms", "Sms", ["fake"])],
      policies: [
        ...(model.aggregates[0] as ProjectModel["aggregates"][number]).policies,
        {
          key: "notifyOnOrderPlaced",
          triggerKey: "orderPlaced",
          path: "/project/app/domain/order/policies/notify-on-order-placed.ts",
          relativePath: "app/domain/order/policies/notify-on-order-placed.ts",
          source: "shipment",
        },
      ],
    },
    ...model.aggregates.slice(1),
  ],
};

describe("emitRegistry", () => {
  it("imports an upcast module under its own alias and lists it under upcasts", () => {
    const shipment = model.aggregates[1] as ProjectModel["aggregates"][number];
    const created = shipment.events[0] as ProjectModel["aggregates"][number]["events"][number];
    const withUpcasts: ProjectModel = {
      ...model,
      aggregates: [
        model.aggregates[0] as ProjectModel["aggregates"][number],
        {
          ...shipment,
          events: [
            {
              ...created,
              upcasts: {
                path: "/project/app/domain/shipment/created.upcast.ts",
                relativePath: "app/domain/shipment/created.upcast.ts",
              },
            },
          ],
        },
        model.aggregates[2] as ProjectModel["aggregates"][number],
      ],
    };
    const { content } = emitRegistry({ model: withUpcasts, path: "/project/.bounda/registry.ts" });
    expect(content).toContain(
      'import * as createdUpcasts from "../app/domain/shipment/created.upcast.ts";',
    );
    expect(content).toContain(
      [
        "    shipment: {",
        "      events: { created: shipmentCreated },",
        "      upcasts: { created: createdUpcasts },",
        "      commands: {},",
      ].join("\n"),
    );
    expect(emitRegistry({ model, path: "/project/.bounda/registry.ts" }).content).not.toContain(
      "upcasts",
    );
  });

  it("checks every implementation of every port against its interface, quoting file names that are not identifiers", () => {
    const { content } = emitRegistry({
      model: withPorts,
      path: "/project/.bounda/registry.ts",
    });
    expect(content).toContain(
      'import type { ImplementationModule, Registry } from "@bounda-dev/core";',
    );
    expect(content).toContain('import type * as orderMailer from "../app/domain/order/mailer.ts";');
    expect(content).toContain(
      'import * as orderMailerInMemory from "../app/domain/order/infrastructure/mailer/in-memory.ts";',
    );
    expect(content).toContain(
      [
        "      events: {},",
        "      ports: {",
        "        mailer: {",
        '          "in-memory": orderMailerInMemory satisfies ImplementationModule<orderMailer.Mailer>,',
        "          smtp: orderMailerSmtp satisfies ImplementationModule<orderMailer.Mailer>,",
        "        },",
        "        sms: {",
        "          fake: orderSmsFake satisfies ImplementationModule<orderSms.Sms>,",
        "        },",
        "      },",
        "      commands: {},",
        '      policies: { audit: { module: audit }, notifyOnOrderPlaced: { module: notifyOnOrderPlaced, source: "shipment" } },',
      ].join("\n"),
    );
  });

  it("keeps a port's aliases apart from an event named after the aggregate and the port", () => {
    const order = withPorts.aggregates[0] as ProjectModel["aggregates"][number];
    const { content } = emitRegistry({
      model: {
        ...withPorts,
        aggregates: [
          {
            ...order,
            events: [
              {
                key: "orderMailer",
                typeName: "OrderMailer",
                path: "/project/app/domain/order/order-mailer.ts",
                relativePath: "app/domain/order/order-mailer.ts",
                upcasts: null,
              },
              {
                key: "orderMailerSmtp",
                typeName: "OrderMailerSmtp",
                path: "/project/app/domain/order/order-mailer-smtp.ts",
                relativePath: "app/domain/order/order-mailer-smtp.ts",
                upcasts: null,
              },
            ],
          },
          ...withPorts.aggregates.slice(1),
        ],
      },
      path: "/project/.bounda/registry.ts",
    });
    expect(content).toContain(
      'import type * as mailerOrderMailer from "../app/domain/order/mailer.ts";',
    );
    expect(content).toContain(
      'import * as mailerOrderMailerSmtp from "../app/domain/order/infrastructure/mailer/smtp.ts";',
    );
    expect(content).toContain(
      'import * as orderOrderMailer from "../app/domain/order/order-mailer.ts";',
    );
    expect(content).toContain(
      'import * as orderOrderMailerSmtp from "../app/domain/order/order-mailer-smtp.ts";',
    );
    expect(content).toContain(
      "smtp: mailerOrderMailerSmtp satisfies ImplementationModule<mailerOrderMailer.Mailer>,",
    );
  });

  it("prefixes colliding import aliases with their owner and omits absent parts", () => {
    const { content } = emitRegistry({ model, path: "/project/.bounda/registry.ts" });
    expect(content).toBe(`import type { Registry } from "@bounda-dev/core";
import * as audit from "../app/domain/order/policies/audit.ts";
import * as followUp from "../app/domain/order/processes/follow-up/index.ts";
import * as shipmentCreated from "../app/domain/shipment/created.ts";
import * as ticketCreated from "../app/domain/ticket/created.ts";
import * as shipmentsOnShipmentCreated from "../app/read/shipments/projections/shipment/created.ts";
import * as shipmentsView from "../app/read/shipments/view.ts";

export const registry = {
  aggregates: {
    order: {
      events: {},
      commands: {},
      policies: { audit: { module: audit } },
      processes: {
        followUp: {
          module: followUp,
          handlers: {},
        },
      },
    },
    shipment: {
      events: { created: shipmentCreated },
      commands: {},
      policies: {},
      processes: {},
    },
    ticket: {
      events: { created: ticketCreated },
      commands: {},
      policies: {},
      processes: {},
    },
  },
  readModels: {
    shipments: {
      view: shipmentsView,
      projections: { shipment: { created: shipmentsOnShipmentCreated } },
      queries: {},
    },
  },
} as const satisfies Registry;
`);
  });
});

describe("emitRegistry with modules named like reserved words or one another", () => {
  it("never binds a reserved word, nor one alias twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "bounda-emit-"));
    try {
      for (const file of [
        "app/domain/order/order-placed.ts",
        "app/domain/order/commands/delete.ts",
        "app/domain/order/commands/checkout.ts",
        "app/domain/order/processes/checkout/index.ts",
      ]) {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), "export const evolve = () => ({});\n");
      }
      const model = await discoverProject({ root });
      const { content } = emitRegistry({ model, path: join(root, ".bounda/registry.ts") });
      const bound = [...content.matchAll(/^import \* as (\w+) from/gm)].map((match) => match[1]);
      expect(new Set(bound).size).toBe(bound.length);
      expect(bound).toEqual(
        expect.arrayContaining(["orderDelete", "orderCheckout", "orderCheckout2"]),
      );
      expect(content).toContain("delete: { module: orderDelete }");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("emitRegistry with one empty side", () => {
  it("renders the empty group on one line", () => {
    const { content } = emitRegistry({
      model: { ...model, readModels: [] },
      path: "/project/.bounda/registry.ts",
    });
    expect(content).toContain("\n  readModels: {},\n} as const satisfies Registry;\n");
    const empty = emitRegistry({
      model: { ...model, aggregates: [] },
      path: "/project/.bounda/registry.ts",
    });
    expect(empty.content).toContain(
      "export const registry = {\n  aggregates: {},\n  readModels: {\n",
    );
  });
});

describe("emitTypes", () => {
  it("falls back to UnknownState, uses inferred states when given, created or not, and handles empty maps", () => {
    const { content } = emitTypes({
      model,
      path: "/project/.bounda/types.ts",
      inferredStates: {
        shipment: { inferred: "{ readonly carrier: string }", created: true },
        ticket: { inferred: "{ readonly open?: boolean; readonly title?: string }" },
      },
    });
    expect(content).toBe(`import type * as core from "@bounda-dev/core";

export type OrderState = core.UnknownState;
export type OrderCreatedState = OrderState;
export type OrderEvents = Record<never, never>;
export type OrderPorts = core.EmptyPayload;

export type ShipmentCreatedState = { readonly carrier: string };
export type ShipmentState = core.NotCreated<ShipmentCreatedState> | ShipmentCreatedState;
export type ShipmentEvents = {
  readonly created: typeof import("../app/domain/shipment/created.ts");
};
export type ShipmentPorts = core.EmptyPayload;

export type TicketState = { readonly open?: boolean; readonly title?: string };
export type TicketCreatedState = TicketState;
export type TicketEvents = {
  readonly created: typeof import("../app/domain/ticket/created.ts");
};
export type TicketPorts = core.EmptyPayload;

export type Events = {
  readonly order: OrderEvents;
  readonly shipment: ShipmentEvents;
  readonly ticket: TicketEvents;
};

export type PortsConfig = Readonly<Record<string, never>>;

export type TestPorts = Readonly<Record<string, never>>;

export type Commands = core.CommandsFacadeOf<Record<never, never>>;

export type ReactionCommands = core.ReactionCommandsFacadeOf<Record<never, never>>;

export type ShipmentsRow = core.RowOf<typeof import("../app/read/shipments/view.ts")>;
export type ShipmentsPorts = core.EmptyPayload;

export type Queries = core.QueriesFacadeOf<Record<never, never>>;
`);
  });
});

describe("emitTypes for an app without aggregates", () => {
  it("still declares the app's events, as an empty map", () => {
    const { content } = emitTypes({
      model: { ...model, aggregates: [], readModels: [] },
      path: "/project/.bounda/types.ts",
    });
    expect(content).toContain("export type Events = Record<never, never>;");
  });
});

describe("emitTypes with ports", () => {
  it("types the aggregate's ports by their interface, requires a choice only where there are several implementations and lets a test pass a name or a double for any port", () => {
    const { content } = emitTypes({ model: withPorts, path: "/project/.bounda/types.ts" });
    expect(content).toContain(
      [
        "export type OrderPorts = {",
        '  readonly mailer: import("../app/domain/order/mailer.ts").Mailer;',
        '  readonly sms: import("../app/domain/order/sms.ts").Sms;',
        "};",
      ].join("\n"),
    );
    expect(content).toContain(
      [
        "export type PortsConfig = {",
        "  readonly order: {",
        '    readonly mailer: "in-memory" | "smtp";',
        '    readonly sms?: "fake";',
        "  };",
        "};",
      ].join("\n"),
    );
    expect(content).toContain(
      [
        "export type TestPorts = {",
        "  readonly order?: {",
        '    readonly mailer?: "in-memory" | "smtp" | OrderPorts["mailer"];',
        '    readonly sms?: "fake" | OrderPorts["sms"];',
        "  };",
        "};",
      ].join("\n"),
    );
    const single = emitTypes({
      model: {
        ...withPorts,
        aggregates: [
          {
            ...(withPorts.aggregates[0] as ProjectModel["aggregates"][number]),
            ports: [port("sms", "Sms", ["fake"])],
          },
        ],
      },
      path: "/project/.bounda/types.ts",
    });
    expect(single.content).toContain(
      [
        "export type PortsConfig = {",
        "  readonly order?: {",
        '    readonly sms?: "fake";',
        "  };",
        "};",
      ].join("\n"),
    );
  });
});

describe("emitProject with a read model's ports", () => {
  it("types, registers and configures them, and hands them to its queries' handlers only", () => {
    const shipments = model.readModels[0] as ProjectModel["readModels"][number];
    const rates = {
      key: "rates",
      typeName: "Rates",
      path: "/project/app/read/shipments/rates.ts",
      relativePath: "app/read/shipments/rates.ts",
      implementations: ["ecb", "fixed"].map((name) => ({
        name,
        path: `/project/app/read/shipments/infrastructure/rates/${name}.ts`,
        relativePath: `app/read/shipments/infrastructure/rates/${name}.ts`,
      })),
    };
    const files = emitProject({
      model: {
        ...model,
        readModels: [
          {
            ...shipments,
            ports: [rates],
            queries: [
              {
                key: "listShipments",
                typeName: "ListShipments",
                path: "/project/app/read/shipments/queries/list-shipments.ts",
                relativePath: "app/read/shipments/queries/list-shipments.ts",
              },
            ],
          },
        ],
      },
    });
    const contentOf = (suffix: string) =>
      files.find((file) => slashed(file.path).endsWith(suffix))?.content ?? "";
    const types = contentOf(".bounda/types.ts");
    expect(types).toContain(
      'export type ShipmentsPorts = {\n  readonly rates: import("../app/read/shipments/rates.ts").Rates;\n};',
    );
    expect(types).toContain('  readonly shipments: {\n    readonly rates: "ecb" | "fixed";\n  };');
    expect(types).toContain(
      '  readonly shipments?: {\n    readonly rates?: "ecb" | "fixed" | ShipmentsPorts["rates"];\n  };',
    );
    const registry = contentOf(".bounda/registry.ts");
    expect(registry).toContain(
      'import type { ImplementationModule, Registry } from "@bounda-dev/core";',
    );
    expect(registry).toContain("      ports: {\n        rates: {");
    expect(registry).toContain(
      "ecb: shipmentsRatesEcb satisfies ImplementationModule<shipmentsRates.Rates>,",
    );
    const query = contentOf("queries/+types/list-shipments.ts");
    expect(query).toContain("    generated.Queries,\n    generated.ShipmentsPorts\n  >;");
    expect(query).not.toMatch(/type RepositoryArgs = [^;]*Ports/s);
    expect(contentOf("projections/shipment/+types/created.ts")).not.toContain("Ports");
  });
});

describe("emitProject with ports", () => {
  it("gives every handler of the aggregate its ports, and implementations no +types", () => {
    const files = emitProject({ model: withPorts });
    const contentOf = (suffix: string) =>
      files.find((file) => slashed(file.path).endsWith(suffix))?.content ?? "";
    expect(contentOf("policies/+types/audit.ts")).toContain("generated.OrderPorts");
    expect(contentOf("policies/+types/notify-on-order-placed.ts")).toContain(
      "generated.OrderPorts",
    );
    expect(files.filter((file) => slashed(file.path).includes("/infrastructure/"))).toEqual([]);
  });
});

describe("emitProject without a file-name trigger", () => {
  it("types a projection by the aggregate of its folder, though another has an event of that name", () => {
    const shipments = model.readModels[0] as ProjectModel["readModels"][number];
    const files = emitProject({
      model: {
        ...model,
        readModels: [
          {
            ...shipments,
            projections: [
              ...shipments.projections,
              {
                aggregate: "ticket",
                eventKey: "created",
                path: "/project/app/read/shipments/projections/ticket/created.ts",
                relativePath: "app/read/shipments/projections/ticket/created.ts",
              },
            ],
          },
        ],
      },
    });
    const ticket = files.find((file) =>
      slashed(file.path).endsWith("projections/ticket/+types/created.ts"),
    );
    expect(ticket?.content).toContain('core.StoredEventOf<generated.TicketEvents, "created">');
  });

  it("types a policy without -on- over every event of its aggregate", () => {
    const files = emitProject({ model });
    const policy = files.find((file) => slashed(file.path).endsWith("policies/+types/audit.ts"));
    expect(policy?.content).toContain(
      "core.StoredEventOf<generated.OrderEvents, keyof generated.OrderEvents>",
    );
    const order = model.aggregates[0] as ProjectModel["aggregates"][number];
    const misnamed = emitProject({
      model: {
        ...model,
        aggregates: [
          {
            ...order,
            policies: [
              {
                ...(order.policies[0] as ProjectModel["aggregates"][number]["policies"][number]),
                key: "notifyOnOrderShipped",
                triggerKey: "orderShipped",
                path: "/project/app/domain/order/policies/notify-on-order-shipped.ts",
                relativePath: "app/domain/order/policies/notify-on-order-shipped.ts",
              },
            ],
          },
          ...model.aggregates.slice(1),
        ],
      },
    }).find((file) => slashed(file.path).endsWith("policies/+types/notify-on-order-shipped.ts"));
    expect(misnamed?.content).toContain(
      "core.StoredEventOf<generated.OrderEvents, keyof generated.OrderEvents>",
    );
    const projection = files.find((file) =>
      slashed(file.path).endsWith("projections/shipment/+types/created.ts"),
    );
    expect(projection?.content).toContain(
      'core.StoredEventOf<generated.ShipmentEvents, "created">',
    );
  });
});

describe("importPath", () => {
  it("builds relative specifiers with the extension kept", () => {
    expect(importPath({ from: "/p/.bounda/registry.ts", to: "/p/app/domain/order/state.ts" })).toBe(
      "../app/domain/order/state.ts",
    );
    expect(importPath({ from: "/p/app/+types/x.ts", to: "/p/app/x.ts" })).toBe("../x.ts");
    expect(importPath({ from: "/p/a.ts", to: "/p/b.ts" })).toBe("./b.ts");
  });

  it("prefixes a target inside a dot directory with ./", () => {
    expect(importPath({ from: "/p/a.ts", to: "/p/.bounda/registry.ts" })).toBe(
      "./.bounda/registry.ts",
    );
    expect(importPath({ from: "/p/a.ts", to: "/p/..b/c.ts" })).toBe("./..b/c.ts");
  });
});
