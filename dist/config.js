// 注入：后端基地址（构建环境变量 WECHAT_API_BASE）
window.ETSYOPS_API_BASE="";
// 后端 API 基地址配置（前端共用）
// 解析优先级：
//   1. URL 查询参数 ?api=https://backend   （最高优先，便于临时切换后端）
//   2. 构建时注入的 window.ETSYOPS_API_BASE （Cloudflare 构建环境变量 WECHAT_API_BASE 注入）
//   3. 空字符串 → 同源（本机 localhost:3000 跑 server.js 时）
// 注意：本文件由 build:static 复制进 dist/，Cloudflare 构建时可经 WECHAT_API_BASE 注入真实后端地址。
window.ETSYOPS_API_BASE = window.ETSYOPS_API_BASE || '';

window.getApiBase = function () {
  const p = new URLSearchParams(location.search).get('api');
  if (p) return p;
  return window.ETSYOPS_API_BASE || '';
};

// 给工具链接追加 ?api= 参数，使跳转后的页面也能找到后端
window.withApi = function (url) {
  const b = window.getApiBase();
  if (!b) return url;
  const u = new URL(url, location.href);
  u.searchParams.set('api', b);
  return u.pathname + u.search + u.hash;
};
