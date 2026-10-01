// 真实平台 API 适配器入口（占位）
// 设计原则：每个平台一个适配器，统一返回 { ok, data }，把平台差异隔离在 adapters/ 内，
// 数字员工编排层只依赖这里的稳定接口，不关心底层签名/限流细节。
//
// 各平台官方 API 均已核实存在（详见上一轮可行性探查）：
//   etsy      -> Etsy Open API v3        (OAuth2 PKCE)
//   douyin    -> 抖音开放平台 open_api     (企业号授权)
//   xiaohongshu-> 小红书开放平台           (企业资质 + 权限审核)
//   wechat    -> 微信公众平台 API          (认证服务号)
//   tiktok    -> TikTok Content Posting API
//   instagram -> Instagram Graph API       (Business 账号 + Meta 审核)

const notImplemented = (name) => ({
  ok: false,
  data: null,
  error: `适配器 ${name} 尚未接入（请填入对应平台的密钥与签名逻辑）`
});

export const adapters = {
  etsy: { listActive: () => notImplemented('etsy.listActive'), createDraft: () => notImplemented('etsy.createDraft') },
  douyin: { publishVideo: () => notImplemented('douyin.publishVideo') },
  xiaohongshu: { publishNote: () => notImplemented('xiaohongshu.publishNote') },
  wechat: { massSend: () => notImplemented('wechat.massSend') },
  tiktok: { publishVideo: () => notImplemented('tiktok.publishVideo') },
  instagram: { publishMedia: () => notImplemented('instagram.publishMedia') },
};
