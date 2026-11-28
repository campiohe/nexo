// Brazilian Portuguese for the "settings" area: SettingsModal (nav, Profile, Keybinds, Notifications, App, Updates,
// Server), Language & time, Appearance, and the labels they read from lib/ (appearance, appIcon, locale, keybinds).
// Other Settings tabs (Audio & video, Activity, Plugins, Members, banner, status) belong to their own areas.
// Keys are the English text exactly as written in t() / msg(); glossary and rules: ../README.md.
import type { Dict } from '../core'

export default {
  // ---- nav ----
  Settings: 'Configurações',
  'Settings sections': 'Seções das configurações',
  You: 'Você',
  Profile: 'Perfil',
  Appearance: 'Aparência',
  'Language & time': 'Idioma e horário',
  'Audio & video': 'Áudio e vídeo',
  Keybinds: 'Atalhos',
  Notifications: 'Notificações',
  Activity: 'Atividade',
  'This device': 'Este dispositivo',
  App: 'App',
  Plugins: 'Plugins',
  Members: 'Membros',
  Server: 'Servidor',

  // ---- Profile ----
  'Animated picture: others see it move when they hover over you or while you talk':
    'Foto animada: os outros veem ela se mexer quando passam o mouse em você ou enquanto você fala',
  'Your name is tied to this device.': 'Seu nome fica vinculado a este dispositivo.',
  Color: 'Cor',
  'Uploading picture…': 'Enviando foto…',
  'Profile picture updated': 'Foto de perfil atualizada',
  'Profile picture removed': 'Foto de perfil removida',
  'Upload picture': 'Enviar foto',
  Remove: 'Remover',

  // ---- Keybinds (lib/keybinds.ts action names too) ----
  'Push to talk': 'Pressione para falar',
  'Toggle mute': 'Ativar/desativar microfone',
  'Toggle deafen': 'Ativar/desativar áudio',
  'Toggle screen share': 'Iniciar/parar transmissão',
  'Leave voice': 'Sair do canal de voz',
  'Quick switcher': 'Troca rápida',
  'Open settings': 'Abrir configurações',
  'Stops your stream, or opens the share picker.': 'Para sua transmissão ou abre a escolha do que compartilhar.',
  '{reason} Until then, these shortcuts only work while Nexo is focused.':
    '{reason} Até lá, esses atalhos só funcionam com o Nexo em foco.',
  '{reason} Without it, global shortcuts only work while Nexo is focused.':
    '{reason} Sem isso, os atalhos globais só funcionam com o Nexo em foco.',
  'Hold to talk. Extra modifiers like Shift still work.': 'Segure para falar. Modificadores extras, como Shift, continuam funcionando.',
  'Only used in push to talk mode.': 'Só é usado no modo pressione para falar.',
  'Recording: press a key combination or mouse button. Esc cancels, Backspace clears.':
    'Gravando: pressione uma combinação de teclas ou um botão do mouse. Esc cancela, Backspace limpa.',
  'Change the {action} shortcut': 'Alterar o atalho de {action}',
  'Press keys…': 'Pressione as teclas…',
  'Not set': 'Não definido',
  Clear: 'Limpar',
  Reset: 'Redefinir',
  '{combo} is used by {action}. Clear it there first.': '{combo} é usado por {action}. Limpe lá primeiro.',
  '{combo} is already used by {action}. Clear it there first.': '{combo} já é usado por {action}. Limpe lá primeiro.',
  'Press a key or mouse button, with any modifiers. For a modifier alone, press and release it. Esc cancels, Backspace clears.':
    'Pressione uma tecla ou um botão do mouse, com os modificadores que quiser. Para um modificador sozinho, pressione e solte. Esc cancela, Backspace limpa.',
  'Click a shortcut to change it. Left and right click can’t be used.':
    'Clique em um atalho para alterá-lo. Os cliques esquerdo e direito não podem ser usados.',
  Global: 'Globais',
  'Work even while a game has focus. None are set by default.': 'Funcionam mesmo com um jogo em foco. Nenhum vem definido.',
  'In Nexo': 'No Nexo',
  'Only while Nexo is focused.': 'Só com o Nexo em foco.',

  // ---- Notifications ----
  'All messages': 'Todas as mensagens',
  'Only mentions': 'Só menções',
  'Messages with your @name or @everyone, and replies to you': 'Mensagens com seu @nome ou @everyone, e respostas a você',
  'Off // desktop notifications': 'Desativadas',
  'Bounce the Dock icon when you’re mentioned': 'Pular o ícone no Dock quando mencionarem você',
  'Flash the taskbar when you’re mentioned': 'Piscar a barra de tarefas quando mencionarem você',
  'Desktop notifications': 'Notificações na área de trabalho',
  "For channels you're not looking at.": 'Para os canais que você não está vendo.',
  'Notification sound': 'Som de notificação',
  'Silent while sound effects are off in Audio & video.': 'Fica em silêncio enquanto os efeitos sonoros estão desativados em Áudio e vídeo.',
  'Only while Nexo is in the background.': 'Só com o Nexo em segundo plano.',
  'Notifications are working. Unread mentions also show on the taskbar and the tray icon.':
    'As notificações estão funcionando. Menções não lidas também aparecem na barra de tarefas e no ícone da bandeja.',
  'Send a test notification': 'Enviar notificação de teste',

  // ---- App ----
  "Couldn't load the app preferences": 'Não foi possível carregar as preferências do app',
  'Close to the system tray': 'Fechar para a bandeja do sistema',
  'Nexo keeps running and stays in voice. Quit from the tray icon.':
    'O Nexo continua aberto e você continua no canal de voz. Para sair, use o ícone da bandeja.',
  'Capture engine': 'Mecanismo de captura',
  'Native uses your graphics card, so games keep their frame rate. Falls back to Chromium if it fails.':
    'O nativo usa sua placa de vídeo, então os jogos mantêm o FPS. Se falhar, volta para o Chromium.',
  '{status} Applies to your next stream.': '{status} Vale a partir da sua próxima transmissão.',
  'Native (beta)': 'Nativo (beta)',
  Chromium: 'Chromium',
  'Checking your graphics card…': 'Verificando sua placa de vídeo…',
  "Native capture isn't available on this PC: {reason}. Streams use Chromium.":
    'A captura nativa não está disponível neste PC: {reason}. As transmissões usam o Chromium.',
  'unknown reason': 'motivo desconhecido',
  'Streams with the hardware encoder on {gpu}.': 'Transmite com o encoder de hardware da {gpu}.',
  'Streams with the hardware encoder.': 'Transmite com o encoder de hardware.',
  'Streams with {encoder} on {gpu}.': 'Transmite com {encoder} na {gpu}.',
  'Streams with {encoder}.': 'Transmite com {encoder}.',
  'Fast game capture': 'Captura rápida de jogos',
  'Chromium engine only. Turn it off if your stream shows a black or frozen picture.':
    'Só no mecanismo Chromium. Desative se a sua transmissão ficar preta ou congelada.',
  'Restart Nexo to apply.': 'Reinicie o Nexo para aplicar.',

  // ---- Updates ----
  Updates: 'Atualizações',
  Version: 'Versão',
  Status: 'Status',
  'Updates are not available for this build.': 'Não há atualizações para esta build.',
  'Nexo checks for updates automatically.': 'O Nexo procura atualizações automaticamente.',
  'Checking for updates…': 'Procurando atualizações…',
  "You're up to date.": 'Você está com a versão mais recente.',
  '{known, select, known {Nexo {version} is available.} other {A new version is available.}}':
    '{known, select, known {O Nexo {version} está disponível.} other {Uma nova versão está disponível.}}',
  '{known, select, known {Nexo {version} is available.} other {A new version is available.}} Download it from the release page.':
    '{known, select, known {O Nexo {version} está disponível.} other {Uma nova versão está disponível.}} Baixe na página da versão.',
  '{known, select, known {Downloading Nexo {version}…} other {Downloading the new version…}} {percent}%':
    '{known, select, known {Baixando o Nexo {version}…} other {Baixando a nova versão…}} {percent}%',
  '{known, select, known {Nexo {version} is downloaded.} other {The new version is downloaded.}} It installs when you restart or quit Nexo.':
    '{known, select, known {O Nexo {version} foi baixado.} other {A nova versão foi baixada.}} Ela é instalada quando você reiniciar ou fechar o Nexo.',
  "Couldn't check for updates: {error}": 'Não foi possível procurar atualizações: {error}',
  'unknown error': 'erro desconhecido',
  'test build, switching to regular releases': 'build de teste, mudando para as versões normais',
  'test build: updates only to newer test builds': 'build de teste: só atualiza para builds de teste mais novas',
  '(last check failed: {error})': '(a última verificação falhou: {error})',
  'Restart to update': 'Reiniciar para atualizar',
  'Restart to update (leaves the call)': 'Reiniciar para atualizar (sai da chamada)',
  Download: 'Baixar',
  'Checking…': 'Verificando…',
  'Check for updates': 'Procurar atualizações',
  'Installs the newest regular release on the next restart, even if its version number is lower':
    'Instala a versão normal mais recente na próxima reinicialização, mesmo que o número da versão seja menor',
  'Leave test builds': 'Sair das builds de teste',
  'Release notes': 'Notas da versão',

  // ---- Server ----
  Name: 'Nome',
  Address: 'Endereço',
  'Not connected': 'Desconectado',
  'Connecting…': 'Conectando…',
  Connected: 'Conectado',
  'Reconnecting…': 'Reconectando…',
  'Connection error': 'Erro de conexão',
  'Switch server': 'Trocar de servidor',
  'You stay signed in here.': 'Sua sessão continua ativa aqui.',
  'Log out of this device': 'Sair neste dispositivo',
  "Deletes this device's key. Without it, <b>{name}</b> can't be recovered and you'd join with a new name.":
    'Apaga a chave deste dispositivo. Sem ela, não dá para recuperar <b>{name}</b> e você entraria com um nome novo.',
  'Log out': 'Sair',
  'Log out of this device?': 'Sair neste dispositivo?',
  "Without this device's key, <b>{name}</b> can't be signed back in. Your messages stay, but you'll need to join with a different name.":
    'Sem a chave deste dispositivo, não dá para entrar de novo como <b>{name}</b>. Suas mensagens ficam, mas você vai precisar entrar com outro nome.',

  // ---- Language & time (lib/locale.ts clock labels too) ----
  Language: 'Idioma',
  System: 'Sistema',
  'System uses your computer’s language: <lang>{language}</lang>.': 'Sistema usa o idioma do seu computador: <lang>{language}</lang>.',
  Clock: 'Relógio',
  Automatic: 'Automático',
  '12-hour': '12 horas',
  '24-hour': '24 horas',
  'Messages show {time}': 'As mensagens mostram {time}',
  'Automatic follows your system’s regional format.': 'Automático segue o formato regional do seu sistema.',

  // ---- Appearance (lib/appearance.ts, lib/appIcon.ts labels too) ----
  Theme: 'Tema',
  Dark: 'Escuro',
  Midnight: 'Meia-noite',
  Light: 'Claro',
  'Accent <name>{accent}</name>': 'Cor de destaque <name>{accent}</name>',
  Mint: 'Menta',
  Blue: 'Azul',
  Violet: 'Violeta',
  Coral: 'Coral',
  Amber: 'Âmbar',
  Rose: 'Rosa',
  'Custom // accent color': 'Personalizada',
  'Custom accent color': 'Cor de destaque personalizada',
  'Saturation and brightness': 'Saturação e brilho',
  'Saturation {saturation}, brightness {brightness}': 'Saturação {saturation}, brilho {brightness}',
  Hue: 'Matiz',
  'Hex color': 'Cor em hexadecimal',
  'Shown darker in the light theme so it stays readable.': 'Aparece mais escura no tema claro para continuar legível.',
  'Shown lighter in dark themes so it stays readable.': 'Aparece mais clara nos temas escuros para continuar legível.',
  'Title bar': 'Barra de título',
  'With search': 'Com busca',
  Minimal: 'Mínima',
  'App icon': 'Ícone do app',
  Classic: 'Clássico',
  'Accent // app icon': 'Destaque',
  Paper: 'Papel',
  Mono: 'Mono',
  'Used for the title bar, tray, taskbar and Start menu. The taskbar shows it the next time Nexo starts.':
    'Usado na barra de título, na bandeja, na barra de tarefas e no menu Iniciar. A barra de tarefas mostra o novo ícone na próxima vez que o Nexo abrir.',
  'Used for the title bar, the Dock and the menu bar.': 'Usado na barra de título, no Dock e na barra de menus.',
  'Used for the title bar, the window and the tray.': 'Usado na barra de título, na janela e na bandeja.',
  Zoom: 'Zoom',
  '{mod}+= and {mod}+- change it from anywhere, {mod}+0 resets it. {mod}+mouse wheel works too.':
    '{mod}+= e {mod}+- mudam o zoom de qualquer lugar, {mod}+0 volta ao normal. {mod}+roda do mouse também funciona.',
  'Zoom {zoom}': 'Zoom {zoom}',
  'Zoom {zoom} (minimum)': 'Zoom {zoom} (mínimo)',
  'Zoom {zoom} (maximum)': 'Zoom {zoom} (máximo)',
  Chat: 'Chat',
  'Compact messages': 'Mensagens compactas',
  'Smaller avatars and less space between messages.': 'Avatares menores e menos espaço entre as mensagens.',
  'Show link previews': 'Mostrar prévias de links',
  'Cards for links (videos, music, articles) under messages. Only on this device.':
    'Cards para links (vídeos, músicas, artigos) embaixo das mensagens. Só neste dispositivo.',
} satisfies Dict
