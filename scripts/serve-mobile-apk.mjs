#!/usr/bin/env node
/**
 * Serve a Forge Mobile APK on the local network with a QR install page.
 *
 * Usage:
 *   node scripts/serve-mobile-apk.mjs [--apk path/to.apk] [--port 8765] [--tunnel]
 */
import { spawn } from "node:child_process";
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
  let tunnel = false;
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
    if (arg === "--tunnel") {
      tunnel = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/serve-mobile-apk.mjs [--apk path] [--port ${DEFAULT_PORT}] [--tunnel]`);
      process.exit(0);
    }
  }
  return { apkPath, port, tunnel };
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

function getLanIps() {
  const preferred = ["en0", "en1", "wlan0", "eth0"];
  const seen = new Set();
  const ips = [];

  const pushIp = (address) => {
    if (!address || seen.has(address)) return;
    seen.add(address);
    ips.push(address);
  };

  const nets = networkInterfaces();
  for (const name of preferred) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) pushIp(net.address);
    }
  }
  for (const ifaces of Object.values(nets)) {
    for (const net of ifaces ?? []) {
      if (net.family === "IPv4" && !net.internal) pushIp(net.address);
    }
  }
  return ips;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function looksLikeCorporateNetwork(ips) {
  return ips.some((ip) => ip.startsWith("10.") || ip.startsWith("172.") || ip.startsWith("192.168."));
}

function buildInstallPage({ title, downloadUrl, qrDataUrl, sizeLabel, modeLabel }) {
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
    .badge { display: inline-block; margin-bottom: 10px; padding: 4px 10px; border-radius: 999px; background: #1f2937; color: #93c5fd; font-size: .82rem; }
  </style>
</head>
<body>
  <main>
    <div class="badge">${modeLabel}</div>
    <h1>Forge Mobile</h1>
    <p>手机扫码或点击下方按钮下载 APK，下载完成后安装。</p>
    <img src="${qrDataUrl}" alt="安装二维码" />
    <p class="meta">${sizeLabel}</p>
    <a class="button" href="${downloadUrl}">下载 APK</a>
    <p class="meta"><code>${downloadUrl}</code></p>
    <p class="meta">若系统拦截安装，请在设置中允许「安装未知应用」。</p>
  </main>
</body>
</html>`;
}

async function makeInstallHtml({ baseUrl, fileName, fileSize, modeLabel }) {
  const downloadUrl = `${baseUrl}/download/${encodeURIComponent(fileName)}`;
  const qrDataUrl = await QRCode.toDataURL(downloadUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 480,
  });
  return buildInstallPage({
    title: "Forge Mobile 安装",
    downloadUrl,
    qrDataUrl,
    sizeLabel: `${fileName} · ${formatBytes(fileSize)}`,
    modeLabel,
  });
}

function startCloudflaredTunnel(port) {
  return new Promise((resolve, reject) => {
    const child = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`, "--protocol", "http2"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const handleOutput = (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text);
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !settled) {
        settled = true;
        resolve({ publicUrl: match[0], child });
      }
    };

    child.stdout.on("data", handleOutput);
    child.stderr.on("data", handleOutput);
    child.on("error", (error) => {
      if (!settled) reject(error);
    });
    child.on("exit", (code) => {
      if (!settled) reject(new Error(`cloudflared exited (${code ?? "unknown"})`));
    });

    setTimeout(() => {
      if (!settled) reject(new Error("cloudflared tunnel timed out after 30s"));
    }, 30_000);
  });
}

async function main() {
  const { apkPath: explicitApk, port, tunnel } = parseArgs(process.argv.slice(2));
  const apkPath = resolveApk(explicitApk);
  const fileName = basename(apkPath);
  const fileSize = statSync(apkPath).size;
  const lanIps = getLanIps();
  const primaryLanIp = lanIps[0] ?? "127.0.0.1";

  let publicBaseUrl = null;
  let tunnelChild = null;

  const pageCache = new Map();
  async function getInstallHtml(baseUrl, modeLabel) {
    const key = `${baseUrl}|${modeLabel}`;
    if (!pageCache.has(key)) {
      pageCache.set(key, await makeInstallHtml({ baseUrl, fileName, fileSize, modeLabel }));
    }
    return pageCache.get(key);
  }

  const server = createServer(async (req, res) => {
    const hostHeader = req.headers.host ?? `127.0.0.1:${port}`;
    const reqBaseUrl = `${req.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${hostHeader}`;
    const clientIp = req.socket.remoteAddress ?? "unknown";
    console.log(`[${new Date().toISOString()}] ${clientIp} ${req.method} ${req.url ?? "/"}`);

    const url = new URL(req.url ?? "/", reqBaseUrl);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/install")) {
      const modeLabel = publicBaseUrl ? "公网隧道下载" : "局域网下载";
      const pageBaseUrl = publicBaseUrl ?? reqBaseUrl.replace(/\/$/, "");
      const html = await getInstallHtml(pageBaseUrl, modeLabel);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
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

  const shutdown = () => {
    tunnelChild?.kill("SIGTERM");
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.listen(port, "0.0.0.0", async () => {
    const lanBaseUrl = `http://${primaryLanIp}:${port}`;
    const lanDownloadUrl = `${lanBaseUrl}/download/${encodeURIComponent(fileName)}`;

    if (tunnel) {
      try {
        const tunnelInfo = await startCloudflaredTunnel(port);
        publicBaseUrl = tunnelInfo.publicUrl;
        tunnelChild = tunnelInfo.child;
      } catch (error) {
        console.error(
          `公网隧道启动失败: ${error.message}\n` +
            "Cloudflare 隧道在国内/公司网常不可用。请改用:\n" +
            "  pnpm share:mobile:android          # 微信/ Finder 传文件\n" +
            "  pnpm publish:mobile:apk-relay      # 上传到 relay 域名 HTTPS 下载\n" +
            "  Mac 开热点 + pnpm serve:mobile:android",
        );
      }
    }

    console.log("");
    console.log("Forge Mobile 安装页已启动");
    console.log(`  APK: ${apkPath}`);
    console.log(`  本机: http://127.0.0.1:${port}/`);
    if (lanIps.length > 0) {
      console.log("  局域网地址（可逐个尝试）:");
      for (const ip of lanIps) {
        console.log(`    http://${ip}:${port}/`);
      }
    }
    if (publicBaseUrl) {
      console.log(`  公网隧道: ${publicBaseUrl}/`);
      console.log(`  公网下载: ${publicBaseUrl}/download/${encodeURIComponent(fileName)}`);
    }
    console.log(`  默认下载: ${lanDownloadUrl}`);
    console.log("");
    if (!publicBaseUrl && looksLikeCorporateNetwork(lanIps)) {
      console.log("提示: 当前像是公司/办公 Wi‑Fi，常见「客户端隔离」会导致手机扫局域网二维码仍打不开。");
      console.log("推荐改用:");
      console.log("  1) pnpm share:mobile:android              # 微信发 APK 到手机（最稳）");
      console.log("  2) pnpm publish:mobile:apk-relay           # 上传到 relay 域名 HTTPS 下载");
      console.log("  3) Mac 开热点 + pnpm serve:mobile:android  # 手机连 Mac 热点后扫码");
      console.log("  4) pnpm serve:mobile:android -- --tunnel   # Cloudflare（国内/公司网常失败）");
      console.log("");
    }
    console.log("终端会打印每次手机访问记录。看到记录说明已经连上；没有记录说明网络仍被隔离。");
    console.log("Ctrl+C 停止。");
    console.log("");
  });
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
