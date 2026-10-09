// ZCode Web 前端 —— fnOS 统一网关子路径兼容层。
//
// 为什么需要：ZCode Web 构建产物把同源资源与接口写成**根绝对路径**
// （HTML 里 /assets/…、Vite preload helper 里的 `/`+路径、运行期的
//  fetch("/api/server-info")、new WebSocket("/ws")…）。而飞牛统一网关把本应用
// 挂在 /app/zcode 前缀下，根绝对路径会逃出前缀、打到面板自身（404 或串到别的应用）。
//
// 本脚本在**页面最早期**注入，接管所有"产生请求 URL"的入口，把同源根绝对路径
// 重写为网关前缀下的路径。动态 import("./xxx.js") 是相对**模块 URL** 解析的，
// 天然落在 /app/zcode/assets/ 下，不需要也不应该改写（改写反而会破坏它）。
//
// 与 fnOS 面板自身路径的关系：/app/、/_fnos/、/__fnos/ 一律原样放行，
// 否则会把面板接口、网关自身资源也拖进本应用前缀。
(function () {
  "use strict";
  var PREFIX = (document.currentScript && document.currentScript.dataset.prefix) || "/app/zcode";
  if (globalThis.__ZCODE_GATEWAY_PREFIX__ === PREFIX) return;
  // 只在网关子路径下生效：局域网直连（http://<ip>:8988/…）时根路径本来就是对的，
  // 改写反而会把它推进 /app/zcode。这也是本层不必按访问方式分别构建的原因。
  // 用 startsWith 判断而非整段相等，因为入口可能是 /app/zcode、/app/zcode/、/app/zcode/<子路由>。
  if (location.pathname !== PREFIX && location.pathname.indexOf(PREFIX + "/") !== 0) return;
  globalThis.__ZCODE_GATEWAY_PREFIX__ = PREFIX;

  /** 已在网关前缀内 / 面板自身命名空间 / 跨源 —— 一律不改写 */
  function skip(pathname) {
    return (
      pathname === PREFIX ||
      pathname.indexOf(PREFIX + "/") === 0 ||
      pathname.indexOf("/app/") === 0 ||
      pathname.indexOf("/_fnos/") === 0 ||
      pathname.indexOf("/__fnos/") === 0
    );
  }

  function mapPath(pathname) {
    if (!pathname || pathname.charAt(0) !== "/" || pathname.indexOf("//") === 0) return pathname;
    if (skip(pathname)) return pathname;
    return PREFIX + pathname;
  }

  /** 把单个 URL（相对/绝对/协议相对）映射到网关前缀下 */
  function route(value) {
    if (typeof value !== "string" || value === "") return value;
    // 根绝对路径：就地改写，保留 query / hash
    if (value.charAt(0) === "/" && value.indexOf("//") !== 0) {
      if (skip(value)) return value;
      var q = value.search(/[?#]/);
      var pathname = q === -1 ? value : value.slice(0, q);
      var rest = q === -1 ? "" : value.slice(q);
      return mapPath(pathname) + rest;
    }
    // 带 origin 的绝对 URL：只处理同源；跨源（zcode.z.ai 等外部接口）原样放行
    try {
      var url = new URL(value, location.href);
      var sameOrigin =
        url.origin === location.origin ||
        ((url.protocol === "ws:" || url.protocol === "wss:") && url.host === location.host);
      if (!sameOrigin) return value;
      if (skip(url.pathname)) return value;
      url.pathname = mapPath(url.pathname);
      if (url.protocol === "ws:" && location.protocol === "https:") url.protocol = "wss:";
      return url.href;
    } catch (e) {
      return value;
    }
  }

  // ── fetch ────────────────────────────────────────────────────────────────
  var nativeFetch = globalThis.fetch;
  if (typeof nativeFetch === "function") {
    globalThis.fetch = function (input, init) {
      try {
        if (typeof input === "string") input = route(input);
        else if (typeof URL !== "undefined" && input instanceof URL) input = route(input.href);
        else if (typeof Request !== "undefined" && input instanceof Request) {
          var target = route(input.url);
          if (target !== input.url) input = new Request(target, input);
        }
      } catch (e) {
        /* 改写失败就按原样发，别把请求整个弄丢 */
      }
      return nativeFetch.call(this, input, init);
    };
  }

  // ── XMLHttpRequest ───────────────────────────────────────────────────────
  if (typeof XMLHttpRequest !== "undefined" && XMLHttpRequest.prototype.open) {
    var nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      try {
        args[1] = route(url);
      } catch (e) {}
      return nativeOpen.apply(this, args);
    };
  }

  // ── WebSocket / EventSource / Worker ─────────────────────────────────────
  ["WebSocket", "EventSource", "Worker", "SharedWorker"].forEach(function (name) {
    var Native = globalThis[name];
    if (typeof Native !== "function") return;
    globalThis[name] = new Proxy(Native, {
      construct: function (target, args, newTarget) {
        try {
          if (args.length) args[0] = route(args[0] instanceof URL ? args[0].href : args[0]);
        } catch (e) {}
        return Reflect.construct(target, args, newTarget);
      },
    });
  });

  // ── 动态插入的资源元素 ───────────────────────────────────────────────────
  // Vite 的 modulepreload helper 走 `link.href = "/" + path`，绕开 fetch/XHR，
  // 只能拦属性赋值与 setAttribute。
  function wrapResourceProperty(type, name) {
    if (typeof type !== "function") return;
    var descriptor = Object.getOwnPropertyDescriptor(type.prototype, name);
    if (!descriptor || !descriptor.configurable || typeof descriptor.set !== "function") return;
    Object.defineProperty(type.prototype, name, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set: function (value) {
        return descriptor.set.call(this, route(value));
      },
    });
  }
  wrapResourceProperty(globalThis.HTMLScriptElement, "src");
  wrapResourceProperty(globalThis.HTMLLinkElement, "href");
  wrapResourceProperty(globalThis.HTMLImageElement, "src");

  if (typeof Element !== "undefined" && Element.prototype.setAttribute) {
    var nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      var lower = String(name).toLowerCase();
      var isResource =
        (this instanceof HTMLScriptElement && lower === "src") ||
        (this instanceof HTMLLinkElement && lower === "href") ||
        (this instanceof HTMLImageElement && lower === "src");
      return nativeSetAttribute.call(this, name, isResource ? route(value) : value);
    };
  }

  // ── 其他出口 ─────────────────────────────────────────────────────────────
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    var nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      return nativeBeacon(route(url), data);
    };
  }

  // 站内链接（如 OAuth 回跳、分享页）在点击时补齐前缀，避免跳出网关。
  document.addEventListener(
    "click",
    function (event) {
      var anchor = event.target && event.target.closest && event.target.closest("a[href]");
      if (!anchor) return;
      var href = anchor.getAttribute("href");
      if (!href) return;
      var next = route(href);
      if (next !== href) anchor.setAttribute("href", next);
    },
    true,
  );
})();
