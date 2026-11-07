import { type BoundaClient, ConfigurationError, type Registry } from "@bounda-dev/core";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { actAs, actorOfModule, type RequestArgs } from "./actor.ts";

const requestArgs = (user?: string): RequestArgs => {
  const url = new URL("http://localhost/");
  return {
    request: new Request(url, user === undefined ? {} : { headers: { "x-user": user } }),
    url,
    pattern: "/",
    params: {},
    context: new RouterContextProvider(),
  };
};

const client = {
  as: (actor: string) => ({ actedAs: actor }),
} as unknown as BoundaClient<Registry>;

const fromHeader = ({ request }: RequestArgs) => request.headers.get("x-user") ?? undefined;

describe("actAs", () => {
  it("binds the client to who makes the request, and leaves it as it is for nobody", async () => {
    expect(await actAs(client, fromHeader, requestArgs("user-1"))).toEqual({ actedAs: "user-1" });
    expect(await actAs(client, async () => "user-2", requestArgs())).toEqual({ actedAs: "user-2" });
    expect(await actAs(client, fromHeader, requestArgs())).toBe(client);
    expect(await actAs(client, undefined, requestArgs("user-1"))).toBe(client);
  });
});

describe("actorOfModule", () => {
  it("imports app/actor.ts on the first request only and calls its actor with each request", async () => {
    let imports = 0;
    const actor = actorOfModule(async () => {
      imports += 1;
      return { actor: fromHeader };
    });
    expect(imports).toBe(0);
    expect(await actor(requestArgs("user-1"))).toBe("user-1");
    expect(await actor(requestArgs())).toBeUndefined();
    expect(imports).toBe(1);
  });

  it("refuses a module that exports no actor function, and imports it again on the next request", async () => {
    const modules = [{}, { actor: "user-1" }, { actor: () => "user-1" }];
    const actor = actorOfModule(async () => modules.shift() ?? {});
    const refusal = new ConfigurationError(
      "app/actor.ts does not export actor, a function of the request that names who makes it",
    );
    await expect(actor(requestArgs())).rejects.toThrow(refusal);
    await expect(actor(requestArgs())).rejects.toThrow(refusal);
    expect(await actor(requestArgs())).toBe("user-1");
  });
});
