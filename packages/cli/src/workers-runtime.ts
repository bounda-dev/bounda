import { type ResolveHookSync, registerHooks } from "node:module";

// What `cloudflare:workers` exports, for a command that imports a Cloudflare project's modules
// in Node to read them, never to run them: classes to extend and an empty `env`.
const STAND_IN = `data:text/javascript,${encodeURIComponent(
  [
    "class Entrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
    "export class DurableObject extends Entrypoint {}",
    "export class WorkerEntrypoint extends Entrypoint {}",
    "export class WorkflowEntrypoint extends Entrypoint {}",
    "export class RpcTarget {}",
    "export class RpcStub {}",
    "export const env = {};",
    "export const waitUntil = () => {};",
  ].join("\n"),
)}`;

// Implements Node's resolve hook.
export const resolveWorkersRuntime: ResolveHookSync = (specifier, context, nextResolve) =>
  specifier === "cloudflare:workers"
    ? { url: STAND_IN, shortCircuit: true }
    : nextResolve(specifier, context);

let registered = false;

export interface StandInWorkersRuntimeFunction {
  (): void;
}

// For the rest of the process: the commands that call it read the project and exit.
export const standInWorkersRuntime: StandInWorkersRuntimeFunction = () => {
  if (registered) return;
  registered = true;
  registerHooks({ resolve: resolveWorkersRuntime });
};
