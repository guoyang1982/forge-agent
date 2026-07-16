import { createServer } from "node:http";

const host = process.env.FORGE_CHANNEL_GATEWAY_HOST ?? "127.0.0.1";
const port = Number(process.env.FORGE_CHANNEL_GATEWAY_PORT ?? "8787");
const startedAt = new Date().toISOString();
const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        running: true,
        pid: process.pid,
        startedAt,
        listenUrl: `http://${host}:${port}`,
        adapters: [],
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, host);
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
