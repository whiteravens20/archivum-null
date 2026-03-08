import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig(({ mode }) => {
  // Load ALL env vars from root .env (empty prefix = no filter).
  // For Docker / CI there may be no .env file — process.env catches vars set
  // via Dockerfile ENV or CI env: directives.
  // Priority: .env unprefixed → .env VITE_* (backward compat) → process.env unprefixed → process.env VITE_*
  const env = loadEnv(mode, '..', '');
  const get = (key: string) =>
    env[key] ?? env[`VITE_${key}`] ?? process.env[key] ?? process.env[`VITE_${key}`];

  return {
    plugins: [react(), tailwindcss(), basicSsl()],
    envDir: '..', // keep so VITE_* vars are still visible in import.meta.env type stubs
    define: {
      'import.meta.env.VITE_MAX_FILE_SIZE': JSON.stringify(get('MAX_FILE_SIZE')),
      'import.meta.env.VITE_CHUNK_SIZE': JSON.stringify(get('CHUNK_SIZE')),
      'import.meta.env.VITE_TURNSTILE_SITE_KEY': JSON.stringify(get('TURNSTILE_SITE_KEY')),
      'import.meta.env.VITE_DEFAULT_TTL': JSON.stringify(get('DEFAULT_TTL')),
      'import.meta.env.VITE_DEFAULT_MAX_DOWNLOADS': JSON.stringify(get('DEFAULT_MAX_DOWNLOADS')),
    },
    server: {
      https: true,
      proxy: {
        '/api': {
          target: get('VITE_API_TARGET') ?? 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      target: 'es2024',
    },
  };
});
