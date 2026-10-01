# 部署与协作指南（CODING + CloudStudio）

本工程已部署到 CloudStudio 并运行（零依赖 `server.js` 监听 `process.env.PORT || 3000`）。
代码源真相（Source of Truth）应放在远程 Git 仓库（推荐腾讯云 CODING，与 CloudStudio 同账号），
CloudStudio 从仓库拉取代码做持续部署。

## 1. 本地预览
```bash
cd etsyops
npm start              # 零依赖静态服务器，默认 http://localhost:3000
# 或本地用 Python 直跑：
python3 -m http.server 3000
```

## 2. 推送到远程仓库（CODING）
1. 在 CODING（dev.tencent.com）新建一个**私有/团队**仓库（如 `etsyops-workbench`），**不要**勾选自动生成 README（保持空仓库）。
2. 拿到仓库地址（HTTPS 形如 `https://e.coding.net/<团队>/<项目>/etsyops-workbench.git`）。
3. 在本机执行：
```bash
git remote add origin <仓库地址>
git branch -M main
git push -u origin main
```

## 3. 自动部署到 CloudStudio（两种接法）
### 方式 A（推荐，最简单）：CloudStudio 关联 CODING 仓库
在 CloudStudio 控制台「导入/关联代码仓库」选择上面的 CODING 仓库，
配置：运行命令 `npm start`、端口 `3000`。之后**每次 push 到 main 自动重新部署**，
无需额外 CI 脚本。

### 方式 B：CODING 持续集成（CI）显式构建校验
工程为零依赖静态站点，`npm install` 为本可选步骤。如需在合并前做校验，
可在 CODING 的「持续集成」中加一个阶段：
```yaml
# .coding/ci.yml（CODING 自有 YAML 语法示意）
master:
  push:
    - stages:
        - name: verify
          image: node:20
          commands:
            - node --version
            - 'test -f server.js && echo "server entry ok"'
```
> 注：实际部署仍由 CloudStudio 关联仓库触发，CI 仅做质量门禁。

## 4. 密钥与敏感信息
- **前端静态文件对浏览器完全可见**，切勿把平台密钥 / API Token 写进 `src/` 源码。
- 真实密钥应在后端（未来 `server/` 编排层）通过环境变量注入，`.env` 已被 `.gitignore` 忽略。

## 5. 分支策略（团队协作）
- `main`：受保护，仅接生产（CloudStudio 部署源）。
- 日常在 `feature/*` 开发，PR 评审后合并到 `main` → CloudStudio 自动部署。

## 6. 当前已落地资源
- CloudStudio 线上链接：https://ef0d5973d07043c3858160a2b6c371dc.app.workbuddy.host
- 资料库（SOP / 素材 / 交付归档）：https://www.workbuddy.cn/space/d/nKNS2kaUYoovmCnlil8Yc1
- 本地仓库：`etsyops/`（main 分支，已提交，待推远端）
