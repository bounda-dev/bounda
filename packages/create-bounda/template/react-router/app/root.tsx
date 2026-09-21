import { boundaMiddleware } from "@bounda-dev/react-router/app";
import type { ReactNode } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import type { Route } from "./+types/root";
import "./app.css";

export const middleware: Route.MiddlewareFunction[] = [boundaMiddleware];

export const links: Route.LinksFunction = () => [{ rel: "icon", href: "/favicon.svg" }];

export function Layout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
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
