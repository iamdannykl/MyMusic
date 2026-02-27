import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // 开发服务器配置
  server: {
    port: 5173,
    strictPort: true,
  },
  // 构建配置
  build: {
    target: 'esnext',
  },
  // 优化依赖预构建
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
  },
})
