import { bounda } from "@bounda-dev/react-router/app";
import { Form, redirect, useNavigation } from "react-router";
import { failure, field } from "../errors.server.ts";
import type { Route } from "./+types/home";

export const loader = async ({ request, context }: Route.LoaderArgs) => {
  const customerId = new URL(request.url).searchParams.get("customer") ?? "ada";
  const { orders, total } = await context.get(bounda).queries.listOrders({ customerId });
  return { customerId, orders, total };
};

export const action = async ({ request, context }: Route.ActionArgs) => {
  const form = await request.formData();
  const customerId = field(form, "customerId");
  try {
    await context.get(bounda).commands.placeOrder({
      orderId: crypto.randomUUID(),
      customerId,
      total: Number(field(form, "total")),
    });
  } catch (error) {
    return failure(error);
  }
  return redirect(`/?customer=${encodeURIComponent(customerId)}`);
};

export default function Home({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const { customerId, orders, total } = loaderData;
  return (
    <>
      <h1>Orders</h1>
      <Form method="post">
        <label>
          Customer
          <input name="customerId" defaultValue={customerId} required />
        </label>
        <label>
          Total
          <input name="total" type="number" min="0.01" step="0.01" defaultValue="42" required />
        </label>
        <button type="submit" disabled={navigation.state === "submitting"}>
          {navigation.state === "submitting" ? "Placing…" : "Place order"}
        </button>
      </Form>
      {actionData && <p className="error">{actionData.error}</p>}
      <h2>
        {customerId}: {orders.length} order(s), {total} in total
      </h2>
      <ul>
        {orders.map((order) => (
          <li key={order.orderId}>
            <code>{order.orderId}</code> — {order.total}
          </li>
        ))}
      </ul>
    </>
  );
}
