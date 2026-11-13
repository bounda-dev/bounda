import { closeConnectionsOnce } from "./close-once.ts";

// The tests' own @libsql/client clients close safely even when one closes before the file's first
// `sqlite()` call, which is what installs this in an app.
closeConnectionsOnce();
