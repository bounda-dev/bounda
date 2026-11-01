import { bounda, failure } from "@bounda-dev/react-router/app";
import { createIdempotencyKey, IdempotencyKeyField } from "@bounda-dev/react-router/form";
import { Form, redirect, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/activate";

export const loader = () => ({ idempotencyKey: createIdempotencyKey() });

export const action = async ({ request, context }: Route.ActionArgs) => {
  const form = await request.formData();
  const userId = String(form.get("userId") ?? "");
  try {
    await context.get(bounda).commands.activateUser({ userId });
  } catch (error) {
    return failure(error);
  }
  return redirect(`/users/${userId}`);
};

export default function Activate({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const [search] = useSearchParams();
  return (
    <section>
      <h1>Activate</h1>
      <p className="muted">Paste the id of a registered user.</p>
      <Form method="post">
        <IdempotencyKeyField value={loaderData.idempotencyKey} />
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
