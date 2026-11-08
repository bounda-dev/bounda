import { createCookie, redirect } from "react-router";

// A development sign-in: whoever opens the app says who they are, and nothing checks it. An app
// with users reads its real session in app/actor.ts instead, and drops this file.
const devActorCookie = createCookie("dev-actor", { httpOnly: true, sameSite: "lax", path: "/" });

// An id, never a name or an email: events keep the actor in the clear and are never deleted.
const OPERATOR_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface IsOperatorIdFunction {
  (value: unknown): value is string;
}

export const isOperatorId: IsOperatorIdFunction = (value): value is string =>
  typeof value === "string" && OPERATOR_ID.test(value);

export interface DevActorOfFunction {
  (request: Request): Promise<string | undefined>;
}

export const devActorOf: DevActorOfFunction = async (request) => {
  const value: unknown = await devActorCookie.parse(request.headers.get("Cookie"));
  return isOperatorId(value) ? value : undefined;
};

export interface SignInArgs {
  readonly operatorId: string;
  // Where the browser goes once signed in: a path of this site.
  readonly back: string;
}

export interface SignInFunction {
  (args: SignInArgs): Promise<Response>;
}

export const signIn: SignInFunction = async ({ operatorId, back }) =>
  redirect(back, { headers: { "Set-Cookie": await devActorCookie.serialize(operatorId) } });

export interface SignOutArgs {
  readonly back: string;
}

export interface SignOutFunction {
  (args: SignOutArgs): Promise<Response>;
}

export const signOut: SignOutFunction = async ({ back }) =>
  redirect(back, {
    headers: { "Set-Cookie": await devActorCookie.serialize("", { maxAge: 0 }) },
  });

export interface BackToFunction {
  (request: Request): string;
}

// The page the form was on, never another site.
export const backTo: BackToFunction = (request) => {
  const referer = request.headers.get("Referer");
  if (referer === null || !URL.canParse(referer)) return "/";
  const url = new URL(referer);
  // A path such as `//elsewhere.example/` would be read as another site's address.
  if (url.origin !== new URL(request.url).origin || url.pathname.startsWith("//")) return "/";
  return `${url.pathname}${url.search}`;
};
