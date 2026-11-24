---
"create-bounda": minor
---

Projects on Node come with a forget ledger, as projects on Cloudflare do: `./ledger/forget-ledger.db` with SQLite, left out of Git, or a third PostgreSQL database in `FORGET_LEDGER_URL`, which the configuration now requires. It declares the same location as the storage, and a backup of the database restored with the app stopped forgets again, at the next start, whoever was forgotten after it was taken.
