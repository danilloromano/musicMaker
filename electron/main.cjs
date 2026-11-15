const { app, BrowserWindow, Menu, session, systemPreferences } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#2b2e32',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    title: 'MusicMaker',
    webPreferences: {
      contextIsolation: true,
      // o agendador de áudio usa timers; não pode ser desacelerado em segundo plano
      backgroundThrottling: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

/**
 * Menu do Mac. O menu padrão do Electron tem Editar › Desfazer (⌘Z), que captura o atalho antes do app
 * e desfaria só o texto de um campo. Aqui o ⌘Z/⌘⇧Z ficam com o MusicMaker; copiar/colar continuam nos campos.
 */
function macMenu() {
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about', label: 'Sobre o MusicMaker' },
        { type: 'separator' },
        { role: 'hide', label: 'Ocultar o MusicMaker' },
        { role: 'hideOthers', label: 'Ocultar os outros' },
        { role: 'unhide', label: 'Mostrar tudo' },
        { type: 'separator' },
        { role: 'quit', label: 'Sair do MusicMaker' },
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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
