import { Form, redirect, useNavigation, useSearchParams } from "react-router";
import { bounda } from "../bounda.server.ts";
import { failure, field } from "../errors.server.ts";
import type { Route } from "./+types/activate";

export const action = async ({ request, context }: Route.ActionArgs) => {
  const userId = field(await request.formData(), "userId");
  try {
    await context.get(bounda).commands.activateUser({ userId });
  } catch (error) {
    return failure(error);
  }
  return redirect(`/users/${userId}`);
};

export default function Activate({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const [search] = useSearchParams();
  return (
    <section>
      <h1>Activate</h1>
      <p className="muted">Paste the id of a registered user.</p>
      <Form method="post">
        <label>
          User id
          <input name="userId" defaultValue={search.get("userId") ?? ""} required />
        </label>
        <button type="submit" disabled={navigation.state === "submitting"}>
          {navigation.state === "submitting" ? "Activating…" : "Activate"}
        </button>
      </Form>
      {actionData && <p className="error">{actionData.error}</p>}
    </section>
  );
}
