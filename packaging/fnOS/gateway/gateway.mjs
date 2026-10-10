#!/usr/bin/env node
/**
 * ZCode · 飞牛 fnOS 统一网关接入层
 * =================================
 *
 * 为什么需要它：ZCode Web 前端把同源资源与接口写成根绝对路径
 * （/assets/…、/api/*、/ws），而 server（entry-http）**不支持 basePath**
 * （只认 PORT / ZCODE_SERVER_HOST / ZCODE_WEB_STATIC_ROOT / ZCODE_SERVER_AUTH_TOKEN），
 * 无法自己挂在 /app/zcode 前缀下。
 *
 * 飞牛的统一网关（ui/config 的 gatewaySocket + gatewayPrefix）正是为这种情况准备的：
 * 面板把 https://<fnconnect域名>/app/zcode/** 交给本进程（监听应用目录下的 unix socket），
 * 由本进程剥掉前缀后转发给本机 ZCode server。走这条链路有两个关键收益：
 *   1. **非局域网可用**：局域网直连走 8988 端口，fnConnect 远程走面板网关，
 *      两者共用同一个 server 实例，登录态与工作区不分叉。
 *   2. **免令牌**：网关在转发前已完成面板登录态校验，并注入 X-Trim-Userid /
 *      X-Trim-Username / X-Trim-Isadmin（普通用户拿不到这些头，无法伪造）。因此
 *      远程访问不必把访问令牌塞进 URL，也不怕它出现在历史记录与日志里。
 *
 * 处理内容：
 *   - 剥离 /app/zcode 前缀（含 socket 转发时的 Host 改写）
 *   - 注入 url-compat.js：把前端产生的根绝对路径重写回前缀下
 *   - 允许目标站把本应用嵌进 iframe（ZCode 自带 X-Frame-Options/CSP frame-ancestors）
 *   - 转发 WebSocket upgrade（/ws）
 *
 * 约定（与飞牛实测一致）：网关只做转发，**不剥离**前缀，剥离由应用自己做；
 * 且网关会改写 Host，因此判断"是否同源"一律以 X-Trim-* / 转发头为准。
 */

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const SOCKET_PATH = arg("socket", path.join(HERE, "zcode.sock"));
const PREFIX = arg("prefix", "/app/zcode").replace(/\/+$/, "");
const TARGET_PORT = Number(arg("port", "8988"));
const TARGET_HOST = arg("host", "127.0.0.1");
const LOG_FILE = arg("log", "");

// 把 URL 兼容层读进内存：每次请求都读盘既慢又会被文件权限问题拖累。
const COMPAT_FILE = path.join(HERE, "url-compat.js");
let compatSource = "";
try {
  compatSource = fs.readFileSync(COMPAT_FILE, "utf8");
} catch (error) {
  compatSource = "";
  log(`警告：未能读取 ${COMPAT_FILE}（${error.code}），将继续但不注入路径兼容层`);
}
if (compatSource) {
  compatSource = compatSource.replace('|| "/app/zcode"', `|| ${JSON.stringify(PREFIX)}`);
}

// 需要剥前缀的对外路径；命中返回剥后的路径，否则返回 null。
function stripPrefix(url) {
  if (url === PREFIX) return "/";
  if (url.startsWith(PREFIX + "/")) return url.slice(PREFIX.length);
  if (url.startsWith(PREFIX + "?")) return "/" + url.slice(PREFIX.length);
  return null;
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, line);
      return;
    } catch {}
  }
  process.stderr.write(line);
}

/**
 * 把访问令牌**覆盖**进 Cookie 头。
 *
 * 必须是覆盖而不是追加：浏览器里可能残留上一版安装/换令牌前的
 * `zcode_lite_token`（cookie 作用域只认域名，不认端口或网关前缀，所以直连与
 * 网关访问共用同一份）。若追加成 `zcode_lite_token=OLD; zcode_lite_token=NEW`，
 * 服务端按惯例取**第一个**，于是仍拿旧令牌比对 → /ws 401 → 前端报
 * 「Web 启动失败」。真机踩过这个坑，这里从根上掐掉。
 */
function withLocalToken(cookieHeader) {
  if (!LOCAL_TOKEN) return cookieHeader;
  const parts = String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !/^zcode_lite_token=/i.test(part));
  parts.push(`zcode_lite_token=${encodeURIComponent(LOCAL_TOKEN)}`);
  return parts.join("; ");
}

// ── 响应改写 ────────────────────────────────────────────────────────────────
// iframe 场景必须去掉上游的限制性响应头：ZCode 自带 X-Frame-Options: SAMEORIGIN
// 与 CSP frame-ancestors，在网关前缀下会被浏览器判定为跨源而拒绝渲染。
function sanitizeHeaders(headers) {
  const out = { ...headers };
  delete out["x-frame-options"];
  const csp = out["content-security-policy"];
  if (typeof csp === "string") {
    const cleaned = csp
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part && !/^frame-ancestors\b/i.test(part))
      .join("; ");
    if (cleaned) out["content-security-policy"] = cleaned;
    else delete out["content-security-policy"];
  }
  // 上游按自身路径发的 Cookie 作用域仍然正确（浏览器只认域名，不认网关前缀），
  // 但 Path=/ 之外的写法会让网关路径下的请求收不到，这里统一放宽到 /。
  const setCookie = out["set-cookie"];
  if (setCookie) {
    out["set-cookie"] = (Array.isArray(setCookie) ? setCookie : [setCookie]).map((cookie) =>
      String(cookie).replace(/;\s*Path=[^;]*/i, "; Path=/"),
    );
  }
  return out;
}

function injectCompatLayer(html) {
  if (!compatSource) return html;
  const tag = `<script data-zcode-gateway-compat>${compatSource}</script>`;
  if (html.includes("data-zcode-gateway-compat")) return html;
  // 必须早于任何模块脚本执行：<head> 后立刻插入。
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  return tag + html;
}

// ── 根绝对路径改写 ──────────────────────────────────────────────────────────
// 为什么必须在服务端改写：HTML 里的 <link rel=modulepreload href="/assets/…">、
// <script src="/assets/…"> 是**浏览器解析 HTML 时**就发起的请求，JS 层的
// monkey-patch（url-compat.js）对它们无效——那时脚本还没执行。
// 同理，CSS 里的 url(/assets/KaTeX_*.woff2) 也只认文本。
//
// 只改「根绝对」形态（前面紧跟引号/括号/等号），避免误伤：
//   - 外部站点 URL（https://cdn-zcode.z.ai/zcode/official-plugin/assets）
//   - 相对路径（assets/xxx.js —— 这些随模块 URL 解析，天然落在前缀下）
const REWRITABLE_SEGMENTS = ["assets", "material-icons", "pdfjs"];
const ROOT_ABS_RE = new RegExp(
  `(["'\`(=])\\/(${REWRITABLE_SEGMENTS.join("|")})\\/`,
  "g",
);
// 少数根绝对文件（非目录）
const ROOT_ABS_FILE_RE = /(["'`(=])\/(THIRD-PARTY-NOTICES\.md)/g;

function rewriteRootAbsolute(text) {
  let out = text.replace(ROOT_ABS_RE, (_m, lead, segment) => `${lead}${PREFIX}/${segment}/`);
  out = out.replace(ROOT_ABS_FILE_RE, (_m, lead, file) => `${lead}${PREFIX}/${file}`);
  return out;
}

/** 是否需要按文本改写；返回类型标记或 null（二进制/流式直通） */
function textKind(contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("text/html")) return "html";
  if (ct.includes("text/css")) return "css";
  if (ct.includes("javascript") || ct.includes("ecmascript")) return "js";
  return null;
}

/**
 * 是否内容寻址（可长缓存）。
 *
 * Vite 产物形如 `index-DuJc5FYg.js`、`KaTeX_Main-Regular-abc123.woff2`：
 * 文件名里的 hash 由内容算出，内容变了文件名就变，所以同名文件的内容永不改变，
 * 缓存一年也不会拿到过期内容。网关对其改写（补前缀）是纯函数，结果同样稳定。
 *
 * 反例：`index.html`、`favicon.ico`、`/api/*` —— 名字固定，必须每次回源。
 */
const IMMUTABLE_RE = /-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|wasm|map)$/i;
function isImmutableAsset(target) {
  const path = String(target || "").split("?")[0].split("#")[0];
  // 只对根目录下的静态资源生效；/api 与 /ws 不在此列（它们也不走文本改写分支）。
  if (!path.startsWith("/")) return false;
  return IMMUTABLE_RE.test(path);
}

// ── HTTP 代理 ───────────────────────────────────────────────────────────────
// 入口 HTML 缓存：版本错配自愈时要用最新的入口页。缓存 10 秒，既避免每次
// 自愈都回源，又保证升级后很快拿到新清单（入口页本身在上游就是 no-store）。
const ENTRY_TTL_MS = 10_000;
let entryCache = { at: 0, body: null };

function fetchEntryHtml() {
  if (entryCache.body && Date.now() - entryCache.at < ENTRY_TTL_MS) {
    return Promise.resolve(entryCache.body);
  }
  return new Promise((resolve) => {
    const headers = { host: `${TARGET_HOST}:${TARGET_PORT}`, "accept-encoding": "identity" };
    if (LOCAL_TOKEN) headers.cookie = withLocalToken("");
    const req = http.request(
      { host: TARGET_HOST, port: TARGET_PORT, method: "GET", path: "/", headers },
      (up) => {
        if (up.statusCode !== 200) { up.resume(); resolve(null); return; }
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => {
          let body = rewriteRootAbsolute(Buffer.concat(chunks).toString("utf8"));
          body = injectCompatLayer(body);
          entryCache = { at: Date.now(), body };
          resolve(body);
        });
      },
    );
    req.on("error", () => resolve(null));
    req.end();
  });
}

/** 用最新入口 HTML 回应「旧 hash 资源 404」，让客户端自愈到当前版本 */
function serveEntryHtml(res, req) {
  fetchEntryHtml().then((body) => {
    if (!body) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    const buf = Buffer.from(body, "utf8");
    log(`版本错配自愈：${req.url} → 返回最新入口 HTML`);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(buf.length),
      "Cache-Control": "no-store",
    });
    res.end(buf);
  }).catch(() => {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("entry html unavailable");
  });
}

const server = http.createServer((req, res) => {
  const target = stripPrefix(req.url);
  if (target === null) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not under gateway prefix");
    return;
  }

  const headers = { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` };
  // 要求上游不压缩：本层要按文本改写 HTML/CSS/JS，压缩过的正文没法直接改。
  headers["accept-encoding"] = "identity";
  // 上游要从请求里取令牌比对；网关已做面板登录态校验，这里覆盖上本地令牌。
  if (LOCAL_TOKEN) headers.cookie = withLocalToken(headers.cookie);

  const upstream = http.request(
    { host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: target, headers },
    (up) => {
      const kind = textKind(up.headers["content-type"]);

      // ── 版本错配自愈 ──────────────────────────────────────────────────────
      // 场景：客户端（尤其飞牛手机 App 的 WebView 会保活复用页面）缓存了**上一版**
      // 的入口 HTML，里面引用的是旧 hash 的资源（如 assets/index-OLD.js）。服务升级后
      // 旧文件已不存在 —— 表现就是「样式全丢、UI 元素裸露堆叠，二次刷新才正常」。
      //
      // 上游（entry-http）对不存在的路径一律做 SPA 回退：返回 200 + 入口 HTML，
      // 所以这里不能只看状态码，必须看**内容类型**：客户端明确在要一个静态资源
      // （内容寻址的 js/css/字体…），上游却回了 HTML，那就是版本错配。
      //
      // 处理：改写成一份**最新入口 HTML**（强制 no-store），让客户端重新拿到当前
      // 资源清单后自愈。绝不能给这种响应发 immutable 长缓存 —— 那会把「HTML 冒充 JS」
      // 缓存一年，二次刷新也不会好。
      //
      // 只对内容寻址的资源路径生效；/api、/ws、页面路由等保持原状。
      if (kind === "html" && isImmutableAsset(target)) {
        up.resume(); // 丢弃上游的 HTML 体（等价于入口缓存的内容），避免连接悬挂
        serveEntryHtml(res, req);
        return;
      }

      // HTML / CSS / JS 需要按文本改写，必须缓冲；其余（图片、字体、wasm、
      // 以及 HTML 之外的流式响应）直接直通，避免把大文件读进内存。
      // 注意 JS 里 28 处 `"/assets/…"` 与 CSS 里 59 处 `url(/assets/KaTeX_*)`
      // 都是根绝对路径，只有文本改写才救得回来。
      // 例外：上游若已压缩（content-encoding），先解压成本高，故请求侧已声明
      // identity（见 headers 里的 accept-encoding），此处再兜一层保险。
      const encoded = Boolean(up.headers["content-encoding"]);
      if (!kind || encoded) {
        res.writeHead(up.statusCode || 200, sanitizeHeaders(up.headers));
        up.pipe(res);
        return;
      }

      const chunks = [];
      up.on("data", (c) => chunks.push(c));
      up.on("end", () => {
        let body = Buffer.concat(chunks).toString("utf8");
        body = rewriteRootAbsolute(body);
        if (kind === "html") body = injectCompatLayer(body);
        const buf = Buffer.from(body, "utf8");
        const outHeaders = sanitizeHeaders(up.headers);
        delete outHeaders["content-encoding"]; // 已按文本改写过，长度与编码都以新的为准
        outHeaders["content-length"] = String(buf.length);
        delete outHeaders["etag"];
        delete outHeaders["last-modified"];

        // 缓存策略：这里改写的是「根绝对路径 → 前缀路径」，同源同文件每次改写结果
        // 完全一致，所以只要 URL 是内容寻址的（Vite 产物带 hash），就可以放心长缓存。
        //
        // 曾经这里一律 no-store，代价很大：index-<hash>.js 有 5.9 MB，一次页面加载
        // 内被重复请求 7 次、diffs.worker 4 次，一次会话光资源就传 15 MB。局域网下
        // 感知不明显，非局域网（fnConnect 走公网）就非常慢。
        if (isImmutableAsset(target)) {
          outHeaders["cache-control"] = "public, max-age=31536000, immutable";
        } else {
          // HTML（入口页）与其它非内容寻址路径：必须每次回源，否则拿不到新的资源清单。
          outHeaders["cache-control"] = "no-store";
        }
        res.writeHead(up.statusCode || 200, outHeaders);
        res.end(buf);
      });
    },
  );

  upstream.on("error", (error) => {
    log(`上游请求失败 path=${target} err=${error.code || error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end(`ZCode server 暂不可用（${error.code || error.message}）。请确认应用已启动。`);
  });

  req.pipe(upstream);
});

// ── WebSocket / upgrade 转发 ────────────────────────────────────────────────
server.on("upgrade", (req, socket, head) => {
  const target = stripPrefix(req.url);
  if (target === null) {
    socket.destroy();
    return;
  }

  const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
    const lines = [`GET ${target} HTTP/1.1`];
    const headers = { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` };
    if (LOCAL_TOKEN) headers.cookie = withLocalToken(headers.cookie);
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
      else if (value !== undefined) lines.push(`${key}: ${value}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on("error", (error) => {
    log(`WS 转发失败 path=${target} err=${error.code || error.message}`);
    socket.destroy();
  });
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
});

// ── 启动 ────────────────────────────────────────────────────────────────────
// 令牌：server 对 /ws、/api/* 做鉴权。走网关时网关已校验面板登录态，
// 这里把本地令牌补进转发请求，页面因此无需在 URL 里携带令牌。
const LOCAL_TOKEN = arg("token", "");

function listen() {
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch (error) {
    if (error.code !== "ENOENT") log(`清理旧 socket 失败：${error.message}`);
  }
  try {
    fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });
  } catch {}

  server.on("error", (error) => {
    log(`网关监听失败：${error.code || error.message}`);
    process.exit(1);
  });

  server.listen(SOCKET_PATH, () => {
    try {
      fs.chmodSync(SOCKET_PATH, 0o660);
    } catch {}
    log(`网关就绪 socket=${SOCKET_PATH} prefix=${PREFIX} 目标=${TARGET_HOST}:${TARGET_PORT}`);
  });
}

listen();

function shutdown(signal) {
  log(`收到 ${signal}，关闭网关`);
  server.close(() => {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {}
    process.exit(0);
  });
  // 长连接（WebSocket）会拖住 close 回调，给一个硬期限兜底。
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
