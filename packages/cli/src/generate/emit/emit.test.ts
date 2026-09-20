import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverProject } from "../discover.ts";
import type { ProjectModel } from "../model.ts";
import { emitProject } from "./index.ts";
import { importPath } from "./paths.ts";
import { emitRegistry } from "./registry.ts";
import { emitTypes } from "./types.ts";

const fixtureRoot = resolve(import.meta.dirname, "../../../../core/test-types/fixtures/order-app");
const updateGolden = process.env.UPDATE_GOLDEN === "1";

const generatedFilesOnDisk = async (root: string): Promise<readonly string[]> => {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        await walk(path);
      } else if (path.includes("/+types/") || path.includes("/.bounda/")) {
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
      commands: [],
      policies: [
        {
          key: "audit",
          triggerKey: null,
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
          timeout: null,
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
        },
      ],
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
        },
      ],
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
      projections: [
        {
          eventKey: "created",
          path: "/project/app/read/shipments/projections/created.ts",
          relativePath: "app/read/shipments/projections/created.ts",
        },
      ],
      queries: [],
    },
  ],
};

describe("emitRegistry", () => {
  it("prefixes colliding import aliases with their owner and omits absent parts", () => {
    const { content } = emitRegistry({ model, path: "/project/.bounda/registry.ts" });
    expect(content).toBe(`import type { Registry } from "@bounda-dev/core";
import * as audit from "../app/domain/order/policies/audit.ts";
import * as followUp from "../app/domain/order/processes/follow-up/index.ts";
import * as shipmentCreated from "../app/domain/shipment/created.ts";
import * as ticketCreated from "../app/domain/ticket/created.ts";
import * as shipmentsOnCreated from "../app/read/shipments/projections/created.ts";
import * as shipmentsView from "../app/read/shipments/view.ts";

export const registry = {
  aggregates: {
    order: {
      events: {},
      commands: {},
      policies: { audit },
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
      projections: { created: shipmentsOnCreated },
      queries: {},
    },
  },
} as const satisfies Registry;
`);
  });
});

describe("emitTypes", () => {
  it("falls back to UnknownState, uses inferred states when given and handles empty maps", () => {
    const { content } = emitTypes({
      model,
      path: "/project/.bounda/types.ts",
      inferredStates: {
        ticket: { inferred: "{ readonly open?: boolean; readonly title?: string }" },
      },
    });
    expect(content).toBe(`import type * as core from "@bounda-dev/core";

export type OrderState = core.UnknownState;
export type OrderEvents = Record<never, never>;

export type ShipmentState = core.UnknownState;
export type ShipmentEvents = {
  readonly created: typeof import("../app/domain/shipment/created.ts");
};

export type TicketState = { readonly open?: boolean; readonly title?: string };
export type TicketEvents = {
  readonly created: typeof import("../app/domain/ticket/created.ts");
};

export type Commands = core.CommandsFacadeOf<Record<never, never>>;

export type ShipmentsRow = core.RowOf<typeof import("../app/read/shipments/view.ts")>;

export type Queries = core.QueriesFacadeOf<Record<never, never>>;
`);
  });
});

describe("emitProject without a file-name trigger", () => {
  it("types a policy without -on- over every event of its aggregate", () => {
    const files = emitProject({ model });
    const policy = files.find((file) => file.path.endsWith("policies/+types/audit.ts"));
    expect(policy?.content).toContain(
      "core.StoredEventOf<generated.OrderEvents, keyof generated.OrderEvents>",
    );
    const projection = files.find((file) => file.path.endsWith("projections/+types/created.ts"));
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
});
