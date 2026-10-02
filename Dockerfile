# EtsyOps 后端（零依赖 Node 服务）— 适用于 CloudBase 云托管 / 任意容器平台
# server.js 仅用 Node 内置模块，无需 npm install。
FROM node:20-alpine
WORKDIR /app
COPY . .
ENV HOST=0.0.0.0
EXPOSE 3000
# CloudBase 云托管会注入 PORT 环境变量；这里给个默认兜底。
CMD ["node", "server.js"]
