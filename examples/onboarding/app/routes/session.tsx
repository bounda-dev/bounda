import { data, redirect } from "react-router";
import { backTo, isOperatorId, signIn, signOut } from "../dev-session.server.ts";
import type { Route } from "./+types/session";

export const loader = () => redirect("/");

export const action = async ({ request }: Route.ActionArgs) => {
  const form = await request.formData();
  const back = backTo(request);
  if (form.get("intent") === "sign-out") return signOut({ back });
  const operatorId = String(form.get("operatorId") ?? "").trim();
  if (!isOperatorId(operatorId)) {
    throw data("An id is lower-case letters, digits and dashes, such as support-1", {
      status: 400,
    });
  }
  return signIn({ operatorId, back });
};
