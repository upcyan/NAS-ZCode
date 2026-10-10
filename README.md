# NAS-Zcode-cyanmod

把 [ZCode](https://github.com/zai-org/ZCode)（Z.ai 开源的 AI 编程工作台）打包成飞牛 fnOS 的第三方原生应用。

服务端跑在 NAS 上，浏览器或飞牛桌面里直接用完整工作台：Agent 对话、代码工作区、内置终端。登录态和工作区存在 NAS 上，多设备共用。

- 原生 Node.js，不是 Docker，复用应用中心的 Node.js v22
- 一个包同时支持 x86_64 和 arm64
- 局域网直连和 fnConnect 远程都能用，远程不需要映射端口

本仓库只做 NAS 侧移植打包，不改 ZCode 本身。上游：[zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0）。打包维护：[upcyan](https://github.com/upcyan/NAS-Zcode-cyanmod)。

## 安装

从 [Releases](https://github.com/upcyan/NAS-Zcode-cyanmod/releases) 下载 `zcode-<版本>.fpk`，应用中心 → 手动安装。Node.js v22 会随包自动装上。

装完从桌面图标打开，或直连 `http://<NAS_IP>:8988`（默认端口）。

## 两种访问方式

|  | 桌面图标 / 远程 | 局域网直连 |
|---|---|---|
| 入口 | `https://<面板>/app/zcode` | `http://<NAS_IP>:8988` |
| 鉴权 | 面板登录态 | 访问令牌 |
| 端口映射 | 不需要 | 需放通 8988 |
| fnConnect | 可用 | 不可达 |

桌面图标走飞牛统一网关，远程不用带令牌。令牌只用于局域网直连，防止同网段设备直接连上一个能执行命令的 agent。

换令牌：应用中心 → ZCode → 应用设置 → 访问令牌 → 重启应用。

> 不要把 8988 映射到公网。

### 网关接入层

ZCode 前端把资源写成根绝对路径（`/assets/`、`/api/`、`/ws`），服务端不支持 basePath，没法直接挂在 `/app/zcode` 下。

包里的 `app/gateway/` 负责：

1. 剥掉前缀转发给本机 server，HTTP 和 WebSocket 都转发
2. 改写 HTML/CSS/JS 里的根绝对路径到前缀下
3. 注入 `url-compat.js`，运行期接管 `fetch`、`XHR`、`WebSocket` 等，把动态产生的路径拉回前缀
4. 去掉 `X-Frame-Options` 和 CSP `frame-ancestors`，让工作台能在面板 iframe 里渲染

网关起不来只影响远程入口，局域网直连不受影响。

## 工作区

默认工作区是共享目录 `zcode/workspace`，文件管理器可见。

要让 ZCode 操作别的目录，在应用中心 → ZCode → 设置 → 访问权限里添加授权目录，重启应用。

## 版本号

`<上游 ZCode 版本>-<打包修订号>`，例如 `3.14.3-4`。上游部分跟官方 runtime 一致，改打包只递增修订号。

## 与桌面版的差异

| | 桌面版 | NAS 版 |
|---|---|---|
| 界面 | Electron 窗口 | 浏览器 / 飞牛桌面 |
| 终端 | 本机 node-pty | 服务端 node-pty |
| 浏览器自动化 | 内置 | 不可用，NAS 无桌面 Chromium |
| 配置与凭据 | 本机用户目录 | NAS 应用数据目录，升级保留 |

## 构建

产物默认输出到仓库上一级，避免 80MB 文件混在源码树里。

```bash
# 1. 准备官方 Web 运行时 zcode-<ver>.tar.gz，放到 <仓库上一级>/dist/runtime/
#    可本地构建上游，或直接取 CI 产物

# 2. 打 fpk
bash packaging/fnOS/scripts/build.sh
# 产物：<仓库上一级>/dist/zcode-<ver>.fpk
```

改产物位置用 `DIST_DIR=/path/to/out`，指定运行时包用 `--runtime /path/to/zcode-3.14.1.tar.gz`。

## 目录结构

```
packaging/fnOS/
├── manifest            # 应用元信息
├── cmd/                # 生命周期脚本
├── config/             # privilege / resource
├── gateway/            # 网关接入层
├── ui/config           # 飞牛桌面入口
├── ui-images/          # 图标
└── scripts/build.sh    # 打包脚本
upstream.version        # 钉住的上游提交
fnos.version            # fpk 版本号
```

## 许可

- ZCode：[Apache-2.0](https://github.com/zai-org/ZCode/blob/main/LICENSE)，© Z.ai
- 本仓库的移植与打包脚本：Apache-2.0
- 图标来自 ZCode 官方桌面版资源，版权归 Z.ai
