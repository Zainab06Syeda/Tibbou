import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd())
  const backendTarget = env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8000'

  return {
    logLevel: 'error',
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      fs: {
        // Allow importing the repo-shared permission matrix from outside this
        // package's root (Database/permissions.json is the single source of
        // truth for role -> capability permissions, read by both apps).
        allow: [path.resolve(__dirname, '.'), path.resolve(__dirname, '../../Database')],
      },
      proxy: {
        '/api': {
          target: backendTarget,
          changeOrigin: true,
          rewrite: (requestPath) => requestPath.replace(/^\/api/, ''),
        },
      },
    },
  }
})
