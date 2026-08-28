// postgres.js can schedule a socket write after an asynchronous close. This
// immutable commit is v3.4.9 plus the exact upstream fix, pinned until the fix
// is included in a published release:
// https://github.com/porsager/postgres/pull/1168
// @deno-types="./postgres.d.ts"
import postgres from "postgres-fixed";

export default postgres;
