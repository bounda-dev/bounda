import { describe, expect, it } from "vitest";
import {
  formatKeyCopiesLeft,
  formatRemovedCopy,
  formatStale,
  formatTenantKeysStatus,
} from "./tenant-key-output.ts";

const where = "in the tenant key store hooli's configuration names";

describe("formatStale", () => {
  it("says what the store the tenant's configuration names holds of the copy", () => {
    const stale = { tenant: "acme", namedBy: "hooli" };
    const none = { versions: [], files: [] };
    expect(formatStale({ ...stale, named: "holds", lost: none })).toBe(
      `acme: a copy of its key ${where}; the store its own configuration names holds the same key: remove it with bounda tenant-key remove-stale acme`,
    );
    expect(formatStale({ ...stale, named: "forgotten", lost: none })).toBe(
      `acme: a copy of its key ${where}, though it is forgotten: remove it with bounda tenant-key remove-stale acme`,
    );
    expect(
      formatStale({ ...stale, named: "differs", lost: { versions: ["t-1", "t-0"], files: [] } }),
    ).toBe(
      `acme: a copy of its key ${where}, holding versions t-1, t-0, which the store its own configuration names lacks`,
    );
    expect(
      formatStale({ ...stale, named: "differs", lost: { versions: ["t-1"], files: ["f-1"] } }),
    ).toContain("holding versions t-1 and file keys f-1, which");
    expect(
      formatStale({ ...stale, named: "differs", lost: { versions: [], files: ["f-1"] } }),
    ).toContain("holding file keys f-1, which");
    expect(formatStale({ ...stale, named: "lacks", lost: { versions: ["t-1"], files: [] } })).toBe(
      `acme: a copy of its key ${where}, the only one: the store its own configuration names holds no record of it`,
    );
  });
});

describe("formatTenantKeysStatus", () => {
  it("names every tenant not read once, as the runtime would log its error", () => {
    const error = new Error("refused for ana@example.com");
    const { out, err } = formatTenantKeysStatus(
      {
        stores: 3,
        underPreviousMaster: ["acme", "globex"],
        stale: [],
        failed: [
          { tenant: "acme", error },
          { tenant: "initech", error },
        ],
        unreached: [{ tenant: "acme", error }],
      },
      "omit",
    );
    expect(out).toEqual([
      "3 tenant key store(s) read",
      "2 tenant(s) with a key under a previous master key: acme, globex; rewrap them with bounda tenant-key rewrap-master",
    ]);
    expect(err).toEqual([
      "error: the stores acme's configuration names could not be listed: Error",
      "error: acme's key could not be read: Error",
      "error: initech's key could not be read: Error",
      "2 tenant(s) not read: what their stores hold is unknown, so keep the previous master keys",
    ]);
    expect(
      formatTenantKeysStatus(
        { stores: 1, underPreviousMaster: [], stale: [], failed: [], unreached: [] },
        "include",
      ),
    ).toEqual({
      out: ["1 tenant key store(s) read", "no tenant's key read is under a previous master key"],
      err: [],
    });
  });
});

describe("formatTenantKeysStatus on forgotten tenants' copies", () => {
  it("fails on each copy of a forgotten tenant's key holding a version or a file key, and on none holding neither", () => {
    const copy = (versions: readonly string[], files: readonly string[]) => ({
      tenant: "acme",
      namedBy: "hooli",
      named: "forgotten" as const,
      lost: { versions, files },
    });
    const status = (stale: ReturnType<typeof copy>[]) =>
      formatTenantKeysStatus(
        { stores: 2, underPreviousMaster: [], stale, failed: [], unreached: [] },
        "omit",
      );
    expect(status([copy([], [])]).err).toEqual([]);
    expect(status([copy(["t-1"], []), copy([], ["f-1", "f-2"]), copy([], [])])).toEqual({
      out: [
        "2 tenant key store(s) read",
        "no tenant's key read is under a previous master key",
        `acme: a copy of its key ${where}, though it is forgotten: remove it with bounda tenant-key remove-stale acme`,
        `acme: a copy of its key ${where}, though it is forgotten: remove it with bounda tenant-key remove-stale acme`,
        `acme: a copy of its key ${where}, though it is forgotten: remove it with bounda tenant-key remove-stale acme`,
      ],
      err: [
        "error: 2 copy(ies) of forgotten tenants' keys left: remove them with bounda tenant-key remove-stale",
      ],
    });
    expect(formatStale({ ...copy([], ["f-1", "f-2"]), named: "differs" })).toContain(
      "holding file keys f-1, f-2, which",
    );
  });
});

describe("formatKeyCopiesLeft and formatRemovedCopy", () => {
  it("names each copy left and each store not listed, and each copy removed", () => {
    const error = new Error("store unavailable");
    expect(
      formatKeyCopiesLeft(
        {
          refused: [{ tenant: "acme", namedBy: "hooli", error }],
          unreached: [{ tenant: "globex", error }],
        },
        "include",
      ),
    ).toEqual([
      "error: the stores globex's configuration names could not be listed: store unavailable",
      `error: acme's copy ${where} was not removed: store unavailable`,
    ]);
    expect(formatRemovedCopy({ tenant: "acme", namedBy: "hooli" })).toBe(
      `removed acme's copy ${where}`,
    );
  });
});
