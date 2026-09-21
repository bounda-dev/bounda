import { Form, redirect, useNavigation } from "react-router";
import { bounda } from "../bounda.server.ts";
import { failure, field } from "../errors.server.ts";
import type { Route } from "./+types/register";

export const action = async ({ request, context }: Route.ActionArgs) => {
  const form = await request.formData();
  const userId = crypto.randomUUID();
  const app = context.get(bounda);
  try {
    await app.commands.registerUser({
      userId,
      email: field(form, "email"),
      name: field(form, "name"),
    });
    await app.processUntilIdle();
  } catch (error) {
    return failure(error);
  }
  return redirect(`/users/${userId}`);
};

export default function Register({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  return (
    <section>
      <h1>Register</h1>
      <Form method="post">
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
