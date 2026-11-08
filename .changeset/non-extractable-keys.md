---
"@bounda-dev/core": minor
---

The runtime holds a person's key only as a WebCrypto key that can never be exported, in the cache of unwrapped keys and in every seal and open. `masterKey` wraps and unwraps through WebCrypto (`wrapKey`, and `unwrapKey` straight into a key that cannot be exported), so under it a person's raw key never reaches JavaScript memory, on Node, in a Durable Object or in a test app given the master key; the bytes read from the master key's variable are zeroed once imported. Without a key wrapper the store keeps a key's text, as before: the runtime exports a new key once to store it and imports what it reads at once. A `KeyWrapper` of your own still deals in bytes: the runtime zeroes the array it gives `wrap` once it settles, and imports what `unwrap` resolves and zeroes it at once; an `unwrap` that resolves anything but a `Uint8Array` fails with `ConfigurationError`. Creating a key no longer unwraps it again.

Breaking: a key's fingerprint is now its key check value (the AES-GCM tag of nothing under a nonce no value is sealed under), which the runtime computes from the key itself and checks on every read, for keys kept unwrapped too, instead of the SHA-256 of the raw key. A database written by an earlier version must be created anew. `KeyWrapperDefinition` no longer exposes `create`: build one with `masterKey` or `defineKeyWrapper`, as before.
