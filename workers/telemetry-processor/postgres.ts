// Immutable E3 fork: postgres.js v3.4.9 + upstream nextWrite fix + guards that
// reject use and ignore release after a reserved socket closes. Remove this pin
// after all three guards ship in an upstream release. Provenance:
// https://github.com/porsager/postgres/pull/1168
// https://github.com/e3-solutions/postgres/commit/a7bc76a441ce2e8acf81c226951e9c5e26570d7a
// @deno-types="./postgres.d.ts"
import postgres from "postgres-fixed";

export default postgres;
