import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const BACKEND = 'http://localhost:18080'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // REST API
      '/api': {
        target: BACKEND,
        changeOrigin: true,
      },
      // WebSocket: terminal PTY stream
      '/ws/terminal': {
        target: BACKEND,
        changeOrigin: true,
        ws: true,
      },
      // WebSocket: web client hub
      '/ws/web': {
        target: BACKEND,
        changeOrigin: true,
        ws: true,
      },
      // WebSocket: daemon connection
      '/ws/daemon': {
        target: BACKEND,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
