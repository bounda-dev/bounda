import type { QuietStore, Store } from "./test-worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly STORE: DurableObjectNamespace<InstanceType<typeof Store>>;
      readonly QUIET_STORE: DurableObjectNamespace<InstanceType<typeof QuietStore>>;
    }
    interface GlobalProps {
      mainModule: typeof import("./test-worker.ts");
    }
  }
}
