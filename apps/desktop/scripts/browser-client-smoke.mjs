import { createServer } from "node:http";
import { DesktopBrowserBackend } from "../../daemon/dist/services/browser-host-client.js";

const dataDir = process.env.FORGE_DATA_DIR;
if (!dataDir) throw new Error("FORGE_DATA_DIR is required");

const html = `<!doctype html><html><head><title>Forge Browser Smoke</title></head><body>
  <label>Query <input aria-label="Query"></label>
  <button onclick="document.querySelector('#result').textContent='done:'+document.querySelector('input').value">Run</button>
  <div id="result">waiting</div>
</body></html>`;
const web = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});

await new Promise((resolve, reject) => web.listen(0, "127.0.0.1", resolve).once("error", reject));
const port = web.address().port;
const browser = new DesktopBrowserBackend(dataDir);
let tab;
try {
  tab = await browser.open({ url: `http://127.0.0.1:${port}/` });
  const first = await browser.snapshot(tab.id);
  const input = first.elements.find((element) => element.name === "Query");
  const button = first.elements.find((element) => element.name === "Run");
  if (!input || !button) throw new Error("DOM snapshot did not expose the expected controls");
  await browser.type({ tabId: tab.id, ref: input.ref, text: "hello", clear: true });
  await browser.click({ tabId: tab.id, ref: button.ref });
  const second = await browser.snapshot(tab.id);
  if (!second.text?.includes("done:hello")) throw new Error(`Interaction failed: ${second.text}`);
  const screenshot = await browser.screenshot(tab.id);
  if (!screenshot.data.startsWith("iVBOR")) throw new Error("Screenshot is not a PNG image");
  console.log(JSON.stringify({ ok: true, title: second.title, result: "done:hello", screenshot: { width: screenshot.width, height: screenshot.height } }));
} finally {
  if (tab) await browser.close(tab.id).catch(() => undefined);
  await new Promise((resolve) => web.close(() => resolve()));
}
