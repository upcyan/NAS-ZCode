#!/usr/bin/env bash
#
# 构建飞牛 fnOS 原生应用包（.fpk）
# ================================
# 产物：packaging/fnOS/dist/zcode-<version>.fpk
#
# payload 不是本仓库的源码，而是 ZCode 官方的 Web 运行时包
# （zcode-<version>.tar.gz，由上游 `pnpm build:zcode` 产出）：
#     runtime/bin/zcode.mjs + server/ + agent/ + web/ + node_modules/
#
# 运行期用应用中心的 nodejs_v22（manifest install_dep_apps 声明），
# node_modules 里是官方预编译的 node-pty 等原生件（linux-x64 + linux-arm64），
# 因此单个包即可通吃 x86_64 / arm64（platform = all）。
#
# 用法：
#   bash packaging/fnOS/scripts/build.sh                       # 用 dist/runtime/ 里已就位的 runtime
#   bash packaging/fnOS/scripts/build.sh --runtime <tar.gz>    # 指定官方运行时包
#   ZCODE_VERSION=3.14.1 bash packaging/fnOS/scripts/build.sh  # 覆盖版本号
#
# ⚠ fnpack 打 app.tgz 时会把权限拍平成 0666/0777（官方模板同款行为），
#   可执行位由 cmd/install_callback 在装机时补回。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "${HERE}/.." && pwd)"                 # packaging/fnOS
REPO="$(cd "${PKG_DIR}/../.." && pwd)"              # 仓库根
APP="zcode"

DIST="${PKG_DIR}/dist"
STAGE="${PKG_DIR}/.build-staging/${APP}"            # 交给 fnpack 的目录
APP_DIR="${STAGE}/app"                              # 应用内容树（会打成 app.tgz）

# fnpack 是 Windows exe；CI（Linux）没有，用社区等价实现：fpk 就是 tar.gz，
# 手动按 fnpack 布局打包（app/ → app.tgz，与包根文件一起 gzip）。
if [ -z "${FNPACK:-}" ]; then
    if command -v fnpack > /dev/null 2>&1; then
        FNPACK="fnpack"
    elif [ -f "${REPO}/fnpack" ]; then
        FNPACK="${REPO}/fnpack"          # 仓库根放一份 fnpack 时自动使用
    elif [ -f "${PKG_DIR}/fnpack" ]; then
        FNPACK="${PKG_DIR}/fnpack"
    else
        FNPACK=""                        # 落到 tar 等价打包路径
    fi
fi
NODE="${NODE:-node}"

### 本机 Windows 的 Git Bash shim 关闭了 MSYS 路径转换：
### 传给原生 exe（node / fnpack）的 /c/Users/... 会被原样理解成 C:\c\Users\...。
### 凡是跨到原生进程的路径，一律先转 Windows 形式。
winpath() {
    cygpath -w "$1" 2>/dev/null || echo "$1"
}

# ── 定位官方运行时包 ─────────────────────────────────────────
RUNTIME_TGZ="${1:-}"
if [ "${1:-}" = "--runtime" ]; then
    RUNTIME_TGZ="${2:-}"
fi
if [ -z "${RUNTIME_TGZ}" ]; then
    # 默认取 dist/runtime/ 下最新的官方包
    RUNTIME_TGZ="$(ls -t "${DIST}"/runtime/zcode-*.tar.gz 2>/dev/null | head -n 1 || true)"
fi
if [ -z "${RUNTIME_TGZ}" ] || [ ! -f "${RUNTIME_TGZ}" ]; then
    echo "✗ 未找到官方运行时包（zcode-<version>.tar.gz）"
    echo "  获取方式（二选一）："
    echo "  1. 上游构建：clone zai-org/ZCode，Node 24.14.0 + pnpm 10.33.2，"
    echo "     pnpm bootstrap && pnpm build:zcode --base-url http://localhost/"
    echo "     产物在 dist/zcode/releases/<ver>/zcode-<ver>.tar.gz"
    echo "  2. GitHub Actions：本仓库 workflow 会自动构建并作为 artifact 上传"
    echo "  然后放到 packaging/fnOS/dist/runtime/ 或用 --runtime 传入"
    exit 1
fi
echo "[build] 运行时包：${RUNTIME_TGZ} ($(du -h "${RUNTIME_TGZ}" | cut -f1))"

# ── 版本号：官方包内 package.json 是单一事实来源 ───────────────
VERSION="${ZCODE_VERSION:-}"
if [ -z "${VERSION}" ] && [ -f "${REPO}/fnos.version" ]; then
    # fpk 版本号（独立于上游 runtime 版本）：CI 与本地构建都读这里，保证一致
    VERSION="$(head -n 1 "${REPO}/fnos.version" | tr -d '[:space:]')"
fi
if [ -z "${VERSION}" ]; then
    VERSION="$("${NODE}" -e "
const { createRequire } = require('module');
const { execSync } = require('child_process');
const out = execSync('tar -xOzf ' + JSON.stringify(process.argv[1]) + ' zcode/package.json', {maxBuffer: 1<<24});
process.stdout.write(JSON.parse(out.toString()).version);
" "$(winpath "${RUNTIME_TGZ}")")"
fi
echo "[build] 版本 ${VERSION}"

# ── 干净重建 ─────────────────────────────────────────────────
rm -rf "${STAGE}"
mkdir -p "${STAGE}" "${APP_DIR}" "${DIST}"

# ── 1. 应用内容树：解包官方 runtime ──────────────────────────
echo "[build] 解包官方 runtime → app/runtime"
mkdir -p "${APP_DIR}/runtime"
tar -xzf "${RUNTIME_TGZ}" -C "${APP_DIR}/runtime" --strip-components=1
# tar（Windows 的 bsdtar）会把顶层条目解出来；上游包内是 zcode/ 顶层目录
if [ ! -f "${APP_DIR}/runtime/bin/zcode.mjs" ] && [ -d "${APP_DIR}/runtime/zcode" ]; then
    mv "${APP_DIR}/runtime/zcode/"* "${APP_DIR}/runtime/"
    rmdir "${APP_DIR}/runtime/zcode"
fi

for f in bin/zcode.mjs server/entry-http.js agent/zcode.cjs web/index.html package.json; do
    if [ ! -e "${APP_DIR}/runtime/${f}" ]; then
        echo "✗ 官方 runtime 缺少必需文件: ${f}"
        exit 1
    fi
done
echo "[build] runtime 完整性 ✓ ($(du -sh "${APP_DIR}/runtime" | cut -f1))"

### 入口令牌：两条访问链路共用同一份 index.html。
###   网关入口 /app/zcode —— 由网关接入层转发时补令牌，页面无需自己种 cookie；
###   局域网直连 :8988 —— 需要 /?token=<令牌>（或历史写法 /<令牌>）让页面种 cookie。
### 脚本会排除 app / assets / share 等保留首段，避免把网关路径首段误当令牌。
python3 "${HERE}/inject-entry-token.py" "$(winpath "${APP_DIR}/runtime/web/index.html")"

# ── 1.5 网关接入层（非局域网访问）────────────────────────────
# 前端把同源资源与接口写成根绝对路径，而 server 不支持 basePath；飞牛统一网关
# （ui/config 的 gatewaySocket + gatewayPrefix）把 /app/zcode 交给这个进程，
# 由它剥前缀、按文本改写根绝对路径、转发 /ws。
echo "[build] 安装网关接入层 → app/gateway"
rm -rf "${APP_DIR}/gateway"
mkdir -p "${APP_DIR}/gateway"
cp "${PKG_DIR}/gateway/gateway.mjs"   "${APP_DIR}/gateway/gateway.mjs"
cp "${PKG_DIR}/gateway/url-compat.js" "${APP_DIR}/gateway/url-compat.js"

# ── 2. 桌面入口（ui 必须在 app/ 内）──────────────────────────
mkdir -p "${APP_DIR}/ui/images"
cp "${PKG_DIR}/ui/config" "${APP_DIR}/ui/config"
cp "${PKG_DIR}/ui-images/icon_64.png"  "${APP_DIR}/ui/images/icon_64.png"
cp "${PKG_DIR}/ui-images/icon_256.png" "${APP_DIR}/ui/images/icon_256.png"
# 包根的 ICON.PNG(64x64) 与 ICON_256.PNG(256x256) 按 fnOS 规范由 ui-images 派生。
# 不在仓库里同时存放 ICON_256.PNG 与 icon_256.png —— Windows 大小写不敏感，
# 两者会同名冲突，导致 CI checkout 后缺文件。
cp "${PKG_DIR}/ui-images/icon_64.png"  "${STAGE}/ICON.PNG"
cp "${PKG_DIR}/ui-images/icon_256.png" "${STAGE}/ICON_256.PNG"

# ── 3. 自检 ──────────────────────────────────────────────────
# ui/ 下不得残留 fnpack 模板占位符（否则桌面图标点了没反应）
if grep -rn -e '{port}' -e '{display_name}' "${APP_DIR}/ui" > /dev/null 2>&1; then
    echo "✗ ui/ 里仍有 {port} / {display_name} 占位符 → 桌面图标会点了没反应"
    exit 1
fi
# 网关接入层必须齐备，否则非局域网（fnConnect）访问会整条链路不可用。
for f in gateway/gateway.mjs gateway/url-compat.js; do
    if [ ! -f "${APP_DIR}/${f}" ]; then
        echo "✗ 缺少网关接入层文件: ${f}"
        exit 1
    fi
done
# 网关 socket 名与 ui/config 的 gatewaySocket 必须一致：对不上就永远连不通。
GW_SOCK="$(grep -oE '"gatewaySocket"[[:space:]]*:[[:space:]]*"[^"]+"' "${APP_DIR}/ui/config" | sed 's/.*"\([^"]*\)"$/\1/')"
GW_PREFIX="$(grep -oE '"gatewayPrefix"[[:space:]]*:[[:space:]]*"[^"]+"' "${APP_DIR}/ui/config" | sed 's/.*"\([^"]*\)"$/\1/')"
if [ "${GW_SOCK}" != "zcode.sock" ]; then
    echo "✗ ui/config 的 gatewaySocket 应为 zcode.sock，实际为 '${GW_SOCK}'"
    exit 1
fi
if [ "${GW_PREFIX}" != "/app/zcode" ]; then
    echo "✗ ui/config 的 gatewayPrefix 应为 /app/zcode，实际为 '${GW_PREFIX}'"
    exit 1
fi
# cmd/main 里的前缀必须与 ui/config 一致（两处各自硬编码，改一处忘另一处会静默 404）。
if ! grep -q 'GATEWAY_PREFIX="/app/zcode"' "${PKG_DIR}/cmd/main"; then
    echo "✗ cmd/main 的 GATEWAY_PREFIX 与 ui/config 的 gatewayPrefix 不一致"
    exit 1
fi
# 入口令牌脚本必须已注入，且必须认识保留首段（否则网关路径首段会被当令牌）。
if ! grep -q "zcode-fnos-entry-token" "${APP_DIR}/runtime/web/index.html"; then
    echo "✗ web/index.html 未注入入口令牌脚本"
    exit 1
fi
if ! grep -q 'RESERVED' "${APP_DIR}/runtime/web/index.html"; then
    echo "✗ 入口令牌脚本未排除保留首段（网关路径会被误当令牌）"
    exit 1
fi
# 双架构预编译件必须都在（platform=all 的底气）
for arch in linux-x64 linux-arm64; do
    if ! find "${APP_DIR}/runtime/node_modules" -path "*${arch}*" | grep -q .; then
        echo "✗ runtime 里缺少 ${arch} 的预编译件，platform=all 不成立"
        exit 1
    fi
done

# ── 4. manifest / cmd / config（都在根目录）──────────────────
echo "[build] 写 manifest"
sed "s/^version  *=.*/version               = ${VERSION}/" \
    "${PKG_DIR}/manifest" > "${STAGE}/manifest"

### DEP_APPS=none 变体：剥离 install_dep_apps 声明。
### 用途：真机验收 / 依赖应用已装好时绕过 App Center 的依赖变更拦截
### （trim-cli 对声明依赖的本地 fpk 会要求走 UI）。Node 运行时仍由
### cmd/main 的 find_node 跨卷解析拿应用中心的 nodejs_v22。
VARIANT=""
if [ "${DEP_APPS:-nodejs_v22}" = "none" ]; then
    grep -v '^install_dep_apps' "${STAGE}/manifest" > "${STAGE}/manifest.tmp"
    mv "${STAGE}/manifest.tmp" "${STAGE}/manifest"
    VARIANT="-nodep"
    echo "[build] 变体：已移除 install_dep_apps 声明"
fi

cp -r "${PKG_DIR}/cmd"    "${STAGE}/cmd"
cp -r "${PKG_DIR}/config" "${STAGE}/config"
# wizard/ 必需：安装向导（访问令牌）与应用设置页（wizard/config）都由它提供；
# 漏拷会让 App Center 读不到向导内容（install 时 wizardContent=null），
# 面板入口也就拿不到 ${wizard_path} 的值。
cp -r "${PKG_DIR}/wizard" "${STAGE}/wizard"
chmod 755 "${STAGE}/cmd/"*

# ── 5. 打包 ──────────────────────────────────────────────────
FINAL="${DIST}/zcode-${VERSION}${VARIANT}.fpk"
rm -f "${FINAL}"

if [ -n "${FNPACK}" ]; then
    # fnpack 把产物写在它自己的 CWD，所以 cd 到 dist 再调用
    echo "[build] fnpack build → ${FINAL}"
    ( cd "${DIST}" && "${FNPACK}" build -d "$(winpath "${STAGE}")" )
    if [ ! -f "${FINAL}" ] && [ -f "${DIST}/zcode.fpk" ]; then
        mv "${DIST}/zcode.fpk" "${FINAL}"
    fi
else
    # CI 等价打包：fpk = tar.gz，内部 app.tgz（app/ 目录）+ 包根其余文件。
    # 布局与 fnpack build 产物一致（demoapp / 线上包同款），fnpack 仅省去调用。
    echo "[build] fnpack 不可用，手动打包 → ${FINAL}"
    APP_TGZ="${DIST}/.app.tgz"
    ( cd "${APP_DIR}" && tar -czf "${APP_TGZ}" . )
    cp "${APP_TGZ}" "${STAGE}/app.tgz"
    rm -f "${APP_TGZ}"
    ( cd "${STAGE}" && tar -czf "${FINAL}" manifest ICON.PNG ICON_256.PNG \
        app.tgz cmd config )
    rm -f "${STAGE}/app.tgz"
fi
if [ ! -f "${FINAL}" ]; then
    echo "✗ 没有产出 ${FINAL}"
    ls -la "${DIST}"
    exit 1
fi

echo "[build] ✓ ${FINAL}"
ls -la "${FINAL}"
