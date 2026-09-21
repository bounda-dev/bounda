import type { BoundaApp } from "@bounda-dev/core";
import { RouterContextProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { createBounda } from "./create-bounda.ts";

const started: string[] = [];
const app = {
  commands: {},
  start: () => {
    started.push("start");
  },
  stop: async () => {
    started.push("stop");
  },
} as unknown as BoundaApp;

vi.mock("@bounda-dev/core/node", () => ({ boot: vi.fn(async () => app) }));

describe("createBounda without arguments", () => {
  it("boots with boot() from @bounda-dev/core/node under the default key", async () => {
    const { boot } = await import("@bounda-dev/core/node");
    const { bounda, boundaMiddleware, dispose } = createBounda();
    const context = new RouterContextProvider();
    const url = new URL("http://localhost/");

    await boundaMiddleware(
      { request: new Request(url), url, pattern: "/", params: {}, context },
      async () => "ok",
    );

    expect(boot).toHaveBeenCalledTimes(1);
    expect(context.get(bounda).start).toBe(app.start);
    expect(Symbol.for("bounda.app") in globalThis).toBe(true);
    await dispose();
    expect(started).toEqual(["start", "stop"]);
  });
});
