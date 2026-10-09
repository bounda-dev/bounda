---
"@bounda-dev/cloudflare": patch
---

`connect()` checks a command's `signal` before calling the object and leaves it out of the call,
since RPC cannot carry it, instead of failing to send the command. The worker answers
`HANDLER_TIMEOUT` with 504.
