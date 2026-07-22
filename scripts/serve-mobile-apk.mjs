#!/usr/bin/env node
/**
 * Serve a Forge Mobile APK on the local network with a QR install page.
 *
 * Usage:
 *   node scripts/serve-mobile-apk.mjs [--apk path/to.apk] [--port 8765]
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RELEASE_DIR = resolve(ROOT, "release");
const DEFAULT_PORT = Number.parseInt(process.env.PORT ?? "8765", 10);

function parseArgs(argv) {
  let apkPath = null;
  let port = DEFAULT_PORT;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apk" && argv[i + 1]) {
      apkPath = resolve(argv[++i]);
      continue;
    }
    if (arg === "--port" && argv[i + 1]) {
      port = Number.parseInt(argv[++i], 10);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/serve-mobile-apk.mjs [--apk path] [--port ${DEFAULT_PORT}]`);
      process.exit(0);
    }
  }
  return { apkPath, port };
}

function resolveApk(explicitPath) {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`APK not found: ${explicitPath}`);
    }
    return explicitPath;
  }
  if (!existsSync(RELEASE_DIR)) {
    throw new Error("No APK found. Run: pnpm pack:mobile:android");
  }
  const candidates = readdirSync(RELEASE_DIR)
    .filter((name) => name.endsWith(".apk"))
    .map((name) => resolve(RELEASE_DIR, name))
    .filter((path) => statSync(path).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (candidates.length === 0) {
    throw new Error(`No APK in ${RELEASE_DIR}. Run: pnpm pack:mobile:android`);
  }
  return candidates[0];
}

function getLanIp() {
  const nets = networkInterfaces();
  const preferred = ["en0", "en1", "wlan0", "eth0"];
  for (const name of preferred) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  for (const ifaces of Object.values(nets)) {
    for (const net of ifaces ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildInstallPage({ title, downloadUrl, qrDataUrl, sizeLabel }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0f14; color: #e8eef7; }
    main { width: min(420px, 92vw); padding: 28px 24px; border: 1px solid #243041; border-radius: 18px; background: #121821; box-shadow: 0 24px 80px rgba(0,0,0,.35); text-align: center; }
    h1 { margin: 0 0 8px; font-size: 1.35rem; }
    p { margin: 0 0 14px; color: #9fb0c5; line-height: 1.5; }
    img { width: 240px; height: 240px; border-radius: 12px; background: #fff; padding: 10px; }
    a.button { display: inline-block; margin-top: 8px; padding: 12px 18px; border-radius: 999px; background: #3b82f6; color: #fff; text-decoration: none; font-weight: 600; }
    code { word-break: break-all; color: #cbd5e1; }
    .meta { font-size: .92rem; margin-top: 16px; }
  </style>
</head>
<body>
  <main>
    <h1>Forge Mobile</h1>
    <p>手机与电脑连接同一 Wi‑Fi，用浏览器或扫码下载 APK 后安装。</p>
    <img src="${qrDataUrl}" alt="安装二维码" />
    <p class="meta">${sizeLabel}</p>
    <a class="button" href="${downloadUrl}">下载 APK</a>
    <p class="meta"><code>${downloadUrl}</code></p>
    <p class="meta">若系统拦截安装，请在设置中允许「安装未知应用」。</p>
  </main>
</body>
</html>`;
}

async function main() {
  const { apkPath: explicitApk, port } = parseArgs(process.argv.slice(2));
  const apkPath = resolveApk(explicitApk);
  const fileName = basename(apkPath);
  const fileSize = statSync(apkPath).size;
  const host = getLanIp();
  const baseUrl = `http://${host}:${port}`;
  const downloadUrl = `${baseUrl}/download/${encodeURIComponent(fileName)}`;
  const qrDataUrl = await QRCode.toDataURL(downloadUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 480,
  });
  const installHtml = buildInstallPage({
    title: "Forge Mobile 安装",
    downloadUrl,
    qrDataUrl,
    sizeLabel: `${fileName} · ${formatBytes(fileSize)}`,
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", baseUrl);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/install")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(installHtml);
      return;
    }

    if (req.method === "GET" && url.pathname === `/download/${encodeURIComponent(fileName)}`) {
      res.writeHead(200, {
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": fileSize,
      });
      createReadStream(apkPath).pipe(res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  server.listen(port, "0.0.0.0", () => {
    console.log("");
    console.log("Forge Mobile 本机安装页已启动");
    console.log(`  电脑浏览器: ${baseUrl}/`);
    console.log(`  手机扫码/访问: ${downloadUrl}`);
    console.log(`  APK: ${apkPath}`);
    console.log("");
    console.log("保持此终端运行，直到手机安装完成。Ctrl+C 停止。");
    console.log("");
  });
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
