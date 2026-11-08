import { createCookie, redirect } from "react-router";

// A development sign-in: whoever opens the app says who they are, and nothing checks it. An app
// with users reads its real session in app/actor.ts instead, and drops this file.
const devActorCookie = createCookie("dev-actor", { httpOnly: true, sameSite: "lax", path: "/" });

// An id, never a name or an email: events keep the actor in the clear and are never deleted.
const OPERATOR_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const isOperatorId = (value: unknown): value is string =>
  typeof value === "string" && OPERATOR_ID.test(value);

export const devActorOf = async (request: Request): Promise<string | undefined> => {
  const value: unknown = await devActorCookie.parse(request.headers.get("Cookie"));
  return isOperatorId(value) ? value : undefined;
};

export const signIn = async (operatorId: string, back: string): Promise<Response> =>
  redirect(back, { headers: { "Set-Cookie": await devActorCookie.serialize(operatorId) } });

export const signOut = async (back: string): Promise<Response> =>
  redirect(back, {
    headers: { "Set-Cookie": await devActorCookie.serialize("", { maxAge: 0 }) },
  });
