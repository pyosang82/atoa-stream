import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// v2 dev: web on 5175, API/WS server on 8890 (production serve.js stays on 8888)
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5175,
    proxy: {
      '/api': { target: 'http://localhost:8890', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8890', ws: true },
    },
  },
})
