// 数字员工 / KPI / 动态 / 自媒体矩阵 全部配置数据
// 将来接真实 API 时，这里可替换为接口拉取的数据

export const EMPLOYEES = [
  {
    id: 'scout', name: '选品情报员', role: 'Product Scout', cat: '电商', icon: '🔭',
    color: 'linear-gradient(135deg,#7c5cff,#22d3ee)', status: 'run',
    tagline: '实时追踪 Etsy 热搜、竞品与社媒趋势，输出高潜力选品清单与利润测算。',
    nodes: [
      { t: '趋势信号抓取', skill: 'Trend Radar', sop: '采集 Etsy 搜索上升词 + Pinterest/Google 趋势', d: '聚合多平台上升关键词，识别季节性 & 长尾机会。', out: '上升词榜单 TOP50' },
      { t: '竞品店铺透视', skill: 'Competitor Lens', sop: '分析头部竞品定价、评价、上新节奏', d: '拆解 3 个标杆店铺的爆款结构与流量来源。', out: '竞品结构报告' },
      { t: '利润测算建模', skill: 'Margin Calc', sop: '综合采购/运费/平台佣金/广告估算净利', d: '按重量与类目自动估算净利与安全定价区间。', out: '选品利润模型' },
      { t: '选品建议交付', skill: 'Decision Engine', sop: '按潜力/竞争/利润三维打分排序', d: '生成可一键转交「Listing 优化师」的选品包。', out: '选品决策清单' }
    ],
    deliverables: [
      { t: '万圣节家居选品包', d: '12 个 SKU，平均预估净利 ¥38' },
      { t: '竞品对标表', d: '3 家标杆店铺结构拆解' }
    ]
  },
  {
    id: 'lister', name: 'Listing 优化师', role: 'Listing Optimizer', cat: '电商', icon: '📝',
    color: 'linear-gradient(135deg,#22d3ee,#34d399)', status: 'run',
    tagline: '基于 SEO 与转化心理学重写标题、标签与描述，提升搜索曝光与下单率。',
    nodes: [
      { t: '关键词研究', skill: 'Keyword Miner', sop: '挖掘高转化长尾词并去重聚类', d: '按搜索量/竞争度筛选 13 个核心词。', out: '关键词矩阵' },
      { t: '标题生成', skill: 'Title Forge', sop: '遵循 Etsy 标题权重规则生成多版本', d: 'A/B 双标题供测试。', out: '标题方案 ×2' },
      { t: '描述撰写', skill: 'Copy Writer', sop: '结构化卖点 + 场景化叙事', d: '突出材质/工艺/送礼场景。', out: 'SEO 描述' },
      { t: '图片建议', skill: 'Visual Advisor', sop: '给出首图与场景图拍摄脚本', d: '提升点击率的视觉规范。', out: '拍摄清单' },
      { t: '上架质检', skill: 'Listing Check', sop: '13 标签/类目/属性完整性校验', d: '拦截漏填属性导致的降权。', out: '上架体检报告' }
    ],
    deliverables: [
      { t: 'Listing 优化稿', d: '标题+13标签+描述，预计曝光 +42%' },
      { t: '首图拍摄脚本', d: '3 张场景图分镜' }
    ]
  },
  {
    id: 'pricer', name: '定价策略师', role: 'Pricing Strategist', cat: '电商', icon: '💰',
    color: 'linear-gradient(135deg,#ffb86b,#ff7ac3)', status: 'idle',
    tagline: '动态平衡利润与转化，给出阶梯定价、捆绑与促销建议。',
    nodes: [
      { t: '成本结构分析', skill: 'Cost Map', sop: '拆解全链路成本', d: '物料/人工/运费/佣金明细。', out: '成本卡' },
      { t: '竞品比价', skill: 'Price Scan', sop: '区间分布与心理价位', d: '定位甜蜜点价格带。', out: '价格带分布' },
      { t: '定价建议', skill: 'Price IQ', sop: '基于弹性给出建议价', d: '主推价 + 锚定价。', out: '定价策略' },
      { t: 'A/B 测试', skill: 'Exp Runner', sop: '部署双价格实验', d: '按转化回收调价。', out: '实验方案' }
    ],
    deliverables: [{ t: '定价建议', d: '主推 $24.9 / 锚定 $34.9' }]
  },
  {
    id: 'service', name: '客服管家', role: 'Service Agent', cat: '电商', icon: '💬',
    color: 'linear-gradient(135deg,#34d399,#22d3ee)', status: 'run',
    tagline: '7×24 多语言自动接待，处理咨询、评价与纠纷，守护店铺评分。',
    nodes: [
      { t: '消息分类', skill: 'Intent Sort', sop: '识别咨询/售前/售后意图', d: '路由到对应话术。', out: '工单分类' },
      { t: '自动回复', skill: 'Reply Bot', sop: '多语言模板 + 知识库', d: 'EN/DE/FR 自动应答。', out: '回复草稿' },
      { t: '评价跟进', skill: 'Review Care', sop: '索取好评 / 安抚差评', d: '提升 4-5 星占比。', out: '评价运营计划' },
      { t: '纠纷处理', skill: 'Case Helper', sop: '生成申诉与补偿方案', d: '降低 case 率。', out: '纠纷处置单' }
    ],
    deliverables: [{ t: '今日接待报告', d: '处理 63 条，自动解决率 88%' }]
  },
  {
    id: 'analyst', name: '数据分析师', role: 'Data Analyst', cat: '电商', icon: '📊',
    color: 'linear-gradient(135deg,#7c5cff,#ff7ac3)', status: 'run',
    tagline: '打通店铺、广告与社媒数据，输出增长诊断与行动清单。',
    nodes: [
      { t: '流量监控', skill: 'Traffic Watch', sop: '曝光/点击/来源拆解', d: '定位流量异常。', out: '流量日报' },
      { t: '转化分析', skill: 'Funnel Pro', sop: '加购/下单漏斗诊断', d: '找出流失环节。', out: '漏斗诊断' },
      { t: '报表生成', skill: 'Report Gen', sop: '自动生成可视化周报', d: 'GMV/复购/品类结构。', out: '经营周报' },
      { t: '增长建议', skill: 'Growth AI', sop: '归因并给行动项', d: '优先级排序。', out: '增长行动清单' }
    ],
    deliverables: [{ t: '周经营报告', d: 'GMV $12.4k，复购 26%' }]
  },
  {
    id: 'ads', name: '广告投手', role: 'Ads Specialist', cat: '电商', icon: '🎯',
    color: 'linear-gradient(135deg,#ff7ac3,#ffb86b)', status: 'learn',
    tagline: '统筹 Etsy Ads 与站外投放，控本增效，自动扩词与否词。',
    nodes: [
      { t: '投放诊断', skill: 'Ads Audit', sop: '评估 ROAS 与预算分配', d: '识别低效广告组。', out: '诊断报告' },
      { t: '关键词拓展', skill: 'Keyword Boost', sop: '挖掘高 ROAS 词', d: '扩量不超预算。', out: '扩词清单' },
      { t: '出价优化', skill: 'Bid Tuner', sop: '动态调价策略', d: '保住 ACOS 红线。', out: '出价方案' },
      { t: '效果复盘', skill: 'ROAS Review', sop: '周维度复盘', d: '沉淀投放经验。', out: '复盘报告' }
    ],
    deliverables: [{ t: '广告优化方案', d: 'ACOS 目标 ≤ 18%' }]
  },
  {
    id: 'editor', name: '内容主编', role: 'Content Director', cat: '自媒体', icon: '🎬',
    color: 'linear-gradient(135deg,#22d3ee,#7c5cff)', status: 'run',
    tagline: '统筹 5 大平台内容选题、脚本与素材，统一调度发布与复盘。',
    nodes: [
      { t: '选题策划', skill: 'Topic Lab', sop: '结合选品与热点建选题库', d: '每周 20 个选题池。', out: '选题库' },
      { t: '脚本撰写', skill: 'Script Writer', sop: '按平台调性写脚本', d: '口播/口播+Vlog。', out: '脚本库' },
      { t: '素材生成', skill: 'Asset Gen', sop: '文生图/图生视频', d: '封面+短视频片段。', out: '素材包' },
      { t: '多平台适配', skill: 'Adapt Pro', sop: '横竖版/字幕/水印适配', d: '一键出 5 版。', out: '适配稿 ×5' },
      { t: '排期发布', skill: 'Scheduler', sop: '错峰定时发布', d: '按平台活跃时段。', out: '发布日历' }
    ],
    deliverables: [{ t: '本周内容日历', d: '5 平台 ×12 条排期' }]
  },
  {
    id: 'douyin', name: '抖音运营', role: 'Douyin Ops', cat: '自媒体', icon: '🎵',
    color: 'linear-gradient(135deg,#ff4d6d,#ffb86b)', status: 'run',
    tagline: '短视频种草 + 直播引流，把流量导回 Etsy 店铺。',
    nodes: [
      { t: '热点选题', skill: 'Hot Spot', sop: '追抖音热榜与贴纸', d: '蹭自然流量。', out: '选题 ×4' },
      { t: '脚本分镜', skill: 'Story Board', sop: '黄金 3 秒结构', d: '完播率优先。', out: '分镜脚本' },
      { t: '发布运营', skill: 'Post Ops', sop: '挂车/评论区引导', d: '导流店铺。', out: '发布方案' },
      { t: '数据复盘', skill: 'Douyin Metrics', sop: '完播/转发/转化', d: '迭代内容。', out: '复盘表' }
    ],
    deliverables: [{ t: '爆款复盘', d: '单条播放 86w，导流 312 单' }]
  },
  {
    id: 'red', name: '小红书运营', role: 'RED Ops', cat: '自媒体', icon: '📕',
    color: 'linear-gradient(135deg,#ff2e4d,#ff7ac3)', status: 'run',
    tagline: '图文 + 短视频种草，打造「礼物/手作」人设，沉淀搜索词。',
    nodes: [
      { t: '选题挖掘', skill: 'Red Trend', sop: '搜爆文与长尾词', d: '笔记灵感。', out: '选题 ×5' },
      { t: '笔记撰写', skill: 'Note Writer', sop: '标题党+干货结构', d: '收藏率优先。', out: '笔记稿' },
      { t: '封面设计', skill: 'Cover Art', sop: '统一视觉风格', d: '3 套封面。', out: '封面方案' },
      { t: '互动运营', skill: 'Engage', sop: '评论区维护', d: '提升权重。', out: '互动策略' }
    ],
    deliverables: [{ t: '爆文笔记', d: '赞藏 1.2w，搜索词占位' }]
  },
  {
    id: 'wechat', name: '公众号运营', role: 'WeChat Ops', cat: '自媒体', icon: '💚',
    color: 'linear-gradient(135deg,#07c160,#22d3ee)', status: 'run',
    tagline: '深度长文沉淀品牌与私域：文稿收集 → 公众号排版 → 发布草稿箱，承接复购与会员运营。',
    tool: 'wechat-dashboard.html',
    nodes: [
      { t: '① 文稿收集', skill: 'Doc Intake', sop: '上传本地文稿（md/txt/html/docx）或拉取飞书文档，归一为可编辑正文', d: '多格式入稿，自动转纯文本/HTML。', out: '归一化文稿' },
      { t: '② 公众号排版', skill: 'Typeset Pro', sop: '套用公众号版式模板（标题/正文/引用/分隔），实时预览手机效果', d: '多模板一键切换，配色与封面可调。', out: '排版稿（HTML）' },
      { t: '③ 发布草稿箱', skill: 'Draft Push', sop: '调用微信草稿箱接口，将排版稿写入公众号草稿（不群发）', d: '演示模式模拟 cgi-bin/draft/add；接入真实 AppID 后直发。', out: '草稿箱草稿' },
      { t: '数据复盘', skill: 'Wx Metrics', sop: '草稿转群发后追踪打开/分享/转化', d: '优化选题与排版。', out: '数据周报' }
    ],
    deliverables: [{ t: '排版发布工具', d: 'wechat-publisher.html · 三步闭环已打通（演示模式）' }]
  },
  {
    id: 'tiktok', name: 'TikTok 运营', role: 'TikTok Ops', cat: '自媒体', icon: '🎶',
    color: 'linear-gradient(135deg,#22d3ee,#7c5cff)', status: 'run',
    tagline: '面向海外 Z 世代的短视频涨粉，开拓欧美跨境流量。',
    nodes: [
      { t: '趋势追踪', skill: 'TT Trends', sop: 'Sound/Challenge 追踪', d: '跟潮流。', out: '趋势清单' },
      { t: '短视频制作', skill: 'Clip Maker', sop: '本土化脚本', d: '去中式表达。', out: '视频脚本' },
      { t: '发布涨粉', skill: 'Grow Bot', sop: '标签+互动策略', d: '自然涨粉。', out: '发布策略' },
      { t: '转化归因', skill: 'TTAttrib', sop: '引流店铺归因', d: '评估 ROI。', out: '归因报告' }
    ],
    deliverables: [{ t: '涨粉周报', d: '净增 4.3k，引流 1.1k 访客' }]
  },
  {
    id: 'ig', name: 'Instagram 运营', role: 'Instagram Ops', cat: '自媒体', icon: '🌅',
    color: 'linear-gradient(135deg,#ff7ac3,#ffb86b)', status: 'learn',
    tagline: '美学图文 + Reels 打造品牌调性，沉淀高净值粉丝。',
    nodes: [
      { t: '视觉规划', skill: 'Visual Plan', sop: 'Grid 美学排版', d: '统一色调。', out: '视觉规范' },
      { t: '图文/Reels', skill: 'Post Craft', sop: '故事化内容', d: '高质感。', out: '内容包' },
      { t: '发布互动', skill: 'Community', sop: 'Story+抽奖', d: '提升粘性。', out: '互动方案' },
      { t: '成效分析', skill: 'IG Insights', sop: 'reach/save 分析', d: '优化方向。', out: '洞察报告' }
    ],
    deliverables: [{ t: '美学内容包', d: 'Reach 提升 2.1 倍' }]
  }
];

export const KPIS = [
  { label: 'GMV（7日）', val: '$48.2k', delta: '+18.4%', up: true },
  { label: '订单量', val: '1,284', delta: '+9.1%', up: true },
  { label: '搜索曝光', val: '312k', delta: '+42%', up: true },
  { label: '转化率', val: '3.8%', delta: '+0.6pt', up: true },
  { label: '社媒粉丝', val: '86.5k', delta: '+5.2k', up: true },
  { label: '任务达成率', val: '98.6%', delta: '+1.2pt', up: true }
];

export const FEED = [
  { ico: '🔭', c: 'rgba(124,92,255,.18)', t: '选品情报员 完成万圣节选品包', d: '12 个 SKU 已转交 Listing 优化师', time: '2 分钟前' },
  { ico: '📝', c: 'rgba(34,211,238,.18)', t: 'Listing 优化师 重写 8 个标题', d: '预计搜索曝光提升 42%', time: '14 分钟前' },
  { ico: '🎬', c: 'rgba(34,211,238,.18)', t: '内容主编 下发本周内容日历', d: '5 平台 ×12 条已排期', time: '32 分钟前' },
  { ico: '🎵', c: 'rgba(255,77,109,.18)', t: '抖音运营 单条播放破 86w', d: '导流店铺 312 单', time: '1 小时前' },
  { ico: '📊', c: 'rgba(124,92,255,.18)', t: '数据分析师 生成经营周报', d: '复购率升至 26%', time: '2 小时前' },
  { ico: '💬', c: 'rgba(52,211,153,.18)', t: '客服管家 处理 63 条咨询', d: '自动解决率 88%', time: '3 小时前' }
];

export const SOCIAL = [
  { name: '抖音', handle: '@etsy手作日记', icon: '🎵', c: 'linear-gradient(135deg,#ff4d6d,#ffb86b)', fans: '42.6k', views: '1.2M', eng: '8.4%', post: '今日 2 条', prog: 80, st: '活跃' },
  { name: '小红书', handle: '@Handmade礼物铺', icon: '📕', c: 'linear-gradient(135deg,#ff2e4d,#ff7ac3)', fans: '28.3k', views: '640k', eng: '11.2%', post: '今日 3 条', prog: 92, st: '活跃' },
  { name: '微信公众号', handle: 'Etsy好物研究所', id: 'wechat', icon: '💚', c: 'linear-gradient(135deg,#07c160,#22d3ee)', fans: '9.1k', views: '86k', eng: '6.7%', post: '本周 2 篇', prog: 50, st: '待群发' },
  { name: 'TikTok', handle: '@craftystudio', icon: '🎶', c: 'linear-gradient(135deg,#22d3ee,#7c5cff)', fans: '53.8k', views: '2.1M', eng: '9.8%', post: '今日 1 条', prog: 66, st: '活跃' },
  { name: 'Instagram', handle: '@crafty.studio', icon: '🌅', c: 'linear-gradient(135deg,#ff7ac3,#ffb86b)', fans: '21.4k', views: '380k', eng: '7.5%', post: '今日 1 条', prog: 40, st: '学习中' }
];
