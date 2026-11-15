; Extensões do instalador (electron-builder / NSIS).
; Página "Atalhos": o usuário escolhe se quer um ícone do MusicMaker na área de trabalho.
; O atalho do Menu Iniciar é sempre criado pelo electron-builder.

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh

  Var mmDesktop          ; "1" = criar ícone na área de trabalho, "0" = não criar
  Var mmDesktopCheckbox

  !macro customInit
    StrCpy $mmDesktop "1" ; marcado por padrão (vale também para instalação silenciosa /S)
  !macroend

  !macro customPageAfterChangeDir
    Page custom mmShortcutsPage mmShortcutsLeave

    Function mmShortcutsPage
      ; atualização: mantém a escolha que já existe e não pergunta de novo
      ${if} ${isUpdated}
        Abort
      ${endif}
      !insertmacro MUI_HEADER_TEXT "Atalhos" "Escolha onde o MusicMaker vai aparecer no seu computador."
      nsDialogs::Create 1018
      Pop $0
      ${NSD_CreateLabel} 0 0 100% 24u "O MusicMaker sempre aparece no Menu Iniciar. Se quiser, ele também ganha um ícone na área de trabalho para abrir com dois cliques."
      Pop $0
      ${NSD_CreateCheckbox} 0 34u 100% 12u "Criar um ícone na área de trabalho"
      Pop $mmDesktopCheckbox
      ${if} $mmDesktop == "1"
        ${NSD_Check} $mmDesktopCheckbox
      ${endif}
      nsDialogs::Show
    FunctionEnd

    Function mmShortcutsLeave
      ${NSD_GetState} $mmDesktopCheckbox $0
      ${if} $0 == ${BST_CHECKED}
        StrCpy $mmDesktop "1"
      ${else}
        StrCpy $mmDesktop "0"
      ${endif}
    FunctionEnd
  !macroend

  !macro customInstall
    ${if} ${isUpdated}
      ; atualização: não mexe no atalho (se o usuário apagou, continua apagado)
    ${elseif} $mmDesktop == "1"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${else}
      ; reinstalação com a caixa desmarcada: remove o ícone que tinha ficado de antes
      WinShell::UninstShortcut "$newDesktopLink"
      Delete "$newDesktopLink"
    ${endif}
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  !macroend
!endif

; Como o electron-builder não cria o atalho da área de trabalho (createDesktopShortcut: false),
; ele também não o apaga ao desinstalar: isso fica aqui.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${endif}
!macroend
