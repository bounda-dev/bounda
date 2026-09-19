import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../contracts/errors.ts";
import { selectCollaborators } from "./collaborators.ts";

const http = { reserve: () => Promise.resolve("http") };
const fake = { reserve: () => Promise.resolve("fake") };
const mailer = { send: () => Promise.resolve() };

describe("selectCollaborators", () => {
  it("uses the configured implementation", () => {
    const selected = selectCollaborators({
      commandName: "placeOrder",
      implementations: { inventory: { http, fake } },
      config: { inventory: { use: "fake" } },
    });
    expect(selected).toEqual({ inventory: fake });
  });

  it("picks the only implementation when nothing is configured", () => {
    const selected = selectCollaborators({
      commandName: "placeOrder",
      implementations: { inventory: { http }, mailer: { resend: mailer } },
      config: undefined,
    });
    expect(selected).toEqual({ inventory: http, mailer });
  });

  it("returns an empty object for a command without collaborators", () => {
    expect(
      selectCollaborators({ commandName: "payOrder", implementations: {}, config: undefined }),
    ).toEqual({});
  });

  it("demands a choice when several implementations exist and none is configured", () => {
    expect(() =>
      selectCollaborators({
        commandName: "placeOrder",
        implementations: { inventory: { http, fake } },
        config: undefined,
      }),
    ).toThrow(
      'Command "placeOrder", collaborator "inventory": choose an implementation with commands.placeOrder.inventory.use. Available: "http", "fake"',
    );
  });

  it("rejects an implementation that does not exist", () => {
    expect(() =>
      selectCollaborators({
        commandName: "placeOrder",
        implementations: { inventory: { http, fake } },
        config: { inventory: { use: "grpc" } },
      }),
    ).toThrow(
      'Command "placeOrder", collaborator "inventory": implementation "grpc" not found. Available: "http", "fake"',
    );
  });

  it("rejects configuration for collaborators the command does not have", () => {
    let error: unknown;
    try {
      selectCollaborators({
        commandName: "placeOrder",
        implementations: { inventory: { http } },
        config: { inventory: { use: "http" }, notifier: { use: "console" } },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toBe(
      'Command "placeOrder": configuration names collaborators that do not exist: "notifier"',
    );
  });
});
