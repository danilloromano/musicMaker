const { app, BrowserWindow, Menu, ipcMain, session, systemPreferences } = require('electron');
const { fork } = require('child_process');
const path = require('path');

// O app se chamava MusicMaker e os projetos salvos (IndexedDB) moram na pasta de dados com esse nome.
// Mantém a pasta antiga para ninguém perder o que já fez depois da troca de nome para Alien Studio.
app.setPath('userData', path.join(app.getPath('appData'), 'MusicMaker'));

// Buffer de captura menor: no Windows a entrada (guitarra) passa de ~10 ms para ~3 ms de atraso.
app.commandLine.appendSwitch('audio-buffer-size', '128');

/**
 * Processo de áudio de baixa latência (dist-host/audio-host.cjs, compilado de electron/host/audioHost.ts):
 * abre a placa pelo ASIO (CoreAudio no Mac) para a monitoração. Fica num processo próprio para que nada da
 * tela atrase um bloco de áudio. É um processo filho comum (o Electron rodando como Node): no utilityProcess
 * a DLL nativa do audify trava ao carregar no Windows. As mensagens vão e voltam pelo processo principal.
 */
let audioHost = null;
function startAudioHost() {
  const file = path.join(__dirname, '..', 'dist-host', 'audio-host.cjs');
  audioHost = fork(file, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  audioHost.on('message', (m) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('audio-host', m);
  });
  audioHost.on('exit', (code) => {
    audioHost = null;
    if (app.isQuitting) return;
    // caiu (driver travou, placa arrancada no meio): sobe de novo e avisa a interface
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('audio-host', { type: 'status', running: false, deviceId: null, buffer: 0, rate: 0, latencyMs: 0, error: `O processo de áudio parou (código ${code}). Ligue a monitoração de novo.` });
    }
    setTimeout(startAudioHost, 1000);
  });
}

ipcMain.on('audio-host', (_e, m) => audioHost?.connected && audioHost.send(m));

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#2b2e32',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    title: 'Alien Studio',
    webPreferences: {
      contextIsolation: true,
      // o agendador de áudio usa timers; não pode ser desacelerado em segundo plano
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  // cada carregamento (inclusive recarregar) é uma interface nova: a monitoração antiga para
  win.webContents.on('did-finish-load', () => audioHost?.connected && audioHost.send({ type: 'reset' }));

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

/**
 * Menu do Mac. O menu padrão do Electron tem Editar › Desfazer (⌘Z), que captura o atalho antes do app
 * e desfaria só o texto de um campo. Aqui o ⌘Z/⌘⇧Z ficam com o Alien Studio; copiar/colar continuam nos campos.
 */
function macMenu() {
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about', label: 'Sobre o Alien Studio' },
        { type: 'separator' },
        { role: 'hide', label: 'Ocultar o Alien Studio' },
        { role: 'hideOthers', label: 'Ocultar os outros' },
        { role: 'unhide', label: 'Mostrar tudo' },
        { type: 'separator' },
        { role: 'quit', label: 'Sair do Alien Studio' },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'cut', label: 'Recortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Colar' },
        { role: 'selectAll', label: 'Selecionar tudo' },
      ],
    },
    {
      label: 'Janela',
      submenu: [
        { role: 'minimize', label: 'Minimizar' },
        { role: 'zoom', label: 'Zoom' },
        { role: 'togglefullscreen', label: 'Tela cheia' },
        { type: 'separator' },
        { role: 'front', label: 'Trazer tudo para a frente' },
      ],
    },
  ]);
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') Menu.setApplicationMenu(macMenu());
  // microfone (gravação) e MIDI (teclado controlador); nada além disso
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    if (permission === 'media' && process.platform === 'darwin') {
      // no Mac o sistema também precisa autorizar: mostra a pergunta do macOS na primeira vez
      systemPreferences.askForMediaAccess('microphone').then(cb, () => cb(false));
      return;
    }
    cb(permission === 'media' || permission === 'midi');
  });
  startAudioHost();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
