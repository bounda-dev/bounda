import { bounda, failure } from "@bounda-dev/react-router/app";
import { createIdempotencyKey, IdempotencyKeyField } from "@bounda-dev/react-router/form";
import { data, Form, redirect, useNavigation } from "react-router";
import { formatDate } from "../format.ts";
import type { Route } from "./+types/user";

export const loader = async ({ params, context }: Route.LoaderArgs) => {
  const user = await context.get(bounda).queries.getUserDetails({ userId: params.userId });
  if (user === null) throw data("User not found", { status: 404 });
  return { user, idempotencyKey: createIdempotencyKey() };
};

export const action = async ({ request, params, context }: Route.ActionArgs) => {
  const form = await request.formData();
  if (form.get("intent") === "forget") {
    await context.get(bounda).forget(params.userId);
    return redirect("/users");
  }
  try {
    await context.get(bounda).commands.activateUser({ userId: params.userId });
  } catch (error) {
    return failure(error);
  }
  return null;
};

// Who the request acted as, from app/actor.ts: the events record it, and this read model keeps it.
function ActedBy({ actor }: { readonly actor: string | undefined }) {
  return (
    <span className="muted">
      {" "}
      by {actor === undefined ? "nobody signed in" : <code>{actor}</code>}
    </span>
  );
}

export default function User({ loaderData, actionData }: Route.ComponentProps) {
  const { user } = loaderData;
  const submitting = useNavigation().state === "submitting";
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
        <dd>
          {formatDate(user.registeredAt)}
          <ActedBy actor={user.registeredBy} />
        </dd>
        <dt>Welcome email</dt>
        <dd>{formatDate(user.welcomeEmailSentAt)}</dd>
        <dt>Activated</dt>
        <dd>
          {formatDate(user.activatedAt)}
          {user.activatedAt !== undefined && <ActedBy actor={user.activatedBy} />}
        </dd>
        <dt>Expired</dt>
        <dd>{formatDate(user.expiredAt)}</dd>
      </dl>
      {user.status === "registered" && (
        <Form method="post">
          <IdempotencyKeyField value={loaderData.idempotencyKey} />
          <button type="submit" name="intent" value="activate" disabled={submitting}>
            {submitting ? "Activating…" : "Activate"}
          </button>
        </Form>
      )}
      <Form method="post">
        <p className="muted">
          Deleting your data makes your email and name unreadable everywhere, for good, and cancels
          any reminder still waiting to be sent.
        </p>
        <button type="submit" name="intent" value="forget" disabled={submitting}>
          Delete my data
        </button>
      </Form>
      {actionData && <p className="error">{actionData.error}</p>}
    </section>
  );
}
