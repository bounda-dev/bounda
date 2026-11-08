import { data, redirect } from "react-router";
import { isOperatorId, signIn, signOut } from "../dev-session.server.ts";
import type { Route } from "./+types/session";

// Back to the page the form was on, never to another site.
const backTo = (request: Request): string => {
  const referer = request.headers.get("Referer");
  if (referer === null || !URL.canParse(referer)) return "/";
  const url = new URL(referer);
  return url.origin === new URL(request.url).origin ? `${url.pathname}${url.search}` : "/";
};

export const loader = () => redirect("/");

export const action = async ({ request }: Route.ActionArgs) => {
  const form = await request.formData();
  if (form.get("intent") === "sign-out") return signOut(backTo(request));
  const operatorId = String(form.get("operatorId") ?? "").trim();
  if (!isOperatorId(operatorId)) {
    throw data("An id is lower-case letters, digits and dashes, such as support-1", {
      status: 400,
    });
  }
  return signIn(operatorId, backTo(request));
};
