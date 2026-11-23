// Brazilian Portuguese for main's own strings (main/i18n.ts). Keys are the English text passed to tm(), exactly.
// Pure data, no imports: `npm run i18n:check -w desktop` loads it to list missing and unused keys.
// Terms follow the glossary in src/renderer/src/i18n/README.md.
const ptBR: Record<string, string> = {
  // tray.ts: menu
  'Open Nexo': 'Abrir o Nexo',
  Mute: 'Silenciar',
  Deafen: 'Desativar áudio',
  'Leave voice': 'Sair do canal de voz',
  'Restart to update': 'Reiniciar para atualizar',
  'Restart to update (leaves the call)': 'Reiniciar para atualizar (sai da chamada)',
  'Install Nexo {version}': 'Instalar o Nexo {version}',
  'Quit Nexo': 'Sair do Nexo',
  // tray.ts: tooltip ("Nexo · in General · muted · 2 unread mentions")
  'in {channel}': 'em {channel}',
  'in voice': 'em um canal de voz',
  muted: 'microfone desativado',
  deafened: 'áudio desativado',
  '{count} unread mention': '{count} menção não lida',
  '{count} unread mentions': '{count} menções não lidas',
  // tray.ts: first hide to the tray
  'Nexo is still running in the tray': 'O Nexo continua aberto na bandeja',
  'Click the tray icon to open Nexo again. To exit, right-click it and choose {quit}.':
    'Clique no ícone da bandeja para abrir o Nexo de novo. Para fechar, clique nele com o botão direito e escolha {quit}.',

  // updater.ts
  'Updates are disabled in development builds.': 'As atualizações ficam desativadas em builds de desenvolvimento.',
  'Automatic updates only work in the AppImage. Download new versions from the releases page.':
    'As atualizações automáticas só funcionam no AppImage. Baixe as novas versões na página de releases.',
  'The latest release has no update information yet.': 'A versão mais recente ainda não tem informações de atualização.',
  'No release found on GitHub.': 'Nenhuma versão encontrada no GitHub.',
  'GitHub is rate-limiting update checks. Try again later.':
    'O GitHub está limitando as verificações de atualização. Tente de novo mais tarde.',
  "Couldn't reach GitHub. Check your internet connection.":
    'Não foi possível acessar o GitHub. Verifique sua conexão com a internet.',
  'Update check failed.': 'A verificação de atualizações falhou.',

  // hotkeys.ts
  "Global hotkeys need an X11 session: Wayland doesn't let apps see keys pressed in other windows.":
    'Os atalhos globais precisam de uma sessão X11: o Wayland não deixa os apps verem teclas pressionadas em outras janelas.',
  'Global hotkeys need the Accessibility permission. Allow Nexo in System Settings → Privacy & Security → Accessibility, then set a key again (restart Nexo if it still doesn’t work).':
    'Os atalhos globais precisam da permissão de Acessibilidade. Permita o Nexo em Ajustes do Sistema → Privacidade e Segurança → Acessibilidade e defina a tecla de novo (reinicie o Nexo se ainda não funcionar).',
  "Couldn't load the global input hook (uiohook-napi): {error}":
    'Não foi possível carregar a captura global de teclas (uiohook-napi): {error}',
  "Couldn't start the global input hook: {error}": 'Não foi possível iniciar a captura global de teclas: {error}',
  'The global input hook is unavailable.': 'A captura global de teclas não está disponível.',
}

export default ptBR
