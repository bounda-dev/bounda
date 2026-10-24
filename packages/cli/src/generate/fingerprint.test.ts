import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fingerprintStates, readStateSources } from "./fingerprint.ts";
import type { AggregateModel, ProjectModel } from "./model.ts";

const temporary: string[] = [];

afterAll(async () => {
  await Promise.all(temporary.map((root) => rm(root, { recursive: true, force: true })));
});

const project = async (files: Readonly<Record<string, string>>): Promise<ProjectModel> => {
  const root = await mkdtemp(join(tmpdir(), "bounda-fingerprint-"));
  temporary.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const ref = (path: string) => ({ path: join(root, path), relativePath: path });
  const order: AggregateModel = {
    name: "order",
    directory: join(root, "app/domain/order"),
    state: "app/domain/order/state.ts" in files ? ref("app/domain/order/state.ts") : null,
    events: Object.keys(files)
      .filter((path) => /^app\/domain\/order\/order-[a-z-]+\.ts$/.test(path))
      .map((path) => ({
        ...ref(path),
        key: "event",
        typeName: "Event",
        upcasts:
          `${path.slice(0, -3)}.upcast.ts` in files ? ref(`${path.slice(0, -3)}.upcast.ts`) : null,
      })),
    ports: [],
    commands: [],
    policies: [],
    processes: [],
  };
  return { root, appDir: "app", aggregates: [order], readModels: [] };
};

const base = {
  "app/domain/order/state.ts": "export const initialState = { total: 0 };\n",
  "app/domain/order/order-placed.ts": [
    'import type { Event } from "./+types/order-placed";',
    'import { sum } from "./pricing/sum.js";',
    'export * from "../shared/money";',
    "export const evolve = ({ state, event }: Event.EvolveArgs) => ({ total: sum(state.total, event.payload.total) });",
    "",
  ].join("\n"),
  "app/domain/order/order-placed.upcast.ts":
    "export const upcasts = [(payload: unknown) => payload];\n",
  "app/domain/order/pricing/sum.ts":
    'import { round } from "../../shared";\nexport const sum = (a: number, b: number) => round(a + b);\n',
  "app/domain/shared/index.ts": "export const round = (value: number) => Math.round(value);\n",
  "app/domain/shared/money.ts": "export type Money = number;\nexport const zero: Money = 0;\n",
  "app/domain/order/+types/order-placed.ts":
    "export namespace Event { export type EvolveArgs = never; }\n",
};

const fingerprint = async (files: Readonly<Record<string, string>>): Promise<string> =>
  fingerprintStates({ sources: await readStateSources(await project(files)) }).order ?? "";

describe("readStateSources", () => {
  it("collects the state's modules and what they import through relative paths, by path", async () => {
    const sources = await readStateSources(await project(base));
    expect(sources.order?.map((source) => source.relativePath)).toEqual([
      "app/domain/order/order-placed.ts",
      "app/domain/order/order-placed.upcast.ts",
      "app/domain/order/pricing/sum.ts",
      "app/domain/order/state.ts",
      "app/domain/shared/index.ts",
      "app/domain/shared/money.ts",
    ]);
    expect(sources.order?.find((source) => source.relativePath.endsWith("state.ts"))?.text).toBe(
      base["app/domain/order/state.ts"],
    );
  });

  it("follows what a dynamic import and a type-carrying import name, not a type-only one", async () => {
    const sources = await readStateSources(
      await project({
        ...base,
        "app/domain/order/order-placed.ts": [
          'import type { Money } from "../shared/money";',
          'import { type Round, round } from "../shared";',
          'const lazy = () => import("./pricing/sum.js");',
          "export const evolve = () => ({});",
          "",
        ].join("\n"),
      }),
    );
    expect(sources.order?.map((source) => source.relativePath)).toEqual([
      "app/domain/order/order-placed.ts",
      "app/domain/order/order-placed.upcast.ts",
      "app/domain/order/pricing/sum.ts",
      "app/domain/order/state.ts",
      "app/domain/shared/index.ts",
    ]);
  });

  it("leaves out packages, aliases, imports in comments and files that do not exist", async () => {
    const sources = await readStateSources(
      await project({
        ...base,
        "app/domain/order/order-placed.ts": [
          'import { z } from "zod";',
          'import { money } from "~/lib/money";',
          '/* import { sum } from "./pricing/sum"; */',
          '// import { round } from "../shared";',
          'import { gone } from "./gone";',
          "export const evolve = () => ({});",
          "",
        ].join("\n"),
      }),
    );
    expect(sources.order?.map((source) => source.relativePath)).toEqual([
      "app/domain/order/order-placed.ts",
      "app/domain/order/order-placed.upcast.ts",
      "app/domain/order/state.ts",
    ]);
  });

  it("resolves a specifier as TypeScript does, to a source file only", async () => {
    const sources = await readStateSources(
      await project({
        ...base,
        "app/domain/order/order-placed.ts": [
          'import { a } from "./lib/a.jsx";',
          'import { b } from "./lib/b.mjs";',
          'import { c } from "./lib/c";',
          'import { d } from "./lib/d";',
          'import { sum } from "./pricing/sum.js";',
          "export const evolve = () => ({});",
          "",
        ].join("\n"),
        "app/domain/order/lib/a.tsx": "export const a = 1;\n",
        "app/domain/order/lib/b.mts": "export const b = 2;\n",
        "app/domain/order/lib/c.tsx": "export const c = 3;\n",
        "app/domain/order/lib/d/index.ts": "export const d = 4;\n",
        "app/domain/order/pricing/sum.js": "export const sum = () => 0;\n",
      }),
    );
    expect(sources.order?.map((source) => source.relativePath)).toEqual([
      "app/domain/order/lib/a.tsx",
      "app/domain/order/lib/b.mts",
      "app/domain/order/lib/c.tsx",
      "app/domain/order/lib/d/index.ts",
      "app/domain/order/order-placed.ts",
      "app/domain/order/order-placed.upcast.ts",
      "app/domain/order/pricing/sum.ts",
      "app/domain/order/state.ts",
      "app/domain/shared/index.ts",
    ]);
  });

  it("never takes a package for a file of the same name, and reads a cycle once", async () => {
    const sources = await readStateSources(
      await project({
        ...base,
        "app/domain/order/order-placed.ts": [
          'import { zero } from "money";',
          'import { round } from "../shared";',
          "export const evolve = () => ({});",
          "",
        ].join("\n"),
        "app/domain/order/money.ts": "export const zero = 0;\n",
        "app/domain/shared/index.ts":
          'import { zero } from "./money";\nexport const round = (value: number) => value + zero;\n',
        "app/domain/shared/money.ts":
          'import { round } from "./index";\nexport const zero = round(0);\n',
      }),
    );
    expect(sources.order?.map((source) => source.relativePath)).toEqual([
      "app/domain/order/order-placed.ts",
      "app/domain/order/order-placed.upcast.ts",
      "app/domain/order/state.ts",
      "app/domain/shared/index.ts",
      "app/domain/shared/money.ts",
    ]);
  });

  it("reads the same text whatever the line endings", async () => {
    const crlf = base["app/domain/order/state.ts"].replaceAll("\n", "\r\n");
    const sources = await readStateSources(
      await project({ ...base, "app/domain/order/state.ts": crlf }),
    );
    expect(sources.order?.find((source) => source.relativePath.endsWith("state.ts"))?.text).toBe(
      base["app/domain/order/state.ts"],
    );
  });
});

describe("fingerprintStates", () => {
  it("gives sixteen hex digits, the same for the same sources", async () => {
    const first = await fingerprint(base);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(await fingerprint(base)).toBe(first);
  });

  it("changes with any module that shapes the state, imported ones and comments included", async () => {
    const first = await fingerprint(base);
    const changed = async (path: keyof typeof base, content: string) =>
      fingerprint({ ...base, [path]: content });
    expect(
      await changed("app/domain/order/state.ts", "export const initialState = { total: 1 };\n"),
    ).not.toBe(first);
    expect(
      await changed(
        "app/domain/shared/index.ts",
        "export const round = (value: number) => Math.floor(value);\n",
      ),
    ).not.toBe(first);
    expect(
      await changed(
        "app/domain/order/order-placed.upcast.ts",
        "// v1\nexport const upcasts = [(payload: unknown) => payload];\n",
      ),
    ).not.toBe(first);
    expect(
      await changed(
        "app/domain/order/+types/order-placed.ts",
        "export namespace Event { export type EvolveArgs = unknown; }\n",
      ),
    ).toBe(first);
  });

  it("takes the inferred state type in, for the aggregates that have one", async () => {
    const sources = await readStateSources(await project(base));
    const plain = fingerprintStates({ sources });
    const inferred = fingerprintStates({
      sources,
      inferredStates: { order: { inferred: "{ readonly total: number; }" } },
    });
    const other = fingerprintStates({
      sources,
      inferredStates: {
        order: { inferred: "{ readonly total: number; readonly paid: boolean; }" },
      },
    });
    expect(inferred.order).not.toBe(plain.order);
    expect(other.order).not.toBe(inferred.order);
    expect(fingerprintStates({ sources, inferredStates: { order: { inferred: null } } })).toEqual(
      plain,
    );
    expect(fingerprintStates({ sources, inferredStates: { payment: { inferred: "{}" } } })).toEqual(
      plain,
    );
  });
});
