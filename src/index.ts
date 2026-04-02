import { serve } from "bun";
import { app, websocket } from "./server/app";
import { getDb } from "./lib/db";

const port = parseInt(process.env.BBTV_PORT || "3456");

// Initialize database
getDb();

console.log(`BBTV starting on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
  websocket,
});

console.log(`BBTV ready at http://localhost:${port}`);
console.log(`Admin UI: http://localhost:${port}/admin`);
console.log(`Idle screen: http://localhost:${port}/idle`);
