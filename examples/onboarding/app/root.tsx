import { boundaMiddleware } from "@bounda-dev/react-router/app";
import type { ReactNode } from "react";
import {
  Form,
  isRouteErrorResponse,
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";
import type { Route } from "./+types/root";
import { devActorOf } from "./dev-session.server.ts";
import "./app.css";

export const middleware: Route.MiddlewareFunction[] = [boundaMiddleware];

export const loader = async ({ request }: Route.LoaderArgs) => ({
  actor: (await devActorOf(request)) ?? null,
});

function DevSignIn() {
  const actor = useRouteLoaderData<typeof loader>("root")?.actor ?? null;
  return (
    <Form method="post" action="/session" className="session">
      {actor === null ? (
        <>
          <input
            name="operatorId"
            aria-label="Your id"
            placeholder="your id, e.g. support-1"
            pattern="[a-z0-9][a-z0-9\-]{0,62}"
            required
          />
          <button type="submit" name="intent" value="sign-in">
            Act as
          </button>
        </>
      ) : (
        <>
          <span>
            Acting as <code>{actor}</code>
          </span>
          <button type="submit" name="intent" value="sign-out">
            Stop
          </button>
        </>
      )}
    </Form>
  );
}

export const links: Route.LinksFunction = () => [{ rel: "icon", href: "/favicon.svg" }];

export function Layout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Onboarding on Bounda</title>
        <Meta />
        <Links />
      </head>
      <body>
        <header>
          <NavLink to="/" end>
            Onboarding
          </NavLink>
          <nav>
            <NavLink to="/register">Register</NavLink>
            <NavLink to="/activate">Activate</NavLink>
            <NavLink to="/users">Users</NavLink>
          </nav>
          <DevSignIn />
        </header>
        <main>{children}</main>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  if (isRouteErrorResponse(error)) {
    return (
      <section>
        <h1>{error.status}</h1>
        <p>{typeof error.data === "string" ? error.data : error.statusText}</p>
      </section>
    );
  }
  return (
    <section>
      <h1>Something went wrong</h1>
      <p>{error instanceof Error ? error.message : "Unknown error"}</p>
    </section>
  );
}
