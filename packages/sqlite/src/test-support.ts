import { randomBytes } from "node:crypto";
import { startContainer } from "@bounda-dev/test-containers";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

export interface TestServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

export interface StartTestServerFunction {
  (): Promise<TestServer | null>;
}

const HTTP_PORT = 8080;
const ADMIN_PORT = 9090;

const reuseContainer = process.env.BOUNDA_LIBSQL_REUSE === "1";

const onNamespace = async (
  container: StartedTestContainer,
  namespace: string,
  action: { readonly method: "POST" | "DELETE"; readonly path: string },
): Promise<void> => {
  const admin = `http://${container.getHost()}:${container.getMappedPort(ADMIN_PORT)}`;
  const response = await fetch(`${admin}/v1/namespaces/${namespace}${action.path}`, {
    method: action.method,
    headers: { "content-type": "application/json" },
    ...(action.method === "POST" ? { body: "{}" } : {}),
  });
  if (!response.ok) {
    throw new Error(
      `${action.method} namespace ${namespace}: ${response.status} ${await response.text()}`,
    );
  }
};

// A database of its own on a libSQL server, or null when Docker is not running outside CI: a
// namespace, which the server picks by the first label of the host a request names.
// BOUNDA_LIBSQL_REUSE=1 keeps one server for every run, as Stryker runs the tests once per mutant,
// several at a time; each run still gets a namespace it deletes at its end. A namespace is a
// database file with a write lock of its own, so a run killed in a transaction (Stryker kills one
// on a timeout) leaves the server's other runs free to write.
export const startTestServer: StartTestServerFunction = async () => {
  const definition = new GenericContainer("ghcr.io/tursodatabase/libsql-server:v0.24.33")
    .withCommand([
      "/bin/sqld",
      "--enable-namespaces",
      "--disable-default-namespace",
      "--admin-listen-addr",
      `0.0.0.0:${ADMIN_PORT}`,
    ])
    .withExposedPorts(HTTP_PORT, ADMIN_PORT)
    .withWaitStrategy(Wait.forHttp("/health", HTTP_PORT));
  const container = await startContainer(() =>
    (reuseContainer ? definition.withReuse() : definition).start(),
  );
  if (container === null) return null;
  const namespace = `r${randomBytes(8).toString("hex")}`;
  await onNamespace(container, namespace, { method: "POST", path: "/create" });
  return {
    url: `http://${namespace}.${container.getHost()}:${container.getMappedPort(HTTP_PORT)}`,
    close: async () => {
      if (reuseContainer) await onNamespace(container, namespace, { method: "DELETE", path: "" });
      else await container.stop();
    },
  };
};
