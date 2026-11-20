import type {
  Bare,
  EuKeeper,
  EuStore,
  Keeper,
  KeptKeeper,
  KeptStore,
  LedgerStore,
  ProcessStore,
  QuietStore,
  RegionStore,
  RetainedStore,
  SlicedStore,
  SnapshotStore,
  Store,
  UnboundEuKeeper,
  UnboundEuStore,
  WitnessedStore,
  WrappedStore,
} from "./test-worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly STORE: DurableObjectNamespace<InstanceType<typeof Store>>;
      readonly PROCESS_STORE: DurableObjectNamespace<InstanceType<typeof ProcessStore>>;
      readonly QUIET_STORE: DurableObjectNamespace<InstanceType<typeof QuietStore>>;
      readonly SLICED_STORE: DurableObjectNamespace<InstanceType<typeof SlicedStore>>;
      readonly REGION_STORE: DurableObjectNamespace<InstanceType<typeof RegionStore>>;
      readonly RETAINED_STORE: DurableObjectNamespace<InstanceType<typeof RetainedStore>>;
      readonly WRAPPED_STORE: DurableObjectNamespace<InstanceType<typeof WrappedStore>>;
      readonly LEDGER_STORE: DurableObjectNamespace<InstanceType<typeof LedgerStore>>;
      readonly SNAPSHOT_STORE: DurableObjectNamespace<InstanceType<typeof SnapshotStore>>;
      readonly WITNESSED_STORE: DurableObjectNamespace<InstanceType<typeof WitnessedStore>>;
      readonly FORGET_LEDGER: KVNamespace;
      readonly TENANT_KEYS: KVNamespace;
      readonly BARE: DurableObjectNamespace<Bare>;
      readonly EU_STORE: DurableObjectNamespace<InstanceType<typeof EuStore>>;
      readonly UNBOUND_EU_STORE: DurableObjectNamespace<InstanceType<typeof UnboundEuStore>>;
      readonly KEEPER: DurableObjectNamespace<InstanceType<typeof Keeper>>;
      readonly EU_KEEPER: DurableObjectNamespace<InstanceType<typeof EuKeeper>>;
      readonly UNBOUND_EU_KEEPER: DurableObjectNamespace<InstanceType<typeof UnboundEuKeeper>>;
      readonly KEPT_KEEPER: DurableObjectNamespace<InstanceType<typeof KeptKeeper>>;
      readonly KEPT_STORE: DurableObjectNamespace<InstanceType<typeof KeptStore>>;
      readonly STORE_REGION: string;
      readonly BOUNDA_MASTER_KEY: string;
    }
    interface GlobalProps {
      mainModule: typeof import("./test-worker.ts");
    }
  }
}
