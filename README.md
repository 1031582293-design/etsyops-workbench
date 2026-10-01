# EtsyOps 智能电商运营工作台（前端）

电商 + 自媒体（抖音/小红书/公众号/TikTok/Instagram）一体化运营工作台。
以「数字员工」为单位组织工作流：每个数字员工内置若干工作节点，按 SOP 串联 skill 并交付成果。

## 技术栈
- [Vite](https://vitejs.dev/) 5（开发服务器 + 构建）
- 原生 ES Module，无框架依赖，零运行时三方库

## 目录结构
```
etsyops/
├─ index.html              # 页面骨架（顶栏 / Tab / 四个视图容器）
├─ vite.config.js          # base:'./' 便于直接静态托管
├─ package.json
├─ src/
│  ├─ main.js              # 入口：装配视图、Tab 切换、事件
│  ├─ dom.js               # $ / $$ 轻量选择器
│  ├─ styles/
│  │  ├─ base.css          # 主题变量 / 布局 / 顶栏 / Tab
│  │  └─ components.css     # 卡片 / 工作流 / 自媒体矩阵 / 流水线
│  ├─ data/employees.js    # 12 名数字员工 + KPI + 动态 + 矩阵（全部配置数据）
│  ├─ render.js            # 总览 / 数字员工 / 自媒体矩阵渲染
│  ├─ workflow.js          # 工作流画布 / 节点运行模拟
│  └─ api/index.js         # 各平台真实 API 适配器（占位，待接入）
└─ dist/                   # vite build 产物（用于云端静态部署）
```

## 本地运行
```bash
npm install      # 安装 vite
npm run dev      # 开发服务器 http://localhost:5173
npm run build    # 产出 dist/
npm run preview  # 本地预览构建产物
```

## 部署
- `npm run build` 后，将 `dist/` 作为静态站点部署到 CloudStudio / 任意静态托管。
- 接入真实 API：在 `src/api/index.js` 按平台填充适配器，密钥通过环境变量注入（勿提交到仓库）。
