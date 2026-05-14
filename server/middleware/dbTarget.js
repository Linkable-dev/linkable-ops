import { runWithDbTarget } from "../lib/cloudsql.js";

// Reads the per-request DB target from the x-db-target header and runs the
// rest of the request handler inside an AsyncLocalStorage scope so any
// downstream cloudSqlQuery() call picks the matching pool. Defaults to prod
// when the header is missing or unrecognized.
export function dbTargetMiddleware(req, _res, next) {
  const raw = (req.headers["x-db-target"] || "prod").toString().toLowerCase();
  const target = raw === "dev" ? "dev" : "prod";
  req.dbTarget = target;
  runWithDbTarget(target, () => next());
}
