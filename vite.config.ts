import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './', // o Electron carrega dist/index.html via file://
  plugins: [react()],
  server: { port: 5173, strictPort: true },
});
