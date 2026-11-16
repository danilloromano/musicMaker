import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './', // o Electron carrega dist/index.html via file://
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  // pacotes de amostras (bateria, piano, baixo, cordas, órgão de tubos: src/audio/drums e src/audio/samples)
  // são chunks à parte, carregados sob demanda; o maior tem ~9 MB
  build: { chunkSizeWarningLimit: 10000 },
});
