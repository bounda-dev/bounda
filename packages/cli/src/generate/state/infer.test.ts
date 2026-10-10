import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generate } from "../generate.ts";

const repoRoot = resolve(import.meta.dirname, "../../../../..");
const fixtureRoot = join(repoRoot, "packages/core/test-types/fixtures/order-app-inferred");
const updateGolden = process.env.UPDATE_GOLDEN === "1";
const temporary: string[] = [];

const listFiles = async (root: string): Promise<readonly string[]> => {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path).split(sep).join("/"));
    }
  };
  await walk(root);
  return found.sort();
};

const isGenerated = (path: string): boolean =>
  path.includes("/+types/") || path.startsWith(".bounda/");

/**
 * A fresh copy of the fixture's sources (no generated files) with a tsconfig that resolves
 * `@bounda-dev/core` to the repository's source, as a user project would through node_modules.
 */
const freshProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bounda-infer-"));
  temporary.push(root);
  await cp(join(fixtureRoot, "app"), join(root, "app"), {
    recursive: true,
    filter: (source) => basename(source) !== "+types",
  });
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        extends: join(repoRoot, "tsconfig.base.json"),
        compilerOptions: {
          isolatedDeclarations: false,
          declaration: false,
          types: [],
          paths: { "@bounda-dev/core": [join(repoRoot, "packages/core/src/index.ts")] },
        },
        include: ["."],
      },
      null,
      2,
    ),
  );
  return root;
};

afterAll(async () => {
  await Promise.all(temporary.map((root) => rm(root, { recursive: true, force: true })));
});

describe("generate with state inference (golden on order-app-inferred)", () => {
  it("infers the state of an aggregate without state.ts from its begin and evolve functions", async () => {
    const root = await freshProject();
    const report = await generate({ root });
    expect(report.removed).toEqual([]);
    expect(report.warnings).toEqual([
      {
        module: "order",
        message: expect.stringMatching(
          /^field "cancellation" \(set by orderCancelled\) has a type that is not visible from \.bounda\/types\.ts \(.*Cancellation.*\); it is typed as unknown\. Export the type or add state\.ts$/,
        ),
      },
    ]);

    const generated = (await listFiles(root)).filter(isGenerated);
    if (updateGolden) {
      for (const file of generated) {
        await cp(join(root, file), join(fixtureRoot, file));
      }
    }
    expect(generated).toEqual((await listFiles(fixtureRoot)).filter(isGenerated));
    for (const file of generated) {
      expect(await readFile(join(root, file), "utf8"), file).toBe(
        await readFile(join(fixtureRoot, file), "utf8"),
      );
    }
    const types = await readFile(join(root, ".bounda/types.ts"), "utf8");
    expect(types).toContain(`export type OrderCreatedState = {
  readonly cancellation?: unknown;
  readonly customerId: string;
  readonly lines: readonly import("../app/domain/order/order-placed.ts").Line[];
  readonly paidWith?: "card" | "transfer";
  readonly placedAt: Date;
  readonly reminders: number;
  readonly status: "cancelled" | "paid" | "placed";
};
export type OrderState = core.NotCreated<OrderCreatedState> | OrderCreatedState;`);
  });

  it("writes nothing on a second run, not even the uninferred types for a moment", async () => {
    const root = await freshProject();
    await generate({ root });
    const typesPath = join(root, ".bounda/types.ts");
    const before = (await stat(typesPath)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const report = await generate({ root });
    expect(report.written).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(report.unchanged.length).toBeGreaterThan(0);
    expect((await stat(typesPath)).mtimeMs).toBe(before);
  });

  it("falls back to UnknownState with a warning when TypeScript cannot open the project", async () => {
    const root = await freshProject();
    const report = await generate({ root, tsconfigPath: join(root, "missing.json") });
    expect(report.warnings).toEqual([
      {
        module: "order",
        message: expect.stringMatching(
          /State stays core\.UnknownState; add app\/domain\/order\/state\.ts to type it$/,
        ),
      },
    ]);
    const types = await readFile(join(root, ".bounda/types.ts"), "utf8");
    expect(types).toContain("export type OrderState = core.UnknownState;");
  });

  it("skips inference on request", async () => {
    const root = await freshProject();
    const report = await generate({ root, inferState: false });
    expect(report.warnings).toEqual([]);
    expect(await readFile(join(root, ".bounda/types.ts"), "utf8")).toContain(
      "export type OrderState = core.UnknownState;",
    );
  });

  it("removes +types files whose module is gone", async () => {
    const root = await freshProject();
    await generate({ root, inferState: false });
    await rm(join(root, "app/domain/order/commands/pay-order.ts"));
    const report = await generate({ root, inferState: false });
    expect(report.removed).toEqual([join(root, "app/domain/order/commands/+types/pay-order.ts")]);
    expect(report.written).toEqual([
      join(root, ".bounda/registry.ts"),
      join(root, ".bounda/types.ts"),
    ]);
  });
});

const syntheticProject = async (
  files: Readonly<Record<string, string>>,
  tsconfig: Readonly<Record<string, unknown>> = { include: [".", ".bounda/**/*"] },
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bounda-infer-edge-"));
  temporary.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      extends: join(repoRoot, "tsconfig.base.json"),
      compilerOptions: {
        isolatedDeclarations: false,
        declaration: false,
        types: [],
        paths: { "@bounda-dev/core": [join(repoRoot, "packages/core/src/index.ts")] },
      },
      ...tsconfig,
    }),
  );
  return root;
};

describe("state inference on the edges", () => {
  it("reads function declarations, skips a non-exported evolve, warns on one that is not a function and sorts members", async () => {
    const root = await syntheticProject({
      "app/domain/ticket/a-first.ts":
        'export function evolve() {\n  return { status: "zeta" as const, opened: true };\n}\n',
      "app/domain/ticket/b-second.ts":
        'export const evolve = () => ({ status: "alpha" as const });\n',
      "app/domain/ticket/c-quiet.ts":
        "const evolve = () => ({ hidden: true });\nexport { evolve as payload };\n",
      "app/domain/ticket/d-broken.ts": "export const evolve = 42;\n",
      "app/domain/blank/blank-made.ts": "export const evolve = () => ({});\n",
    });
    const report = await generate({ root });
    expect(report.warnings).toEqual([
      {
        module: "ticket",
        message: "app/domain/ticket/d-broken.ts: evolve has no call signature, so it was skipped",
      },
    ]);
    const types = await readFile(join(root, ".bounda/types.ts"), "utf8");
    expect(types).toContain(`export type TicketState = {
  readonly opened?: boolean;
  readonly status?: "alpha" | "zeta";
};`);
    expect(types).toContain("export type BlankState = Record<never, never>;");
    expect(types).not.toContain("hidden");
  });

  it("reads begin and evolve exported in a list, under their own name or another", async () => {
    const root = await syntheticProject({
      "app/domain/alpha/alpha-opened.ts":
        'const begin = () => ({ status: "open" as const });\nexport { begin };\n',
      "app/domain/alpha/alpha-closed.ts":
        "const close = () => ({ closed: true });\nexport { close as evolve };\n",
    });
    const report = await generate({ root });
    expect(report.warnings).toEqual([]);
    const types = await readFile(join(root, ".bounda/types.ts"), "utf8");
    expect(types).toContain(`export type AlphaCreatedState = {
  readonly closed?: boolean;
  readonly status: "open";
};`);
  });

  it("makes required, once created, only what every begin always sets", async () => {
    const root = await syntheticProject({
      "app/domain/cart/cart-opened.ts": [
        "export const begin = () => ({",
        '  status: "open" as const,',
        '  owner: "someone",',
        "  note: undefined as string | undefined,",
        "  items: [] as string[],",
        "});",
        "",
      ].join("\n"),
      "app/domain/cart/item-added.ts": [
        'export const begin = () => ({ status: "open" as const, items: ["first"] });',
        "export const evolve = () => ({ items: [] as string[], total: 1 });",
        "",
      ].join("\n"),
      "app/domain/cart/cart-tagged.ts":
        'export const begin = (): { status: "open"; items: string[]; tag?: string } => ({ status: "open", items: [] });\n',
      "app/domain/cart/cart-closed.ts":
        'export const evolve = () => ({ status: "closed" as const });\n',
      "app/domain/plain/plain-made.ts": "export const evolve = () => ({ done: true });\n",
    });
    const report = await generate({ root });
    expect(report.warnings).toEqual([]);
    const types = await readFile(join(root, ".bounda/types.ts"), "utf8");
    expect(types).toContain(`export type CartCreatedState = {
  readonly items: string[];
  readonly note?: string | undefined;
  readonly owner?: string;
  readonly status: "closed" | "open";
  readonly tag?: string | undefined;
  readonly total?: number;
};
export type CartState = core.NotCreated<CartCreatedState> | CartCreatedState;`);
    expect(types).toContain(`export type PlainState = {
  readonly done?: boolean;
};
export type PlainCreatedState = PlainState;`);
  });

  it("downgrades a required field of a created state whose type is not visible", async () => {
    const root = await syntheticProject({
      "app/domain/gamma/gamma-made.ts": [
        "interface Hidden {",
        "  readonly x: number;",
        "}",
        'export const begin = (): { secret: Hidden; plain: string } => ({ secret: { x: 1 }, plain: "p" });',
        "",
      ].join("\n"),
    });
    const report = await generate({ root });
    expect(report.warnings.map((warning) => warning.message)).toEqual([
      expect.stringMatching(/^field "secret" \(set by gammaMade\) has a type that is not visible/),
    ]);
    const types = await readFile(join(root, ".bounda/types.ts"), "utf8");
    expect(types).toContain(`export type GammaCreatedState = {
  readonly plain: string;
  readonly secret: unknown;
};`);
  });

  it("downgrades a field whose type is not visible on a line after its first", async () => {
    const root = await syntheticProject({
      "app/domain/delta/delta-shipped.ts": [
        "interface Hidden {",
        "  readonly x: number;",
        "}",
        "export const evolve = (): { shipping: { address: Hidden; city: string } } => ({",
        '  shipping: { address: { x: 1 }, city: "c" },',
        "});",
        "",
      ].join("\n"),
    });
    const report = await generate({ root });
    expect(report.warnings.map((warning) => warning.message)).toEqual([
      expect.stringMatching(
        /^field "shipping" \(set by deltaShipped\) has a type that is not visible/,
      ),
    ]);
    const types = await readFile(join(root, ".bounda/types.ts"), "utf8");
    expect(types).toContain(`export type DeltaState = {
  readonly shipping?: unknown;
};`);
  });

  it("downgrades every field whose type is not visible, once, across aggregates", async () => {
    const root = await syntheticProject({
      "app/domain/alpha/alpha-made.ts": [
        "interface Hidden {",
        "  readonly x: number;",
        "}",
        "export const evolve = (): { secret: Hidden; other: Hidden; plain: string } => ({",
        '  secret: { x: 1 }, other: { x: 2 }, plain: "p",',
        "});",
        "",
      ].join("\n"),
      "app/domain/alpha/alpha-touched.ts":
        "interface Hidden {\n  readonly x: number;\n}\nexport const evolve = (): { secret: Hidden } => ({ secret: { x: 3 } });\n",
      "app/domain/beta/beta-made.ts":
        'interface Private {\n  readonly y: string;\n}\nexport const evolve = (): { token: Private; count: number } => ({ token: { y: "t" }, count: 1 });\n',
    });
    const report = await generate({ root });
    const messages = report.warnings.map((warning) => `${warning.module}: ${warning.message}`);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatch(
      /^alpha: field "other" \(set by alphaMade\) has a type that is not visible from \.bounda\/types\.ts \(.*\); it is typed as unknown\. Export the type or add state\.ts$/,
    );
    expect(messages[1]).toMatch(
      /^alpha: field "secret" \(set by alphaMade, alphaTouched\) has a type that is not visible/,
    );
    expect(messages[2]).toMatch(
      /^beta: field "token" \(set by betaMade\) has a type that is not visible/,
    );
    const types = await readFile(join(root, ".bounda/types.ts"), "utf8");
    expect(types).toContain(`export type AlphaState = {
  readonly other?: unknown;
  readonly plain?: string;
  readonly secret?: unknown;
};`);
    expect(types).toContain(`export type BetaState = {
  readonly count?: number;
  readonly token?: unknown;
};`);
  });

  it("types fields an evolve computes from the state, along a chain of them", async () => {
    const root = await syntheticProject({
      "app/domain/queue/queue-opened.ts":
        "export const begin = () => ({ waiting: [] as string[], served: 0, counts: {} as Record<string, number> });\n",
      "app/domain/queue/person-joined.ts": [
        'import type { Event } from "./+types/person-joined";',
        "export const evolve = ({ state }: Event.EvolveArgs) => ({",
        '  waiting: [...state.waiting, "someone"],',
        "  length: state.waiting.length + 1,",
        "});",
        "",
      ].join("\n"),
      "app/domain/queue/person-served.ts": [
        'import type { Event } from "./+types/person-served";',
        "export const evolve = ({ state }: Event.EvolveArgs) => ({",
        "  served: state.served + 1,",
        "  previous: state.served,",
        "  counts: { ...state.counts, [String(state.served)]: 1 },",
        "  left: (state.length ?? 0) - 1 > 0,",
        "});",
        "",
      ].join("\n"),
      // The ways an evolve can reach the state besides `({ state })`.
      "app/domain/queue/person-left.ts": [
        'import type { Event } from "./+types/person-left";',
        "export function evolve(args: Event.EvolveArgs) {",
        "  return { waiting: args.state.waiting.slice(1) };",
        "}",
        "",
      ].join("\n"),
      "app/domain/queue/queue-checked.ts": [
        'import type { Event } from "./+types/queue-checked";',
        "export const evolve = ({ event, state: queue }: Event.EvolveArgs) => ({",
        "  previous: queue.served,",
        "  checkedBy: event.type,",
        "});",
        "",
      ].join("\n"),
      "app/domain/queue/queue-paused.ts": [
        'import type { Event } from "./+types/queue-paused";',
        "export const evolve = ((args: Event.EvolveArgs) => ({ served: args.state.served }));",
        "",
      ].join("\n"),
      "app/domain/queue/queue-counted.ts": [
        'import type { Event } from "./+types/queue-counted";',
        "export const evolve = ({ ...args }: Event.EvolveArgs) => ({",
        "  length: args.state.waiting.length,",
        "});",
        "",
      ].join("\n"),
    });
    const report = await generate({ root });
    expect(report.warnings).toEqual([]);
    const types = await readFile(join(root, ".bounda/types.ts"), "utf8");
    expect(types).toContain(`export type QueueCreatedState = {
  readonly checkedBy?: "QueueChecked";
  readonly counts: Record<string, number> | {
    [x: string]: number;
  };
  readonly left?: boolean;
  readonly length?: number;
  readonly previous?: number;
  readonly served: number;
  readonly waiting: string[];
};`);
  });

  it("types as unknown, with a warning, a field computed from the state that never settles", async () => {
    const root = await syntheticProject({
      "app/domain/tally/tally-reset.ts": [
        'import type { Event } from "./+types/tally-reset";',
        "export const evolve = ({ state }: Event.EvolveArgs) => ({ count: state.count });",
        "",
      ].join("\n"),
      "app/domain/tally/tally-counted.ts": [
        'import type { Event } from "./+types/tally-counted";',
        "export const evolve = ({ state }: Event.EvolveArgs) => ({",
        "  count: (state.count ?? 0) + 1,",
        "  done: true,",
        "});",
        "",
      ].join("\n"),
    });
    const report = await generate({ root });
    expect(report.warnings).toEqual([
      {
        module: "tally",
        message:
          'field "count" (set by tallyCounted, tallyReset) is computed from the state in a way its type could not be inferred from; it is typed as unknown. Give it a type where the aggregate begins, or add state.ts',
      },
    ]);
    const types = await readFile(join(root, ".bounda/types.ts"), "utf8");
    expect(types).toContain(`export type TallyState = {
  readonly count?: unknown;
  readonly done?: boolean;
};`);
  });

  it("keeps a field that is any on purpose, and a property named any, as they are", async () => {
    const root = await syntheticProject({
      "app/domain/misc/misc-made.ts":
        'export const begin = () => ({ flags: { any: true }, extra: JSON.parse("1"), count: 0 });\n',
      "app/domain/misc/misc-reset.ts":
        'export function evolve() {\n  return { extra: JSON.parse("2") };\n}\n',
      "app/domain/misc/misc-loaded.ts": [
        'import type { Event } from "./+types/misc-loaded";',
        "export const evolve = ({ event }: Event.EvolveArgs) => ({ extra: JSON.parse(event.type) });",
        "",
      ].join("\n"),
      "app/domain/misc/misc-counted.ts": [
        'import type { Event } from "./+types/misc-counted";',
        "export const evolve = ({ state }: Event.EvolveArgs) => ({ count: state.count + 1 });",
        "",
      ].join("\n"),
    });
    const report = await generate({ root });
    expect(report.warnings).toEqual([]);
    const types = await readFile(join(root, ".bounda/types.ts"), "utf8");
    expect(types).toContain(`export type MiscCreatedState = {
  readonly count: number;
  readonly extra?: any;
  readonly flags: {
    any: boolean;
  };
};`);
  });

  it("reads again a field copied from one whose type grows on a later pass", async () => {
    const root = await syntheticProject({
      "app/domain/list/list-made.ts":
        "export const begin = () => ({ items: [] as readonly string[] });\n",
      "app/domain/list/item-added.ts": [
        'import type { Event } from "./+types/item-added";',
        'export const evolve = ({ state }: Event.EvolveArgs) => ({ items: [...state.items, "x"] });',
        "",
      ].join("\n"),
      "app/domain/list/list-copied.ts": [
        'import type { Event } from "./+types/list-copied";',
        "export const evolve = ({ state }: Event.EvolveArgs) => ({ copy: state.items });",
        "",
      ].join("\n"),
    });
    const report = await generate({ root });
    expect(report.warnings).toEqual([]);
    const types = await readFile(join(root, ".bounda/types.ts"), "utf8");
    expect(types).toContain(`export type ListCreatedState = {
  readonly copy?: string[] | readonly string[];
  readonly items: readonly string[] | string[];
};`);
  });

  it("types as unknown, with a warning, what does not settle within the passes", async () => {
    const root = await syntheticProject({
      "app/domain/relay/relay-opened.ts": 'export const begin = () => ({ first: "start" });\n',
      "app/domain/relay/relay-reset.ts": 'export const evolve = () => ({ seventh: "" });\n',
      "app/domain/relay/relay-passed.ts": [
        'import type { Event } from "./+types/relay-passed";',
        "export const evolve = ({ state }: Event.EvolveArgs) => ({",
        "  second: state.first,",
        "  third: state.second,",
        "  fourth: state.third,",
        "  fifth: state.fourth,",
        "  sixth: state.fifth,",
        "  seventh: state.sixth.toString(),",
        "});",
        "",
      ].join("\n"),
    });
    const report = await generate({ root });
    expect(report.warnings).toEqual([
      {
        module: "relay",
        message:
          'fields "fifth", "seventh", "sixth" (set by relayPassed, relayReset) did not settle within 5 passes over the events that read the state; they are typed as unknown. Give them a type where the aggregate begins, or add state.ts',
      },
    ]);
    const types = await readFile(join(root, ".bounda/types.ts"), "utf8");
    expect(types).toContain(`export type RelayCreatedState = {
  readonly fifth?: unknown;
  readonly first: string;
  readonly fourth?: string | undefined;
  readonly second?: string;
  readonly seventh?: unknown;
  readonly sixth?: unknown;
  readonly third?: string | undefined;
};`);
  });

  it("explains when the generated types are not part of the TypeScript project", async () => {
    const root = await syntheticProject(
      { "app/domain/solo/solo-made.ts": "export const evolve = () => ({ done: true });\n" },
      { files: ["app/domain/solo/solo-made.ts"] },
    );
    const report = await generate({ root });
    expect(report.warnings).toEqual([
      {
        module: "solo",
        message: expect.stringMatching(
          /^.*\.bounda[\\/]types\.ts is not part of the TypeScript project at .*tsconfig\.json; include it so state can be inferred\. State stays core\.UnknownState; add app\/domain\/solo\/state\.ts to type it$/,
        ),
      },
    ]);
    expect(await readFile(join(root, ".bounda/types.ts"), "utf8")).toContain(
      "export type SoloState = core.UnknownState;",
    );
  });
});
