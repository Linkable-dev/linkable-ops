// Local development entry point: the same app the deployment serves, on a port.
import app from "./app.js";
import { closeCloudSql } from "./lib/cloudsql.js";

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Linkable Ops server running on port ${PORT}`));

process.on("SIGTERM", async () => {
  await closeCloudSql();
  process.exit(0);
});
