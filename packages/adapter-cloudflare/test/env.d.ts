import type { Store } from "./test-worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly STORE: DurableObjectNamespace<InstanceType<typeof Store>>;
    }
  }
}
