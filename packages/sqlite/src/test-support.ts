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

interface NamespaceRequest {
  readonly method: "POST" | "DELETE";
  readonly path: string;
}

const IMAGE = "ghcr.io/tursodatabase/libsql-server:v0.24.33";
const HTTP_PORT = 8080;
const ADMIN_PORT = 9090;
const ADMIN_TIMEOUT_MS = 30_000;

const reuseContainer = process.env.BOUNDA_LIBSQL_REUSE === "1";

const onNamespace = async (
  container: StartedTestContainer,
  namespace: string,
  { method, path }: NamespaceRequest,
): Promise<void> => {
  const admin = `http://${container.getHost()}:${container.getMappedPort(ADMIN_PORT)}`;
  const response = await fetch(`${admin}/v1/namespaces/${namespace}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "POST" ? { body: "{}" } : {}),
    signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `${method} namespace ${namespace}: ${response.status} ${await response.text()}`,
    );
  }
};

const startPlain = async (): Promise<TestServer | null> => {
  const container = await startContainer(() =>
    new GenericContainer(IMAGE)
      .withExposedPorts(HTTP_PORT)
      .withWaitStrategy(Wait.forHttp("/health", HTTP_PORT))
      .start(),
  );
  if (container === null) return null;
  return {
    url: `http://${container.getHost()}:${container.getMappedPort(HTTP_PORT)}`,
    close: () => container.stop().then(() => undefined),
  };
};

// One server for every run, as Stryker runs the tests once per mutant, several at a time. Each run
// gets a namespace, which the server picks by the first label of the host a request names, so the
// URL relies on `<namespace>.<host>` resolving to the host, as `*.localhost` does on macOS and under
// systemd-resolved, which GitHub's Ubuntu runners use. A namespace is a database file with a
// write lock of its own: a run killed in a transaction, as Stryker kills one on a timeout, holds
// only its own, where in one shared database it held every later run's.
const startReused = async (): Promise<TestServer | null> => {
  const container = await startContainer(() =>
    new GenericContainer(IMAGE)
      .withCommand([
        "/bin/sqld",
        "--enable-namespaces",
        "--disable-default-namespace",
        "--admin-listen-addr",
        `0.0.0.0:${ADMIN_PORT}`,
      ])
      .withExposedPorts(HTTP_PORT, ADMIN_PORT)
      .withWaitStrategy(Wait.forAll([Wait.forListeningPorts(), Wait.forHttp("/health", HTTP_PORT)]))
      .withReuse()
      .start(),
  );
  if (container === null) return null;
  const namespace = `r${randomBytes(8).toString("hex")}`;
  await onNamespace(container, namespace, { method: "POST", path: "/create" });
  return {
    url: `http://${namespace}.${container.getHost()}:${container.getMappedPort(HTTP_PORT)}`,
    close: () => onNamespace(container, namespace, { method: "DELETE", path: "" }),
  };
};

// A libSQL server, or null when Docker is not running outside CI. BOUNDA_LIBSQL_REUSE=1 keeps one
// for every run, each on a database of its own that it deletes at its end.
export const startTestServer: StartTestServerFunction = () =>
  reuseContainer ? startReused() : startPlain();
