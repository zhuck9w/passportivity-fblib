import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000'
    }
  },
  // `npm run preview` — production-сборка фронта с тем же прокси, что и dev.
  // На телефонах dev-React заметно медленнее, для просмотра с телефона используйте preview.
  preview: {
    port: 4173,
    proxy: {
      '/api': 'http://localhost:4000'
    }
  }
});
