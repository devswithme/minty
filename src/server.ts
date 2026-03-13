import "dotenv/config";
import app from "./index";

const port = Number(process.env.PORT ?? 3000);

if (!Number.isFinite(port) || port <= 0) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

const server = Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`API listening on http://0.0.0.0:${server.port}`);

