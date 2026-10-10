import type {
  Bare,
  ProcessStore,
  QuietStore,
  RegionStore,
  SlicedStore,
  Store,
} from "./test-worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly STORE: DurableObjectNamespace<InstanceType<typeof Store>>;
      readonly PROCESS_STORE: DurableObjectNamespace<InstanceType<typeof ProcessStore>>;
      readonly QUIET_STORE: DurableObjectNamespace<InstanceType<typeof QuietStore>>;
      readonly SLICED_STORE: DurableObjectNamespace<InstanceType<typeof SlicedStore>>;
      readonly REGION_STORE: DurableObjectNamespace<InstanceType<typeof RegionStore>>;
      readonly BARE: DurableObjectNamespace<Bare>;
      readonly STORE_REGION: string;
    }
    interface GlobalProps {
      mainModule: typeof import("./test-worker.ts");
    }
  }
}
