import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { actor } from "../app/actor.ts";
import { action } from "../app/routes/session.tsx";

const ORIGIN = "http://localhost:5173";

const sessionForm = (fields: Record<string, string>, from = `${ORIGIN}/users`) =>
  new Request(`${ORIGIN}/session`, {
    method: "POST",
    headers: { Referer: from },
    body: new URLSearchParams(fields),
  });

const post = (request: Request) =>
  action({
    request,
    url: new URL(request.url),
    pattern: "/session",
    params: {},
    context: new RouterContextProvider(),
  });

// The cookie a response sets, as the browser sends it back.
const cookieOf = (response: Response): string =>
  response.headers.get("Set-Cookie")?.split(";")[0] ?? "";

const actorOf = (cookie?: string) =>
  actor({
    request: new Request(`${ORIGIN}/`, cookie === undefined ? {} : { headers: { Cookie: cookie } }),
    url: new URL(`${ORIGIN}/`),
    pattern: "/",
    params: {},
    context: new RouterContextProvider(),
  });

describe("the development session", () => {
  it("acts as the id signed in with, back on the page the form was on, and as nobody once out", async () => {
    expect(await actorOf()).toBeUndefined();
    const signedIn = await post(sessionForm({ intent: "sign-in", operatorId: " support-1 " }));
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get("Location")).toBe("/users");
    expect(await actorOf(cookieOf(signedIn))).toBe("support-1");

    const signedOut = await post(sessionForm({ intent: "sign-out" }, `${ORIGIN}/users/1?tab=a`));
    expect(signedOut.headers.get("Location")).toBe("/users/1?tab=a");
    expect(await actorOf(cookieOf(signedOut))).toBeUndefined();
  });

  it("takes only an id, never a name or an email, and sends nobody to another site", async () => {
    for (const operatorId of ["", "Ada Lovelace", "ada@example.com", "x".repeat(64)]) {
      await expect(post(sessionForm({ intent: "sign-in", operatorId }))).rejects.toMatchObject({
        init: { status: 400 },
      });
    }
    const elsewhere = await post(
      sessionForm({ intent: "sign-in", operatorId: "support-1" }, "https://example.com/"),
    );
    expect(elsewhere.headers.get("Location")).toBe("/");
    // A cookie made by hand, as anyone can: the session still names nobody unless it holds an id.
    expect(await actorOf(`dev-actor=${btoa(JSON.stringify("ada@example.com"))}`)).toBeUndefined();
    expect(await actorOf(`dev-actor=${btoa(JSON.stringify("support-2"))}`)).toBe("support-2");
    expect(await actorOf("dev-actor=not-a-cookie-it-set")).toBeUndefined();
  });
});
