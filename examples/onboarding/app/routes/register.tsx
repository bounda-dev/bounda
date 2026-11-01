import { bounda, failure } from "@bounda-dev/react-router/app";
import { createIdempotencyKey, IdempotencyKeyField } from "@bounda-dev/react-router/form";
import { Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/register";

// The id is made with the page, so a registration sent again is the same registration.
export const loader = () => ({
  userId: crypto.randomUUID(),
  idempotencyKey: createIdempotencyKey(),
});

export const action = async ({ request, context }: Route.ActionArgs) => {
  const form = await request.formData();
  const userId = String(form.get("userId") ?? "");
  try {
    await context.get(bounda).commands.registerUser({
      userId,
      email: String(form.get("email") ?? ""),
      name: String(form.get("name") ?? ""),
    });
  } catch (error) {
    return failure(error);
  }
  return redirect(`/users/${userId}`);
};

export default function Register({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  return (
    <section>
      <h1>Register</h1>
      <Form method="post">
        <input type="hidden" name="userId" value={loaderData.userId} />
        <IdempotencyKeyField value={loaderData.idempotencyKey} />
        <label>
          Name
          <input name="name" required />
        </label>
        <label>
          Email
          <input name="email" type="email" required />
        </label>
        <button type="submit" disabled={navigation.state === "submitting"}>
          {navigation.state === "submitting" ? "Registering…" : "Register"}
        </button>
      </Form>
      {actionData && (
        <div className="error">
          <p>{actionData.error}</p>
          <ul>
            {actionData.issues.map((issue) => (
              <li key={issue.path.join(".")}>
                {issue.path.join(".")}: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
