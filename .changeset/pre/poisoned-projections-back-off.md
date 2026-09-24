---
"@bounda-dev/core": minor
---

A projection that keeps failing on an event no longer drags its whole batch down with it, floods
the logs or hides what it is stuck on. When a projection throws, the events of the batch before
the one that failed are committed on their own, so the checkpoint and the lag stop right at that
event. Background passes then leave that read model alone for a growing delay, from one second up
to thirty (`runtime.dispatcher.backoff`), while the others carry on; the first batch that goes
through resets it, and another subscriber recovering from failures of its own retries every
failing one at once. `catchUpReadModels`, and read-your-writes with it, respects the backoff;
`processUntilIdle` does not. `getLag()` reports `failing` for a subscriber this process saw fail:
the event it is stuck on, the error, how many attempts, since when and when it is tried next. The
`subscriber failed` log line now carries `failedPosition`. A read model still never skips an event.
