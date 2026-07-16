import { createServer } from "node:http";

const port = Number(process.env.FORGE_MOBILE_E2E_MODEL_PORT ?? "58999");
const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": forge-mobile-e2e keeps the run pending until cancellation\n\n");
  const timer = setInterval(() => res.write(": ping\n\n"), 1_000);
  req.once("close", () => clearInterval(timer));
  res.once("close", () => clearInterval(timer));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock model listening on 127.0.0.1:${port}`);
});

const close = () => server.close(() => process.exit(0));
process.on("SIGINT", close);
process.on("SIGTERM", close);
