import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './', // o Electron carrega dist/index.html via file://
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  // o pacote de amostras da bateria (src/audio/drums/kitData.js, ~7 MB) é um chunk à parte, carregado sob demanda
  build: { chunkSizeWarningLimit: 8000 },
});
