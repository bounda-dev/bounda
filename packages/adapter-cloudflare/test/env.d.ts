import type { TestStore } from "./test-worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly STORE: DurableObjectNamespace<TestStore>;
    }
  }
}
