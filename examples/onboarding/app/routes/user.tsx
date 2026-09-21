import { data, Form, useNavigation } from "react-router";
import { bounda } from "../bounda.server.ts";
import { failure } from "../errors.server.ts";
import type { Route } from "./+types/user";

export const loader = async ({ params, context }: Route.LoaderArgs) => {
  const user = await context.get(bounda).queries.getUserDetails({ userId: params.userId });
  if (user === null) throw data("User not found", { status: 404 });
  return user;
};

export const action = async ({ params, context }: Route.ActionArgs) => {
  const app = context.get(bounda);
  try {
    await app.commands.activateUser({ userId: params.userId });
    await app.processUntilIdle();
  } catch (error) {
    return failure(error);
  }
  return null;
};

const when = (date: Date | undefined) => (date ? new Date(date).toLocaleString() : "—");

export default function User({ loaderData: user, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  return (
    <section>
      <h1>{user.name}</h1>
      <dl>
        <dt>Id</dt>
        <dd>
          <code>{user.userId}</code>
        </dd>
        <dt>Email</dt>
        <dd>{user.email}</dd>
        <dt>Status</dt>
        <dd>
          <span className="badge" data-status={user.status}>
            {user.status}
          </span>
        </dd>
        <dt>Registered</dt>
        <dd>{when(user.registeredAt)}</dd>
        <dt>Welcome email</dt>
        <dd>{when(user.welcomeEmailSentAt)}</dd>
        <dt>Activated</dt>
        <dd>{when(user.activatedAt)}</dd>
        <dt>Expired</dt>
        <dd>{when(user.expiredAt)}</dd>
      </dl>
      {user.status === "registered" && (
        <Form method="post">
          <button type="submit" disabled={navigation.state === "submitting"}>
            {navigation.state === "submitting" ? "Activating…" : "Activate"}
          </button>
        </Form>
      )}
      {actionData && <p className="error">{actionData.error}</p>}
    </section>
  );
}
