import { defineConfig } from 'vite';

// Processo de áudio de baixa latência (electron/host/audioHost.ts): roda no Node do Electron (processo filho),
// então sai como um único CommonJS. O audify (módulo nativo) fica de fora e é carregado de node_modules.
export default defineConfig({
  build: {
    ssr: 'electron/host/audioHost.ts',
    outDir: 'dist-host',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      external: ['audify', 'electron'],
      output: { format: 'cjs', entryFileNames: 'audio-host.cjs' },
    },
  },
});
