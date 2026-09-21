import { bounda } from "@bounda-dev/react-router/app";
import { Link } from "react-router";
import { formatDate } from "../format.ts";
import type { Route } from "./+types/users";

export const loader = ({ request, context }: Route.LoaderArgs) => {
  const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
  return context
    .get(bounda)
    .queries.listUsers({ page: Number.isInteger(page) && page > 0 ? page : 1 });
};

export default function Users({ loaderData }: Route.ComponentProps) {
  const { users, total, active, page, pages } = loaderData;
  return (
    <section>
      <h1>Users</h1>
      <p className="muted">
        {total} registered, {active} active.
      </p>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Status</th>
            <th>Registered</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.userId}>
              <td>
                <Link to={`/users/${user.userId}`}>{user.name}</Link>
              </td>
              <td>{user.email}</td>
              <td>
                <span className="badge" data-status={user.status}>
                  {user.status}
                </span>
              </td>
              <td>{formatDate(user.registeredAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {pages > 1 && (
        <nav className="pager">
          {page > 1 && <Link to={`/users?page=${page - 1}`}>Previous</Link>}
          <span className="muted">
            Page {page} of {pages}
          </span>
          {page < pages && <Link to={`/users?page=${page + 1}`}>Next</Link>}
        </nav>
      )}
    </section>
  );
}
