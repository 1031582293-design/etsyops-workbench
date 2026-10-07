/* ============================================================
   xy-mp-layout 排版引擎（接入工作台）
   ============================================================
   为什么必须做这个：
   微信公众号后台**会丢弃 <style> 标签和 class 属性**，
   所以只靠样式表的排版粘进草稿箱一定「散版」—— 这是原来排版没生效的根因。
   xy-mp-layout skill 的第一条规则正是：样式必须逐个摊平到元素的 style 属性上。
   本模块就是这个能力的实现：
     1. 15 种风格 CSS（从 skill 的 styles.md 提取，见 styles.json）
     2. 把 CSS 摊平成 inline style（支持多选择器、伪元素降级、继承展开）
     3. Markdown → 公众号可用 HTML
     4. 预览用 iframe，发布用摊平后的 HTML —— 两边视觉一致
   ============================================================ */

/* ---------- 风格表（由构建脚本从 skill 的 styles.md 生成） ---------- */
export const STYLES = [{"id": "minimal", "name": "极简黑白", "alias": "默认、极简、干净、黑白、商业方法论、诊断报告", "group": "推荐默认", "css": "body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif;font-size:16px;line-height:1.82;color:#2b2b2b;max-width:740px;margin:0 auto;padding:24px 22px;background:#fff;}h1{font-size:24px;line-height:1.35;font-weight:800;text-align:left;margin:34px 0 24px;color:#111;padding-bottom:16px;border-bottom:1px solid #111;}h2{font-size:19px;line-height:1.45;font-weight:800;margin:42px 0 14px;color:#111;}h2:before{content:\"\";display:block;width:30px;height:3px;background:#111;margin:0 0 12px;}h3{font-size:17px;line-height:1.5;font-weight:760;margin:30px 0 10px;color:#222;}p{margin:12px 0;line-height:1.82;}blockquote{margin:20px 0;padding:13px 16px;border-left:3px solid #111;background:#f7f7f7;color:#555;font-style:normal;}ul{margin:12px 0;padding-left:20px;}li{margin:7px 0;line-height:1.82;}strong{font-weight:850;color:#111;}code{font-family:\"SFMono-Regular\",Consolas,\"Liberation Mono\",Menlo,monospace;background:#f2f2f2;color:#111;padding:2px 6px;border-radius:3px;font-size:14px;}pre{background:#f2f2f2;color:#111;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;}pre code{background:none;padding:0;}hr{border:none;border-top:1px solid #e0e0e0;margin:32px 0;}"}, {"id": "medium", "name": "Medium Essay", "alias": "Medium、长文、随笔、个人观点", "group": "经典媒体", "css": "body{font-family:Georgia,\"Times New Roman\",\"Songti SC\",\"Noto Serif CJK SC\",SimSun,serif;font-size:16px;line-height:1.92;color:#242424;max-width:680px;margin:0 auto;padding:34px 24px;background:#fff;}h1{font-size:28px;line-height:1.28;font-weight:700;text-align:left;margin:42px 0 28px;color:#111;}h2{font-size:22px;line-height:1.35;font-weight:700;margin:52px 0 18px;color:#111;}h3{font-size:18px;line-height:1.45;font-weight:700;margin:34px 0 12px;color:#333;}p{margin:15px 0;line-height:1.92;}blockquote{margin:28px 0;padding:0 0 0 22px;border-left:3px solid #242424;color:#444;font-size:17px;line-height:1.86;font-style:italic;}ul{margin:15px 0;padding-left:24px;}li{margin:8px 0;line-height:1.9;}strong{font-weight:800;color:#111;}code{font-family:\"SFMono-Regular\",Consolas,\"Liberation Mono\",Menlo,monospace;background:#f2f2f2;color:#222;padding:2px 6px;border-radius:3px;font-size:14px;}pre{background:#f2f2f2;color:#222;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;}pre code{background:none;padding:0;}hr{border:none;border-top:1px solid #d8d8d8;margin:40px auto;width:34%;}"}, {"id": "wired", "name": "WIRED Feature", "alias": "WIRED、科技、AI、前沿、产品发布、有冲击力", "group": "经典媒体", "css": "body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif;font-size:16px;line-height:1.74;color:#111;max-width:750px;margin:0 auto;padding:22px;background:#fff;}h1{font-size:28px;line-height:1.16;font-weight:950;text-align:left;margin:36px 0 26px;color:#111;border-top:6px solid #111;border-bottom:6px solid #111;padding:16px 0;}h2{font-size:20px;line-height:1.35;font-weight:950;margin:44px 0 14px;color:#111;background:#f5ff00;padding:10px 12px;}h3{font-size:18px;line-height:1.4;font-weight:900;margin:32px 0 10px;color:#111;text-decoration:underline;text-decoration-thickness:4px;text-decoration-color:#00e5ff;text-underline-offset:5px;}p{margin:12px 0;line-height:1.74;}blockquote{margin:22px 0;padding:15px 16px;background:#111;color:#fff;border-left:0;font-weight:750;font-style:normal;}ul{margin:12px 0;padding-left:0;list-style:none;}li{margin:8px 0;line-height:1.72;padding:8px 10px;background:#f2f2f2;border-left:5px solid #111;}strong{font-weight:950;color:#111;background:#f5ff00;}code{font-family:\"SFMono-Regular\",Consolas,\"Liberation Mono\",Menlo,monospace;background:#111;color:#00e5ff;padding:2px 6px;border-radius:0;font-size:14px;}pre{background:#111;color:#00e5ff;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;}pre code{background:none;padding:0;color:inherit;}hr{border:none;height:5px;background:#111;margin:34px 0;}"}, {"id": "verge", "name": "The Verge Briefing", "alias": "The Verge、Verge、年轻、热点、资讯评论", "group": "经典媒体", "css": "body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif;font-size:16px;line-height:1.76;color:#171717;max-width:750px;margin:0 auto;padding:22px;background:#fff7fb;}h1{font-size:27px;line-height:1.2;font-weight:950;text-align:left;margin:36px 0 24px;color:#fff;background:#111;padding:18px 16px;box-shadow:8px 8px 0 #ff4fd8;}h2{font-size:20px;line-height:1.35;font-weight:900;margin:44px 0 14px;color:#111;padding:10px 12px;background:#bcff2f;}h3{font-size:18px;line-height:1.42;font-weight:880;margin:32px 0 10px;color:#111;border-bottom:3px solid #ff4fd8;padding-bottom:6px;}p{margin:12px 0;line-height:1.76;}blockquote{margin:22px 0;padding:14px 16px;border:3px solid #111;background:#fff;color:#111;font-weight:700;font-style:normal;}ul{margin:12px 0;padding-left:0;list-style:none;}li{margin:8px 0;line-height:1.74;padding:9px 10px;background:#fff;border-left:5px solid #ff4fd8;}strong{font-weight:950;color:#111;background:#bcff2f;}code{font-family:\"SFMono-Regular\",Consolas,\"Liberation Mono\",Menlo,monospace;background:#111;color:#bcff2f;padding:2px 6px;border-radius:0;font-size:14px;}pre{background:#111;color:#bcff2f;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;}pre code{background:none;padding:0;color:inherit;}hr{border:none;height:3px;background:#ff4fd8;margin:34px 0;width:70%;}"}, {"id": "stripe", "name": "Stripe Docs", "alias": "Stripe、文档、工具说明、教程、操作指南、产品文档", "group": "科技产品", "css": "body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif;font-size:16px;line-height:1.78;color:#2a2f45;max-width:760px;margin:0 auto;padding:24px 22px;background:#fbfcff;}h1{font-size:25px;line-height:1.32;font-weight:850;text-align:left;margin:36px 0 24px;color:#0a2540;}h2{font-size:19px;line-height:1.45;font-weight:820;margin:42px 0 14px;color:#0a2540;padding:10px 12px;background:#f1f5ff;border-left:4px solid #635bff;}h3{font-size:17px;line-height:1.5;font-weight:780;margin:30px 0 10px;color:#425466;}p{margin:12px 0;line-height:1.78;}blockquote{margin:20px 0;padding:14px 16px;background:#fff;border:1px solid #d9e2f3;border-left:4px solid #635bff;color:#3c4257;font-style:normal;}ul{margin:12px 0;padding-left:0;list-style:none;counter-reset:item;}li{margin:8px 0;line-height:1.76;padding:9px 10px;background:#fff;border:1px solid #e5ebf5;}li:before{counter-increment:item;content:\"0\" counter(item) \" \";font-family:\"SFMono-Regular\",Consolas,\"Liberation Mono\",Menlo,monospace;font-size:12px;color:#635bff;font-weight:800;}strong{font-weight:850;color:#0a2540;}code{font-family:\"SFMono-Regular\",Consolas,\"Liberation Mono\",Menlo,monospace;background:#eef2ff;color:#3b35a8;padding:2px 6px;border-radius:4px;font-size:14px;}pre{background:#eef2ff;color:#3b35a8;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;}pre code{background:none;padding:0;}hr{border:none;border-top:1px solid #d9e2f3;margin:32px 0;}"}, {"id": "apple", "name": "Apple Newsroom", "alias": "Apple、正式公告、品牌稿、产品介绍", "group": "经典媒体", "css": "body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif;font-size:16px;line-height:1.82;color:#1d1d1f;max-width:730px;margin:0 auto;padding:34px 24px;background:#fff;}h1{font-size:30px;line-height:1.16;font-weight:800;text-align:center;margin:42px 0 30px;color:#1d1d1f;}h2{font-size:21px;line-height:1.42;font-weight:750;margin:48px 0 16px;color:#1d1d1f;text-align:center;}h3{font-size:18px;line-height:1.5;font-weight:700;margin:32px 0 10px;color:#424245;}p{margin:13px 0;line-height:1.82;}blockquote{margin:22px 0;padding:16px 18px;background:#f5f5f7;border-left:0;color:#424245;border-radius:10px;font-style:normal;}ul{margin:13px 0;padding-left:22px;}li{margin:7px 0;line-height:1.82;}strong{font-weight:800;color:#1d1d1f;}code{font-family:\"SFMono-Regular\",Consolas,\"Liberation Mono\",Menlo,monospace;background:#f5f5f7;color:#1d1d1f;padding:2px 6px;border-radius:5px;font-size:14px;}pre{background:#f5f5f7;color:#1d1d1f;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;border-radius:10px;}pre code{background:none;padding:0;}hr{border:none;border-top:1px solid #d2d2d7;margin:36px auto;width:42%;}"}, {"id": "ft", "name": "FT Analysis", "alias": "FT、财经、商业分析、市场判断、对标研究", "group": "经典媒体", "css": "body{font-family:Georgia,\"Times New Roman\",\"Songti SC\",\"Noto Serif CJK SC\",SimSun,serif;font-size:16px;line-height:1.9;color:#262018;max-width:740px;margin:0 auto;padding:24px 22px;background:#fff1df;}h1{font-size:27px;line-height:1.3;font-weight:800;text-align:left;margin:38px 0 24px;color:#111;border-bottom:3px double #5a4a36;padding-bottom:14px;}h2{font-size:21px;line-height:1.42;font-weight:800;margin:46px 0 16px;color:#3b2b1d;padding-top:10px;border-top:1px solid #8a7356;}h3{font-size:18px;line-height:1.5;font-weight:750;margin:32px 0 10px;color:#4c3a29;}p{margin:13px 0;line-height:1.9;}blockquote{margin:22px 0;padding:12px 0 12px 18px;border-left:4px solid #8a7356;color:#4f4030;background:#f9e6cf;font-style:normal;}ul{margin:13px 0;padding-left:22px;}li{margin:7px 0;line-height:1.9;}strong{font-weight:850;color:#111;}code{font-family:\"SFMono-Regular\",Consolas,\"Liberation Mono\",Menlo,monospace;background:#f5dec4;color:#3b2b1d;padding:2px 6px;border-radius:2px;font-size:14px;}pre{background:#f5dec4;color:#3b2b1d;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;}pre code{background:none;padding:0;}hr{border:none;border-top:1px solid #8a7356;margin:34px 0;width:58%;}"}, {"id": "linear", "name": "Linear Changelog", "alias": "Linear、changelog、版本更新、更新日志、路线图", "group": "科技产品", "css": "body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif;font-size:16px;line-height:1.76;color:#d7d7e1;max-width:750px;margin:0 auto;padding:24px 22px;background:#111114;}h1{font-size:25px;line-height:1.32;font-weight:850;text-align:left;margin:36px 0 24px;color:#fff;}h2{font-size:19px;line-height:1.45;font-weight:820;margin:40px 0 14px;color:#fff;padding:10px 0;border-bottom:1px solid #2b2b33;}h2:before{content:\"◆ \";color:#8b5cf6;}h3{font-size:17px;line-height:1.5;font-weight:780;margin:30px 0 10px;color:#c4b5fd;}p{margin:12px 0;line-height:1.76;}blockquote{margin:20px 0;padding:14px 16px;background:#19191f;border:1px solid #2b2b33;color:#d7d7e1;font-style:normal;}ul{margin:12px 0;padding-left:0;list-style:none;}li{margin:8px 0;line-height:1.74;padding:9px 10px;background:#17171c;border-left:3px solid #8b5cf6;}strong{font-weight:850;color:#fff;}code{font-family:\"SFMono-Regular\",Consolas,\"Liberation Mono\",Menlo,monospace;background:#242432;color:#c4b5fd;padding:2px 6px;border-radius:4px;font-size:14px;}pre{background:#242432;color:#c4b5fd;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;}pre code{background:none;padding:0;}hr{border:none;border-top:1px solid #2b2b33;margin:32px 0;}"}, {"id": "github", "name": "GitHub README", "alias": "GitHub、README、开源、安装说明", "group": "科技产品", "css": "body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif;font-size:16px;line-height:1.76;color:#24292f;max-width:760px;margin:0 auto;padding:24px 22px;background:#fff;}h1{font-size:26px;line-height:1.28;font-weight:750;text-align:left;margin:36px 0 22px;color:#24292f;padding-bottom:10px;border-bottom:1px solid #d0d7de;}h2{font-size:20px;line-height:1.45;font-weight:700;margin:38px 0 14px;color:#24292f;padding-bottom:8px;border-bottom:1px solid #d8dee4;}h3{font-size:17px;line-height:1.5;font-weight:700;margin:28px 0 10px;color:#24292f;}p{margin:11px 0;line-height:1.76;}blockquote{margin:18px 0;padding:8px 16px;border-left:4px solid #d0d7de;color:#57606a;background:#fff;font-style:normal;}ul{margin:12px 0;padding-left:24px;}li{margin:6px 0;line-height:1.76;}strong{font-weight:750;color:#24292f;}code{font-family:\"SFMono-Regular\",Consolas,\"Liberation Mono\",Menlo,monospace;background:#f6f8fa;color:#24292f;padding:2px 6px;border-radius:4px;font-size:14px;}pre{background:#f6f8fa;color:#24292f;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;}pre code{background:none;padding:0;}hr{border:none;border-top:1px solid #d0d7de;margin:28px 0;}"}, {"id": "notion", "name": "Notion Memo", "alias": "Notion、备忘录、内部总结、项目复盘", "group": "科技产品", "css": "body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif;font-size:16px;line-height:1.82;color:#37352f;max-width:720px;margin:0 auto;padding:28px 24px;background:#fffefc;}h1{font-size:27px;line-height:1.28;font-weight:780;text-align:left;margin:38px 0 24px;color:#37352f;}h2{font-size:20px;line-height:1.45;font-weight:720;margin:42px 0 14px;color:#37352f;background:#f7f6f3;padding:10px 12px;}h3{font-size:17px;line-height:1.5;font-weight:720;margin:30px 0 10px;color:#37352f;}p{margin:12px 0;line-height:1.82;}blockquote{margin:20px 0;padding:12px 16px;border-left:3px solid #9b9a97;background:#f7f6f3;color:#4f4d48;font-style:normal;}ul{margin:12px 0;padding-left:22px;}li{margin:7px 0;line-height:1.82;}strong{font-weight:800;color:#37352f;background:#fff2cc;}code{font-family:\"SFMono-Regular\",Consolas,\"Liberation Mono\",Menlo,monospace;background:#f1f1ef;color:#37352f;padding:2px 6px;border-radius:3px;font-size:14px;}pre{background:#f1f1ef;color:#37352f;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;}pre code{background:none;padding:0;}hr{border:none;border-top:1px solid #e7e6e2;margin:32px 0;}"}, {"id": "magazine", "name": "Magazine Feature", "alias": "杂志、人物稿、品牌故事、专题", "group": "内容出版", "css": "body{font-family:Georgia,\"Times New Roman\",\"Songti SC\",\"Noto Serif CJK SC\",SimSun,serif;font-size:16px;line-height:1.94;color:#282828;max-width:700px;margin:0 auto;padding:30px 24px;background:#fff;}h1{font-size:28px;line-height:1.3;font-weight:700;text-align:center;margin:42px 0 30px;color:#111;}h1:after{content:\"\";display:block;width:46px;height:1px;background:#111;margin:20px auto 0;}h2{font-size:21px;line-height:1.45;font-weight:700;margin:50px 0 18px;color:#111;text-align:center;}h3{font-size:18px;line-height:1.5;font-weight:700;margin:34px 0 12px;color:#333;text-align:center;}p{margin:15px 0;line-height:1.94;}blockquote{margin:26px 0;padding:0 22px;border-left:0;color:#555;font-size:15px;line-height:1.95;text-align:center;font-style:italic;}blockquote:before{content:\"\\201C\";display:block;font-size:38px;line-height:0.9;color:#a0a0a0;}ul{margin:15px 0;padding-left:22px;}li{margin:8px 0;line-height:1.92;}strong{font-weight:800;color:#111;}code{font-family:\"SFMono-Regular\",Consolas,\"Liberation Mono\",Menlo,monospace;background:#f3f3f3;color:#222;padding:2px 6px;border-radius:2px;font-size:14px;}pre{background:#f3f3f3;color:#222;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;}pre code{background:none;padding:0;}hr{border:none;border-top:1px solid #bdbdbd;margin:36px auto;width:46%;}"}, {"id": "editorial", "name": "Editorial Column", "alias": "专栏、手记、创作者随笔、复盘札记", "group": "内容出版", "css": "body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif;font-size:16px;line-height:1.92;color:#252525;max-width:680px;margin:0 auto;padding:28px 24px;background:#fff;}h1{font-size:25px;line-height:1.42;font-weight:650;text-align:left;margin:38px 0 24px;color:#111;}h2{font-size:19px;line-height:1.5;font-weight:700;margin:46px 0 16px;color:#111;}h2:before{content:\"\";display:block;width:34px;height:2px;background:#111;margin:0 0 12px;}h3{font-size:17px;line-height:1.55;font-weight:700;margin:32px 0 12px;color:#333;}p{margin:14px 0;line-height:1.92;}blockquote{margin:22px 0;padding:0 0 0 18px;border-left:2px solid #222;color:#4f4f4f;font-size:15px;line-height:1.9;font-style:normal;}ul{margin:14px 0;padding-left:20px;}li{margin:7px 0;line-height:1.9;}strong{font-weight:800;color:#111;background:linear-gradient(transparent 62%,#eeeeee 0);}code{font-family:\"SFMono-Regular\",Consolas,\"Liberation Mono\",Menlo,monospace;background:#f5f5f5;color:#222;padding:2px 6px;border-radius:3px;font-size:14px;}pre{background:#f5f5f5;color:#222;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;}pre code{background:none;padding:0;}hr{border:none;border-top:1px solid #e0e0e0;margin:34px 0;}"}, {"id": "newspaper", "name": "Newspaper Report", "alias": "报纸、报道、调查、严肃分析", "group": "内容出版", "css": "body{font-family:\"Songti SC\",\"Noto Serif CJK SC\",Georgia,\"Times New Roman\",SimSun,serif;font-size:16px;line-height:1.88;color:#202020;max-width:760px;margin:0 auto;padding:22px;background:#fff;}h1{font-size:25px;line-height:1.36;font-weight:800;text-align:left;margin:34px 0 20px;color:#111;padding:0 0 14px;border-bottom:3px double #111;}h2{font-size:20px;line-height:1.42;font-weight:800;margin:42px 0 14px;color:#111;padding-top:10px;border-top:2px solid #111;}h3{font-size:17px;line-height:1.5;font-weight:800;margin:30px 0 10px;color:#222;}p{margin:12px 0;line-height:1.88;}blockquote{margin:20px 0;padding:12px 0 12px 18px;border-left:4px solid #555;color:#444;background:#fafafa;font-style:normal;}ul{margin:12px 0;padding-left:21px;}li{margin:7px 0;line-height:1.88;}strong{font-weight:800;color:#111;}code{font-family:\"SFMono-Regular\",Consolas,\"Liberation Mono\",Menlo,monospace;background:#eeeeee;color:#222;padding:2px 6px;border-radius:1px;font-size:14px;}pre{background:#eeeeee;color:#222;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;}pre code{background:none;padding:0;}hr{border:none;border-top:1px solid #999;margin:30px 0;}"}, {"id": "course", "name": "课程讲义", "alias": "课程、学习笔记、讲义、教程", "group": "中文公众号", "css": "body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif;font-size:16px;line-height:1.84;color:#272727;max-width:750px;margin:0 auto;padding:22px;background:#fff;}h1{font-size:24px;line-height:1.38;font-weight:800;text-align:center;margin:34px 0 22px;color:#111;}h2{font-size:19px;line-height:1.45;font-weight:800;margin:40px 0 16px;color:#111;padding:11px 14px;background:#f3f3f3;}h3{font-size:17px;line-height:1.5;font-weight:800;margin:30px 0 10px;color:#111;padding-bottom:6px;border-bottom:1px dotted #aaa;}p{margin:12px 0;line-height:1.84;}blockquote{margin:18px 0;padding:14px 16px;background:#f8f8f8;border-left:0;border-top:1px solid #e1e1e1;border-bottom:1px solid #e1e1e1;color:#444;font-style:normal;}ul{margin:12px 0;padding-left:20px;}li{margin:7px 0;line-height:1.84;}strong{font-weight:850;color:#111;}code{font-family:\"SFMono-Regular\",Consolas,\"Liberation Mono\",Menlo,monospace;background:#eeeeee;color:#222;padding:2px 6px;border-radius:3px;font-size:14px;}pre{background:#eeeeee;color:#222;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;}pre code{background:none;padding:0;}hr{border:none;border-top:1px solid #ddd;margin:30px 0;}"}, {"id": "event", "name": "活动公告", "alias": "活动、招募、转化、通知、公告", "group": "中文公众号", "css": "body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif;font-size:16px;line-height:1.78;color:#2c2424;max-width:740px;margin:0 auto;padding:22px;background:#fff;}h1{font-size:24px;line-height:1.35;font-weight:900;text-align:center;margin:34px 0 20px;color:#8f1f1d;padding:18px 12px;border:2px solid #8f1f1d;background:#fffafa;}h2{font-size:19px;line-height:1.45;font-weight:850;margin:40px 0 14px;color:#8f1f1d;padding:0 0 10px;border-bottom:2px solid #8f1f1d;}h3{font-size:17px;line-height:1.5;font-weight:800;margin:30px 0 10px;color:#4a2a2a;}p{margin:12px 0;line-height:1.78;}blockquote{margin:18px 0;padding:14px 16px;background:#8f1f1d;color:#fff;border-left:0;font-style:normal;}ul{margin:12px 0;padding-left:20px;}li{margin:7px 0;line-height:1.78;}strong{font-weight:900;color:#8f1f1d;}code{font-family:\"SFMono-Regular\",Consolas,\"Liberation Mono\",Menlo,monospace;background:#fff0f0;color:#8f1f1d;padding:2px 6px;border-radius:3px;font-size:14px;}pre{background:#fff0f0;color:#8f1f1d;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;}pre code{background:none;padding:0;}hr{border:none;height:2px;background:#8f1f1d;margin:30px 0;}"}];

/* ---------- 迷你 CSS 解析器：把样式表转成 {选择器: 声明} ---------- */
function parseCss(css) {
  const out = {};
  // 去掉注释
  const clean = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  // 逐条规则：selector { decls }
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const sels = m[1].split(',').map(s => s.trim()).filter(Boolean);
    const decls = parseDecls(m[2]);
    sels.forEach(sel => {
      // 伪元素/伪类不能摊平，转成「真实元素 + 额外标记」
      const real = sel.replace(/::?(before|after|first-line|first-letter|hover|active|visited|focus)/gi, '');
      const pseudo = (sel.match(/::?(before|after)/i) || [])[1];
      const key = real.toLowerCase();
      if (!key) return;
      if (!out[key]) out[key] = { decls: {}, pseudo: {} };
      Object.assign(out[key].decls, decls);
      if (pseudo) {
        // skill 规则：伪元素装饰改成稳定的边框/留白
        const p = pseudo.toLowerCase();
        out[key].pseudo[p] = Object.assign(out[key].pseudo[p] || {}, decls);
      }
    });
  }
  return out;
}

function parseDecls(text) {
  const d = {};
  String(text || '').split(';').forEach(pair => {
    const i = pair.indexOf(':');
    if (i < 0) return;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k && v) d[k] = v;
  });
  return d;
}

/* ---------- 把某元素的最终样式算出来（摊平 + 继承） ---------- */
function resolveStyle(rules, tag, extraChain) {
  const chain = extraChain || [tag];
  const out = {};
  // ★ 顺序很关键：先铺 body 的可继承属性（skill 规则第 1 条），
  //   再铺元素自身规则——这样元素自己的 font-size 才能正确覆盖 body 的。
  //   反过来写会让 p 只拿到 body 的字号，自己的 margin/line-height 却盖掉继承值。
  const body = rules['body'];
  if (body) ['font-family', 'font-size', 'line-height', 'color'].forEach(p => {
    if (body.decls[p]) out[p] = body.decls[p];
  });
  chain.forEach(sel => {
    const r = rules[sel.toLowerCase()];
    if (!r) return;
    Object.assign(out, r.decls);
  });
  // 去掉只对浏览器预览有效的属性（skill 规则第 6 条）
  ['float', 'position', 'overflow', 'box-shadow', 'text-shadow', 'transform', 'transition', 'animation'].forEach(p => { delete out[p]; });
  return out;
}

function toAttr(style) {
  const keys = Object.keys(style);
  if (!keys.length) return '';
  return keys.map(k => k + ':' + style[k] + ';').join('');
}

/* ---------- Markdown → 公众号 HTML（样式全摊平） ---------- */
export function mdToWechat(md, styleId, opts) {
  opts = opts || {};
  const st = (opts.style && opts.style.css) || pickStyle(styleId).css;
  const rules = parseCss(st);
  const attr = tag => toAttr(resolveStyle(rules, tag));
  // h2 的 before 装饰 → 换成真实 border（skill 规则第 4 条：伪元素改稳定边框）
  // h2 的 :before 装饰改成真实边框（skill 规则第 4 条：伪元素改稳定边框）
  let h2Extra = '';
  if (rules['h2'] && rules['h2'].pseudo && rules['h2'].pseudo.before) {
    const b = rules['h2'].pseudo.before;
    const color = b.background || b['border-bottom'] && b['border-bottom'].split(' ').pop() || '#111';
    const w = b.width || '3px';
    h2Extra = 'border-left:' + w + ' solid ' + color + ';padding-left:12px;';
  }

  const esc = t => String(t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function inline(t) {
    // 代码 → 其次行内代码 → 粗体 → 斜体 → 链接
    let s = esc(t);
    s = s.replace(/`([^`]+)`/g, (m, c) => '<code style="' + attr('code') + '">' + c + '</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, (m, c) => '<strong style="' + attr('strong') + '">' + c + '</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, (m, p, c) => p + '<em style="font-style:italic;">' + c + '</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t2, h) => '<a href="' + h + '" style="color:#576b95;text-decoration:none;">' + t2 + '</a>');
    return s;
  }

  const src = String(md || '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let para = [], inCode = false, codeBuf = [];
  const flushPara = () => {
    if (para.length) {
      out.push('<p style="' + attr('p') + '">' + inline(para.join(' ')) + '</p>');
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (/^```/.test(t)) {
      flushPara();
      if (!inCode) { inCode = true; codeBuf = []; }
      else {
        out.push('<pre style="' + attr('pre') + '"><code style="' + attr('code') + '">' + esc(codeBuf.join('\n')) + '</code></pre>');
        inCode = false; codeBuf = [];
      }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    if (!t) { flushPara(); continue; }
    // 分隔线
    if (/^(---|\*\*\*|___)\s*$/.test(t)) { flushPara(); out.push('<hr style="' + attr('hr') + '">'); continue; }
    // 标题：首个一级标题默认只进 title，不进正文（skill 规则第 3 条）
    const hm = t.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      flushPara();
      const lv = hm[1].length;
      const text = hm[2].trim();
      if (lv === 1 && opts.keepTitle !== true && i === 0) { opts.firstTitle = text; continue; }
      const tag = 'h' + Math.min(lv, 3);
      out.push('<' + tag + ' style="' + attr(tag) + (tag === 'h2' ? h2Extra : '') + '">' + inline(text) + '</' + tag + '>');
      continue;
    }
    // 引用
    if (/^>\s?/.test(t)) { flushPara(); out.push('<blockquote style="' + attr('blockquote') + '">' + inline(t.replace(/^>\s?/, '')) + '</blockquote>'); continue; }
    // 列表
    const lm = t.match(/^([-*]|\d+\.)\s+(.+)$/);
    if (lm) {
      flushPara();
      out.push('<li style="' + attr('li') + '">' + inline(lm[2]) + '</li>');
      continue;
    }
    para.push(t);
  }
  flushPara();
  if (inCode && codeBuf.length) out.push('<pre style="' + attr('pre') + '"><code style="' + attr('code') + '">' + esc(codeBuf.join('\n')) + '</code></pre>');

  // 连续 li 包进 ul（微信公众号要求 ul>li 合法）
  const wrapped = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i].indexOf('<li ') === 0) {
      const group = [out[i]];
      while (i + 1 < out.length && out[i + 1].indexOf('<li ') === 0) { i++; group.push(out[i]); }
      wrapped.push('<ul style="' + attr('ul') + '">' + group.join('') + '</ul>');
    } else wrapped.push(out[i]);
  }
  return { html: wrapped.join('\n'), firstTitle: opts.firstTitle || '' };
}

/* ---------- 风格查询 ---------- */
export function pickStyle(id) {
  return STYLES.find(s => s.id === id) || STYLES[0];
}
export function listStyles() {
  return STYLES.map(s => ({ id: s.id, name: s.name, group: s.group, alias: s.alias }));
}
/* 按分组返回，供 UI 分组展示 */
export function stylesByGroup() {
  const g = {};
  STYLES.forEach(s => { (g[s.group] = g[s.group] || []).push(s); });
  return g;
}

/* ---------- 预览用：带 <style> 的完整 HTML（仅本地 iframe 可见） ---------- */
export function buildPreviewDoc(md, styleId, title) {
  const st = pickStyle(styleId);
  const r = mdToWechat(md, styleId);
  const head = (r.firstTitle || title || '公众号文章预览');
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + head + '</title>'
    + '<style>body{background:#fff;margin:0;padding:16px 18px 28px;max-width:677px;margin:0 auto}'
    + st.css.replace(/h2:before\{[^}]*\}/g, 'h2{border-left:3px solid #07c160;padding-left:10px}')
    + '</style></head><body>'
    + (head ? '<h1 style="' + toAttr(resolveStyle(parseCss(st.css), 'h1')) + '">' + head + '</h1>' : '')
    + r.html
    + '<div class="wx-foot" style="background:#fafafa;color:#999;font-size:11.5px;text-align:center;padding:12px;margin:18px -18px 0">'
    + '排版风格：' + st.name + ' · ' + st.id + '</div>'
    + '</body></html>';
}