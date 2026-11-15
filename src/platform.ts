// Diferenças entre Windows e Mac que aparecem na tela (atalhos e caminhos das configurações do sistema).

export const isMac = /mac/i.test(navigator.platform || navigator.userAgent);

/** Atalho como o usuário digita: "⌘Z" / "⌘⇧Z" no Mac, "Ctrl+Z" / "Ctrl+Shift+Z" no Windows. */
export const shortcut = (key: string, shift = false) =>
  isMac ? `⌘${shift ? '⇧' : ''}${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`;

/** Atalho de refazer: ⌘⇧Z no Mac (padrão da Apple), Ctrl+Y no Windows. */
export const redoShortcut = () => (isMac ? shortcut('Z', true) : shortcut('Y'));

/** Onde liberar o microfone para o app quando o sistema bloqueou. */
export const micSettingsPath = () =>
  isMac
    ? 'Ajustes do Sistema › Privacidade e Segurança › Microfone (ative o MusicMaker e abra o app de novo)'
    : 'Configurações do Windows › Privacidade e segurança › Microfone';

/** Onde tirar a entrada do mudo. */
export const inputSettingsPath = () =>
  isMac ? 'Ajustes do Sistema › Som › Entrada' : 'pela tecla de microfone do teclado ou em Configurações › Sistema › Som › Entrada';
