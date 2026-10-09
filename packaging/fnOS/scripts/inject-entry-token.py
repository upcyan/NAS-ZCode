#!/usr/bin/env python3
"""给打包进 fpk 的 web/index.html 注入「入口令牌」脚本。

## 现在有两条访问链路

1. **网关入口（默认，桌面图标）**：`/app/zcode`
   飞牛统一网关把该前缀交给包内的 `gateway/gateway.mjs`（unix socket），
   由它剥前缀转发给本机 server，并**在转发请求里补上访问令牌**。
   因此这条链路下页面不需要、也不应该自己去种令牌 cookie。

2. **局域网直连（可选）**：`http://<NAS_IP>:8988`
   此时没有网关帮忙补令牌，需要把令牌交给页面：
     - `/?token=<令牌>`（推荐，令牌只出现在查询串）
     - `/<令牌>`（历史写法，向后兼容）
   页面加载后由本脚本把令牌写进 `zcode_lite_token` cookie，
   之后的 `fetch /api/*` 与 `ws /ws` 握手自动携带。

## 为什么必须排除一批首段

入口路径不再是"纯令牌"了：`/app/zcode` 的首段是 `app`，若照旧当成令牌写进
cookie，服务端就会拿 `app` 去比对，导致鉴权失败（且比不带 cookie 更难排查）。
所以下面维护一份**保留首段**清单：命中就完全不写 cookie。

## 为什么必须覆盖旧 cookie

重装或换令牌后，浏览器里往往还留着上一版的 `zcode_lite_token`，跳过写入会让
页面带着旧令牌握手 → `/ws` 401 → 前端显示「Web 启动失败 / WebSocket connection
failed」。真机踩过这个坑，因此**一律覆盖**，不做"有就跳过"。

只把**单段路径**当成令牌，避免误伤应用自身的多段路由
（如 `/share/callback`、`/cn/share/callback` 这些 OAuth 回跳路径）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

MARKER = "zcode-fnos-entry-token"

# 首段命中这些就绝不当作令牌：
#   app / _fnos / __fnos —— 飞牛面板与网关自身命名空间
#   assets / material-icons / pdfjs / favicon.ico —— 前端静态资源
#   api / ws —— 服务端接口
#   share / cn —— 分享与 OAuth 回跳路由
RESERVED = [
    "app",
    "_fnos",
    "__fnos",
    "assets",
    "material-icons",
    "pdfjs",
    "favicon.ico",
    "api",
    "ws",
    "share",
    "cn",
    "index.html",
]

SNIPPET = (
    "<script>"
    "/* " + MARKER + ": 从 ?token= 或单段入口路径取令牌，刷新鉴权 cookie（含覆盖旧令牌）*/"
    "(function(){try{"
    "var RESERVED=" + json.dumps(RESERVED) + ";"
    # ① 优先查询串：/?token=xxx
    "var q=new URLSearchParams(location.search).get('token');"
    # ② 回退单段路径：/<token>（且首段不在保留清单里）
    "var p=location.pathname.replace(/^\\/+|\\/+$/g,'');"
    "var t=q||((p&&p.indexOf('/')===-1&&RESERVED.indexOf(p)===-1)?p:null);"
    "if(!t)return;"
    "var m=document.cookie.match(/(?:^|;\\s*)zcode_lite_token=([^;]*)/);"
    "var cur=m?decodeURIComponent(m[1]):null;"
    "if(cur===t)return;"
    "document.cookie='zcode_lite_token='+encodeURIComponent(t)+'; path=/; SameSite=Lax';"
    "}catch(e){}})();"
    "</script>"
)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: inject-entry-token.py <web/index.html>", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"✗ 找不到 {path}", file=sys.stderr)
        return 1

    html = path.read_text(encoding="utf-8")
    if MARKER in html:
        # 已有旧版注入（可能有"跳过写入"或"不识别保留首段"的缺陷）：整体替换为最新片段
        start = html.find("<script>/* " + MARKER)
        end = html.find("</script>", start)
        if start != -1 and end != -1:
            html = html[:start] + SNIPPET + html[end + len("</script>"):]
            path.write_text(html, encoding="utf-8", newline="\n")
            print("[build] 已更新入口令牌脚本（覆盖旧版本注入）")
            return 0
        print("[build] 检测到标记但无法定位片段，保持原样")
        return 0

    if "<head>" in html:
        html = html.replace("<head>", "<head>" + SNIPPET, 1)
    else:
        html = SNIPPET + html

    # 统一 LF：该文件在 Linux 上由服务端读取，不需要 CRLF
    path.write_text(html, encoding="utf-8", newline="\n")
    print("[build] 已注入入口令牌脚本 → web/index.html")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
