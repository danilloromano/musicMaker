// Ponte entre a página e o processo de áudio de baixa latência (ASIO/CoreAudio), via processo principal.
// Com contextIsolation a página não enxerga o ipcRenderer: só estas duas funções.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('audioHost', {
  send: (m) => ipcRenderer.send('audio-host', m),
  onMessage: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('audio-host', h);
    return () => ipcRenderer.off('audio-host', h);
  },
});
