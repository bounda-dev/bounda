---
"@bounda-dev/core": patch
"@bounda-dev/cli": patch
---

Refuse a policy and a process of one aggregate with the same name. The inbox records a handled event by the reaction's name alone, so the two would each skip, silently, the events the other had handled: a process never opened its instance. `bounda generate` now rejects `policies/checkout.ts` next to `processes/checkout/`, and two policies whose keys meet (`policies/payment-refund-on-payment-failed.ts` next to `policies/payment/refund-on-payment-failed.ts`); boot rejects a registry whose policy and process share a name.
