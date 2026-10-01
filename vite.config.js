import { defineConfig } from 'vite';

// base: './' 让构建产物使用相对路径，方便直接丢到 CloudStudio / 任意静态服务器
export default defineConfig({
  base: './',
  server: { port: 5173, open: false },
  build: { outDir: 'dist', emptyOutDir: true },
});
