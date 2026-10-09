# ZCode · 飞牛 fnOS 原生版

把 [Z.ai 开源的 AI 编程工作台 ZCode](https://github.com/zai-org/ZCode) 打包成飞牛 fnOS 的**原生第三方应用**（非 Docker）：

- 服务端跑在 NAS 上，浏览器 / 飞牛桌面里直接用完整工作台——**Agent 对话、代码工作区、内置终端**
- 登录态与工作区保存在 NAS 上，手机 / 平板 / 电脑共用一份
- **非 Docker**：原生 Node.js 运行，复用应用中心的 **Node.js v22**（`install_dep_apps` 自动装）
- **一个包同时支持 x86_64 与 arm64**（`platform = all`，原生模块用官方预编译件）
- **局域网与远程都能用**：接入飞牛统一网关，fnConnect 等非局域网方式不必映射 8988 端口
- 基于 ZCode 官方 Web 运行时（`zcode --web`），与桌面版共用同一套前端组件

> 本仓库只做 NAS 侧的移植与打包，不修改 ZCode 本身。上游代码：[zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0）。开发者：Z.ai；飞牛移植 / 打包 / 发布：[Kasbuky-sudo](https://github.com/Kasbuky-sudo)。

## 安装

1. 在飞牛应用中心先安装（或随本应用自动装上）**Node.js v22** 运行时；
2. 从 [Releases](https://github.com/Kasbuky-sudo/NAS-ZCode/releases) 下载 `zcode-<版本>.fpk`；
3. 应用中心 → 手动安装 → 选择 fpk 文件；
4. 安装完成后从桌面图标打开（iframe 内嵌）。

端口默认 **8988**（局域网直连用）。首个飞牛版本需要真机验收，请先在测试设备安装。

## 两种访问方式

ZCode Web 等于把一个能执行命令的 AI agent 和终端开放出去，所以两条链路都做了收敛：

|  | 桌面图标 / 远程（推荐） | 局域网直连 |
|---|---|---|
| 入口 | `https://<面板>/app/zcode`（飞牛统一网关） | `http://<NAS_IP>:8988` |
| 鉴权 | **面板登录态**（网关校验，并注入 `X-Trim-Userid/Username/Isadmin`） | **访问令牌** |
| 端口映射 | 不需要 | 需自行放通 8988 |
| fnConnect 远程 | ✅ 可用 | ❌ 裸端口不可达 |

### 为什么需要一个网关接入层

ZCode 前端把同源资源与接口写成**根绝对路径**（`/assets/…`、`/api/*`、`/ws`），
而 server（`entry-http`）**不支持 basePath**（只认 `PORT` / `ZCODE_SERVER_HOST` /
`ZCODE_WEB_STATIC_ROOT` / `ZCODE_SERVER_AUTH_TOKEN`），没法自己挂到 `/app/zcode` 前缀下。

所以包里带了一个**网关接入层**（`app/gateway/`）：飞牛面板把 `/app/zcode/**` 交给它
（`ui/config` 的 `gatewaySocket` + `gatewayPrefix`，进程监听应用目录下的 unix socket），它负责：

1. 剥掉前缀，转发给本机 server（HTTP 与 WebSocket 升级都转发）；
2. 把 HTML / CSS / JS 里的根绝对路径改写到前缀下
   （HTML 里 58 处 `modulepreload`/`script`/`stylesheet`、CSS 里 59 处
   `url(/assets/KaTeX_*)`、preload-helper 的 `` `/`+path `` 拼接）；
3. 注入 `url-compat.js`，在运行期接管 `fetch` / `XHR` / `WebSocket` / `EventSource` /
   `Worker` / `script.src` / `link.href`，把前端动态产生的根绝对路径拉回前缀下；
4. 去掉上游的 `X-Frame-Options` 与 CSP `frame-ancestors`，让工作台能在面板 iframe 里渲染。

动态 `import("./chunk.js")` 是**相对模块 URL** 解析的，天然落在前缀下，因此不改写。

失败隔离：网关起不来只影响"远程/面板入口"，局域网直连 `:8988` 不受影响，所以它启动失败
**不会**让应用整体启动失败（只记日志）。

## 访问令牌

桌面图标走网关，**不需要令牌**；令牌只用于局域网直连 `:8988`（防止同网段设备直接连上
一个能执行命令的 agent 与终端）。

- **安装时**向导要求填一个「访问令牌」（8-64 位字母、数字、下划线或中划线；可留空由系统生成随机值）。
- 局域网直连按 `?token=<令牌>` 打开（也兼容历史写法 `/<令牌>`），页面加载后自动种鉴权 cookie，之后刷新无需再带。
- 换令牌：应用中心 → 已安装 → ZCode → 应用设置 → 改「访问令牌」→ 重启应用。
- 机制说明：服务端只对 `/ws`、`/ws/*`、`/api/*` 鉴权（静态页放行），鉴权同时接受 `?token=`
  与 `zcode_lite_token` cookie。打包时给 `web/index.html` 注入的一小段脚本负责种 cookie，
  并**排除** `app`/`assets`/`share` 等保留首段，避免把网关路径首段误当令牌。
- 网关转发时会**覆盖**请求里的 `zcode_lite_token`（不是追加），因此浏览器残留的旧令牌
  不会破坏远程访问——这正是旧版"重装后报 WebSocket 连接失败"的成因。

> **请勿把 8988 映射到公网**。远程访问请走面板 / fnConnect（网关已带登录态校验）。

## 工作区

应用安装后会创建共享目录 `zcode/workspace` 作为默认工作区（文件管理器可见）。让 ZCode 操作已有目录（如某个共享文件夹）时，在「应用中心 → 已安装 → ZCode → 设置 → 访问权限」添加授权目录，然后重启应用。

## 与桌面版的差异

| | 桌面版 | NAS 版 |
|---|---|---|
| 界面 | Electron 窗口 | 浏览器 / 飞牛桌面 iframe（同一套前端组件） |
| 终端 | 本机 node-pty | 服务端 node-pty（浏览器内） |
| 浏览器自动化 | 内置 | 不可用（NAS 无桌面 Chromium） |
| 配置与凭据 | 本机用户目录 | NAS 应用数据目录（升级保留） |

## 构建

```bash
# 1. 获取官方 Web 运行时包（zcode-<ver>.tar.gz）：
#    a) GitHub Actions：本仓库 push 后自动构建（upstream.version 钉住上游版本）
#    b) 本地构建上游：clone zai-org/ZCode，Node 24.14.0 + pnpm 10.33.2
#       pnpm bootstrap && pnpm build:zcode --base-url http://127.0.0.1/zcode/
#       产物在 dist/zcode/releases/<ver>/zcode-<ver>.tar.gz
#    把 tar.gz 放到 packaging/fnOS/dist/runtime/

# 2. 打 fpk（Windows Git Bash / Linux 均可，需 fnpack）
bash packaging/fnOS/scripts/build.sh
# 产物：packaging/fnOS/dist/zcode-<ver>.fpk
```

也可以指定运行时包路径：`bash packaging/fnOS/scripts/build.sh --runtime /path/to/zcode-3.14.1.tar.gz`。

验收变体：`DEP_APPS=none bash packaging/fnOS/scripts/build.sh ...` 会剥离 manifest 里的
`install_dep_apps` 声明（产物名带 `-nodep` 后缀）。用途：Node 运行时已装好时，绕过
App Center 对「声明依赖的本地 fpk」的拦截，便于 trim-cli 自动化安装验收——正式分发请用
默认变体（带依赖声明，新装用户会自动装上 Node.js v22）。

## 目录结构

```
packaging/fnOS/
├── manifest              # 应用元信息（platform=all、nodejs_v22 依赖、端口 8988）
├── cmd/                  # 生命周期脚本（main / install / upgrade / uninstall / config）
├── config/               # privilege（run-as: package）与 resource（工作区共享目录）
├── gateway/              # 网关接入层：gateway.mjs（代理）+ url-compat.js（前端路径兼容）
├── ui/config             # 飞牛桌面入口（gatewaySocket → /app/zcode）
├── ui-images/            # 图标（取自 ZCode 官方桌面版资源）
├── scripts/build.sh      # 解包官方 runtime → 组装 stage → fnpack 打包
└── scripts/inject-entry-token.py  # 注入入口令牌脚本（局域网直连用）
.github/workflows/build.yml  # 自动构建官方 runtime 并产出 fpk
upstream.version             # 钉住的 ZCode 上游提交
fnos.version                 # fpk 版本号（独立于上游版本）
```

> 版本号注意：飞牛用 `golang.org/x/mod/semver` 比较版本，带 `-` 的后缀会被判为
> **prerelease（更小）**。所以打补丁版请用 `3.14.4` 这类递增号，**不要**用 `3.14.3-1`
> ——否则已装用户收不到升级。

## 许可

- ZCode：[Apache-2.0](https://github.com/zai-org/ZCode/blob/main/LICENSE)（© Z.ai）
- 本仓库的移植与打包脚本：Apache-2.0
- 图标来自 ZCode 官方桌面版资源，版权归 Z.ai 所有
