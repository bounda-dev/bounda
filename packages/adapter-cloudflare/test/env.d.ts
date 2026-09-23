import type { Bare, QuietStore, SlicedStore, Store } from "./test-worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly STORE: DurableObjectNamespace<InstanceType<typeof Store>>;
      readonly QUIET_STORE: DurableObjectNamespace<InstanceType<typeof QuietStore>>;
      readonly SLICED_STORE: DurableObjectNamespace<InstanceType<typeof SlicedStore>>;
      readonly BARE: DurableObjectNamespace<Bare>;
    }
    interface GlobalProps {
      mainModule: typeof import("./test-worker.ts");
    }
  }
}
