// Brazilian Portuguese for the "voice" area: the voice panel and stage, Audio & video settings, screen share,
// soundboard, the voice user card, the floating player, and the errors and toasts of voice/ (not music: music.ts).
// Keys are the English text exactly as written in t() / msg(); glossary and rules: ../README.md.
import type { Dict } from '../core'

export default {
  // ---- ControlButtons (sidebar panel and stage toolbar) ----
  Unmute: 'Ativar microfone',
  Mute: 'Silenciar',
  'Unmute (also undeafens)': 'Ativar microfone (também ativa o áudio)',
  'Mute · push to talk ({key})': 'Silenciar · pressione para falar ({key})',
  'Mute · push to talk: no key set': 'Silenciar · pressione para falar: nenhuma tecla definida',
  Undeafen: 'Ativar áudio',
  Deafen: 'Desativar áudio',
  'Turn off camera': 'Desligar câmera',
  'Turn on camera': 'Ligar câmera',
  'Stop sharing': 'Parar transmissão',
  'Starting stream…': 'Iniciando transmissão…',
  'Share your screen': 'Compartilhar sua tela',
  'Leave voice': 'Sair do canal de voz',
  'Excellent connection': 'Conexão excelente',
  'Good connection': 'Conexão boa',
  'Poor connection': 'Conexão ruim',
  'Connection lost': 'Conexão perdida',
  'Measuring connection…': 'Medindo a conexão…',

  // ---- VoiceControls (sidebar voice panel) ----
  'Capturing {capture} fps, sending {send} fps at {width}×{height}':
    'Capturando {capture} fps, enviando {send} fps em {width}×{height}',
  'Capturing {capture} fps, sending {send} fps': 'Capturando {capture} fps, enviando {send} fps',
  '{details}, limited by {limitation, select, cpu {the CPU} bandwidth {bandwidth} other {{limitation}}}':
    '{details}, limitado por {limitation, select, cpu {CPU} bandwidth {largura de banda} other {{limitation}}}',
  "Your screen isn't changing, so there are no new frames to capture. Viewers see changes as soon as they happen. {details}":
    'Sua tela não está mudando, então não há quadros novos para capturar. Os espectadores veem as mudanças assim que elas acontecem. {details}',
  Voice: 'Voz',
  'Voice status': 'Status da voz',
  'Voice disconnected': 'Voz desconectada',
  Dismiss: 'Dispensar',
  'Connecting…': 'Conectando…',
  'Reconnecting…': 'Reconectando…',
  'Voice connected': 'Voz conectada',
  'Voice controls': 'Controles de voz',
  'Push to talk: hold {key}': 'Pressione para falar: segure {key}',
  'Push to talk: no key set (Settings → Audio & video)':
    'Pressione para falar: nenhuma tecla definida (Configurações → Áudio e vídeo)',
  'Open the voice stage': 'Abrir o canal de voz',
  LIVE: 'AO VIVO',
  idle: 'parado',
  "Only {capture} of {fps} fps are being captured. Streaming a game? Your GPU is likely maxed out, which leaves Windows no time to capture it. Lower the game's graphics or turn on upscaling, then cap its FPS a bit below what it reaches, so GPU usage stays under about 85%.":
    'Só {capture} de {fps} fps estão sendo capturados. Transmitindo um jogo? Sua GPU provavelmente está no limite, e aí o Windows não tem tempo de capturar. Baixe os gráficos do jogo ou ative o upscaling e depois limite o FPS um pouco abaixo do que ele alcança, para o uso da GPU ficar abaixo de uns 85%.',

  // ---- DeviceSettings (Settings → Audio & video) ----
  '{kind, select, audioinput {Microphone {n}} audiooutput {Speaker {n}} other {Camera {n}}}':
    '{kind, select, audioinput {Microfone {n}} audiooutput {Saída de áudio {n}} other {Câmera {n}}}',
  Microphone: 'Microfone',
  Speaker: 'Saída de áudio',
  'Not supported here. The system default is used.': 'Não é suportado aqui. O padrão do sistema é usado.',
  Camera: 'Câmera',
  'System default': 'Padrão do sistema',
  'Unavailable device': 'Dispositivo indisponível',
  '{kind, select, audioinput {No microphone found.} audiooutput {No speaker found.} other {No camera found.}}':
    '{kind, select, audioinput {Nenhum microfone encontrado.} audiooutput {Nenhuma saída de áudio encontrada.} other {Nenhuma câmera encontrada.}}',
  'Noise suppression': 'Supressão de ruído',
  'Enhanced couldn’t start on this computer, so Standard is used. Restart Nexo to try again.':
    'A Avançada não conseguiu iniciar neste computador, então a Padrão está sendo usada. Reinicie o Nexo para tentar de novo.',
  'Microphone permission denied': 'Permissão do microfone negada',
  'Could not open the microphone': 'Não foi possível abrir o microfone',
  'Microphone level': 'Nível do microfone',
  'Stop listening': 'Parar de ouvir',
  'Hear yourself': 'Ouvir sua voz',
  'Use headphones to avoid feedback.': 'Use fones para evitar microfonia.',
  'Speak to test your microphone.': 'Fale para testar seu microfone.',
  'Playing…': 'Tocando…',
  'Play test sound': 'Tocar som de teste',
  'Sound effects': 'Efeitos sonoros',
  'Mute, deafen, joins, leaves, wake-ups and sign-in requests. Only you hear them.':
    'Silenciar, desativar áudio, entradas, saídas, acordar e pedidos de acesso. Só você ouve.',
  'Play soundboard sounds': 'Tocar os sons do painel de sons',
  'Not while deafened, and never from people you muted.': 'Não com o áudio desativado, e nunca de quem você silenciou.',
  'Soundboard volume': 'Volume do painel de sons',
  'Voice activity': 'Detecção de voz',
  'Push to talk': 'Pressione para falar',
  '{reason} Push to talk still works while Nexo is focused.':
    '{reason} O pressione para falar continua funcionando com o Nexo em foco.',
  'Global push to talk is not running.': 'O pressione para falar global não está ativo.',
  'Input mode': 'Modo de entrada',
  'Your mic is only sent while you hold the key, even in a game.':
    'Seu microfone só é transmitido enquanto você segura a tecla, mesmo dentro de um jogo.',
  'Your mic is sent whenever you are unmuted.': 'Seu microfone é transmitido sempre que não estiver silenciado.',
  'Push to talk key': 'Tecla do pressione para falar',
  'Recording: press a key or mouse button, Esc to cancel':
    'Gravando: pressione uma tecla ou um botão do mouse, Esc para cancelar',
  'Change push to talk key': 'Alterar a tecla do pressione para falar',
  'Press any key or mouse button…': 'Pressione qualquer tecla ou botão do mouse…',
  'Click to set a key': 'Clique para definir uma tecla',
  TALKING: 'FALANDO',
  'Esc cancels. Left and right click can’t be used.':
    'Esc cancela. Os cliques esquerdo e direito não podem ser usados.',
  '{combo} is already used by {action}. Change it in Settings → Keybinds first.':
    '{combo} já é usado por {action}. Altere em Configurações → Atalhos primeiro.',
  'Click to change. Mouse side buttons work too.': 'Clique para alterar. Os botões laterais do mouse também funcionam.',
  'Choose the key or mouse button to hold while talking.':
    'Escolha a tecla ou o botão do mouse para segurar enquanto fala.',
  'Release delay': 'Atraso ao soltar',
  'Keeps the mic open briefly after you let go, so word endings aren’t cut off.':
    'Mantém o microfone aberto por um instante depois que você solta, para o fim das palavras não ser cortado.',

  // ---- PipPlayer (floating player, pop-out) ----
  'Your stream': 'Sua transmissão',
  "{name}'s stream": 'Transmissão de {name}',
  "{name}'s camera": 'Câmera de {name}',
  '{label} (picture-in-picture)': '{label} (picture-in-picture)',
  'Click to return to the call · drag to move': 'Clique para voltar à chamada · arraste para mover',
  'Pop out': 'Destacar',
  Close: 'Fechar',
  'Close player': 'Fechar player',
  'Return to {channel}': 'Voltar para {channel}',
  'Return to call': 'Voltar à chamada',
  'You are deafened': 'Seu áudio está desativado',
  'Mute stream': 'Silenciar transmissão',
  'Unmute stream': 'Ativar som da transmissão',
  "Couldn't pop out the video": 'Não foi possível destacar o vídeo',

  // ---- SharePicker (Go Live) ----
  'Games on a weaker upload': 'Jogos com upload mais fraco',
  'Most games — smooth and sharp': 'Maioria dos jogos — fluido e nítido',
  'Code, docs and slides — crisp text': 'Código, documentos e slides — texto nítido',
  'LAN or a strong upload': 'LAN ou upload forte',
  'Could not list screens and windows': 'Não foi possível listar as telas e janelas',
  'Close (Esc)': 'Fechar (Esc)',
  'Your system will ask what to share': 'Seu sistema vai perguntar o que compartilhar',
  'On Wayland the desktop portal shows its own picker. Choose a quality below, then pick a screen or window.':
    'No Wayland, o portal da área de trabalho mostra a própria janela de escolha. Escolha uma qualidade abaixo e depois selecione uma tela ou janela.',
  'The browser will show its own picker after you click Choose…':
    'O navegador vai mostrar a própria janela de escolha depois que você clicar em Escolher…',
  Screens: 'Telas',
  'Windows // share picker tab': 'Janelas',
  Refresh: 'Atualizar',
  'Refresh sources': 'Atualizar fontes',
  'Looking for screens and windows…': 'Procurando telas e janelas…',
  'No screens found.': 'Nenhuma tela encontrada.',
  'No windows found.': 'Nenhuma janela encontrada.',
  '{name} (minimized: the stream starts when you switch back to it)':
    '{name} (minimizada: a transmissão começa quando você voltar para ela)',
  Minimized: 'Minimizada',
  Quality: 'Qualidade',
  'Stream quality': 'Qualidade da transmissão',
  'up to {rate} upload': 'até {rate} de upload',
  'Share audio': 'Compartilhar áudio',
  'App audio': 'Áudio do app',
  'System audio (without Nexo)': 'Áudio do sistema (sem o Nexo)',
  '{reason} — viewers will get video only.': '{reason} — os espectadores vão receber só o vídeo.',
  "System audio capture isn't available on Linux yet — viewers will get video only.":
    'A captura do áudio do sistema ainda não está disponível no Linux — os espectadores vão receber só o vídeo.',
  "System audio capture isn't supported on this system — viewers will get video only.":
    'A captura do áudio do sistema não é suportada neste sistema — os espectadores vão receber só o vídeo.',
  'Viewers hear only this app.': 'Os espectadores ouvem só este app.',
  'Viewers hear everything your PC plays except Nexo, so the call stays out of the stream.':
    'Os espectadores ouvem tudo o que toca no seu PC, menos o Nexo, então a chamada fica fora da transmissão.',
  '{reason} natively, so this stream uses Chromium capture.':
    '{reason} na captura nativa, então esta transmissão usa a captura do Chromium.',
  'Viewers will hear everything your default output device plays — including this call. To keep voices out of the stream, pick a different speaker for Nexo in Settings → Audio & video.':
    'Os espectadores vão ouvir tudo o que toca no seu dispositivo de saída padrão — inclusive esta chamada. Para deixar as vozes fora da transmissão, escolha outra saída de áudio para o Nexo em Configurações → Áudio e vídeo.',
  'Stream video only.': 'Transmitir só o vídeo.',
  'Hide Nexo from the stream': 'Esconder o Nexo da transmissão',
  "Viewers won't see your chats or the member list. While you share, Nexo is also hidden from your own screenshots and recordings.":
    'Os espectadores não vão ver seus chats nem a lista de membros. Enquanto você compartilha, o Nexo também fica escondido das suas próprias capturas de tela e gravações.',
  Cancel: 'Cancelar',
  'Starting…': 'Iniciando…',
  'Choose…': 'Escolher…',
  'Go Live': 'Transmitir',

  // ---- SoundUploadDialog (Add a sound) ----
  'That file is too long (max {minutes} minutes). Cut it shorter first.':
    'Esse arquivo é longo demais (máx. {minutes} minutos). Corte um pedaço antes.',
  'That file is too big (max {size} MB)': 'Esse arquivo é grande demais (máx. {size} MB)',
  "Couldn't tell how long that file is, so it's limited to {size} MB. Try an MP3, OGG or WAV file.":
    'Não deu para saber a duração desse arquivo, então o limite é {size} MB. Tente um arquivo MP3, OGG ou WAV.',
  "Couldn't read that file. Try an MP3, OGG, WAV, WebM or M4A file.":
    'Não foi possível ler esse arquivo. Tente um arquivo MP3, OGG, WAV, WebM ou M4A.',
  'That clip is too short': 'Esse trecho é curto demais',
  'Added “{name}” to the soundboard': '“{name}” foi adicionado ao painel de sons',
  'Add a sound': 'Adicionar um som',
  'Uploading…': 'Enviando…',
  'Add to soundboard': 'Adicionar ao painel de sons',
  'Change file': 'Trocar arquivo',
  'Reading the file…': 'Lendo o arquivo…',
  'Choose an audio file': 'Escolher um arquivo de áudio',
  'or drop it here · MP3, OGG, WAV, WebM, M4A… (up to 10 min, 15 MB)':
    'ou solte aqui · MP3, OGG, WAV, WebM, M4A… (até 10 min, 15 MB)',
  Emoji: 'Emoji',
  'Emoji: {emoji}. Change': 'Emoji: {emoji}. Trocar',
  'Choose an emoji': 'Escolha um emoji',
  'Change emoji': 'Trocar emoji',
  'Choose an emoji (optional)': 'Escolher um emoji (opcional)',
  'Remove emoji': 'Remover emoji',
  Name: 'Nome',
  Airhorn: 'Buzina',
  'Sound emoji': 'Emoji do som',
  'Selection {from} to {to}. Arrow keys move it.': 'Seleção de {from} a {to}. As setas movem a seleção.',
  'Selection start': 'Início da seleção',
  'Selection end': 'Fim da seleção',
  Stop: 'Parar',
  'Preview // play the selection': 'Ouvir',
  '(max {seconds} s)': '(máx. {seconds} s)',

  // ---- Soundboard (button, popover, feed, delete confirmation) ----
  Soundboard: 'Painel de sons',
  Someone: 'Alguém',
  '<b>{name}</b> played <i>{sound}</i>': '<b>{name}</b> tocou <i>{sound}</i>',
  'Delete “{name}”?': 'Excluir “{name}”?',
  "It's removed from the soundboard for everyone. This can't be undone.":
    'Ele sai do painel de sons para todo mundo. Não dá para desfazer.',
  'Delete sound': 'Excluir som',
  'Connect to voice to play sounds': 'Entre em um canal de voz para tocar sons',
  '{count} of {max} sounds': '{count} de {max} sons',
  'Search sounds': 'Buscar sons',
  'No sounds yet. Add the first one!': 'Nenhum som ainda. Adicione o primeiro!',
  'No sounds match “{query}”': 'Nenhum som encontrado para “{query}”',
  'Wait a moment…': 'Espere um pouco…',
  'Play “{name}” to the channel': 'Tocar “{name}” no canal',
  'Stop preview': 'Parar prévia',
  'Preview (only you hear it)': 'Ouvir (só você ouve)',
  'Stop preview of {name}': 'Parar a prévia de {name}',
  'Preview {name} (only you hear it)': 'Ouvir {name} (só você ouve)',
  'Delete {name}': 'Excluir {name}',
  'Everyone in your voice channel hears these.': 'Todo mundo no seu canal de voz ouve esses sons.',
  'The soundboard is full ({max} sounds)': 'O painel de sons está cheio ({max} sons)',
  'Add sound': 'Adicionar som',

  // ---- StreamViewers ----
  'No one is watching yet': 'Ninguém está assistindo ainda',
  '{count} watching: {names}': '{count} assistindo: {names}',

  // ---- UserVolumePopover (voice user card) ----
  User: 'Usuário',
  'Options for {name}': 'Opções de {name}',
  'Volume for {name}': 'Volume de {name}',
  'Muted // user volume': 'Silenciado',
  'Reset to 100%': 'Voltar para 100%',
  'Above 100% boosts their voice; it may distort.': 'Acima de 100% amplifica a voz; pode distorcer.',
  'Mute for me': 'Silenciar para mim',
  'Waking up…': 'Acordando…',
  'Wake up': 'Acordar',
  'Move to': 'Mover para',

  // ---- VoiceStage (join card, tiles, You're live card) ----
  "No one's here yet.": 'Ninguém aqui ainda.',
  '{names} and {count} more are here': '{names} e mais {count} estão aqui',
  '{count, plural, one {{names} is here} other {{names} are here}}':
    '{count, plural, one {{names} está aqui} other {{names} estão aqui}}',
  '{count, plural, one {{names} is streaming} other {{names} are streaming}}':
    '{count, plural, one {{names} está transmitindo} other {{names} estão transmitindo}}',
  'Switch to {channel}': 'Mudar para {channel}',
  'Join voice': 'Entrar no canal de voz',
  "You'll leave {channel}.": 'Você vai sair de {channel}.',
  'Connecting to voice…': 'Conectando ao canal de voz…',
  'Connection lost. Reconnecting…': 'Conexão perdida. Reconectando…',
  'Audio is paused by the system. Click to enable sound.':
    'O áudio foi pausado pelo sistema. Clique para ativar o som.',
  'Close pop-out': 'Fechar a janela destacada',
  'Back to grid': 'Voltar para a grade',
  Focus: 'Ampliar',
  'Fullscreen (double-click)': 'Tela cheia (clique duplo)',
  Fullscreen: 'Tela cheia',
  Deafened: 'Áudio desativado',
  Muted: 'Microfone desativado',
  '(you)': '(você)',
  'Muted for you (right-click to change)': 'Silenciado para você (clique com o botão direito para alterar)',
  'Volume {percent}% (right-click to change)': 'Volume {percent}% (clique com o botão direito para alterar)',
  "Your screen isn't changing, so there are no new frames to send. Viewers see changes as soon as they happen. {details}":
    'Sua tela não está mudando, então não há quadros novos para enviar. Os espectadores veem as mudanças assim que elas acontecem. {details}',
  "You're live": 'Você está ao vivo',
  'Idle // stream': 'Parado',
  'Measuring…': 'Medindo…',
  'Viewers keep seeing the last frame until it updates again.':
    'Os espectadores continuam vendo o último quadro até ele atualizar de novo.',
  'Window minimized / no new frames': 'Janela minimizada / sem quadros novos',
  'Stream audio stopped working. Viewers still see your stream.':
    'O áudio da transmissão parou de funcionar. Os espectadores ainda veem sua transmissão.',
  'No stream audio': 'Sem áudio na transmissão',
  'Stop streaming': 'Parar transmissão',
  '{name} is streaming': '{name} está transmitindo',
  'Preview // own stream': 'Pré-visualizar',
  'Watch stream': 'Assistir transmissão',
  'Loading stream…': 'Carregando transmissão…',
  'Stream volume {percent}%': 'Volume da transmissão {percent}%',
  'Stream volume': 'Volume da transmissão',
  'Stop watching': 'Parar de assistir',
  'Hide preview': 'Esconder prévia',

  // ---- net/sounds.ts (soundboard uploads and deletes) ----
  'Not connected to a server': 'Sem conexão com um servidor',
  "This device isn't signed in to the server": 'Este dispositivo não entrou no servidor',
  'The server took too long to respond': 'O servidor demorou demais para responder',
  "Can't reach the server at {url}": 'Não deu para acessar o servidor em {url}',
  'That sound is already gone': 'Esse som já foi excluído',
  "This server doesn't have a soundboard yet (update the Nexo server)":
    'Este servidor ainda não tem painel de sons (atualize o servidor do Nexo)',
  'The soundboard is full': 'O painel de sons está cheio',
  'That clip is too large': 'Esse trecho é grande demais',
  'Too many uploads, try again in a moment': 'Envios demais, tente de novo daqui a pouco',
  'The server rejected the request (HTTP {status})': 'O servidor recusou a solicitação (HTTP {status})',
  'Sounds are limited to {size} KB': 'Os sons são limitados a {size} KB',
  'Invalid response from the server': 'Resposta inválida do servidor',

  // ---- voice/nativeShare.ts (native capture engine) ----
  'Stream audio needs Windows 10 version 2004 or newer':
    'O áudio da transmissão precisa do Windows 10 versão 2004 ou mais recente',
  "This capture helper can't stream audio": 'Este assistente de captura não consegue transmitir áudio',
  '{reason} with native capture — using Chromium capture for streams with audio':
    '{reason} na captura nativa — usando a captura do Chromium para transmissões com áudio',
  'no stream token ({error})': 'sem token de transmissão ({error})',
  'request failed': 'o pedido falhou',
  'the stream did not go live': 'a transmissão não começou',
  'Stream audio stopped: {error}. Viewers still see your stream, without sound.':
    'O áudio da transmissão parou: {error}. Os espectadores ainda veem sua transmissão, sem som.',
  'The shared window was closed, so the stream ended.':
    'A janela compartilhada foi fechada, então a transmissão terminou.',
  'the graphics device was lost (driver reset or GPU change)':
    'o dispositivo gráfico foi perdido (driver reiniciado ou troca de GPU)',
  'Screen share ended: {reason}': 'O compartilhamento de tela terminou: {reason}',
  'the capture helper stopped unexpectedly': 'o assistente de captura parou inesperadamente',
  'the capture failed': 'a captura falhou',
  'Screen share: {error}': 'Compartilhamento de tela: {error}',
  'Native capture failed: {error} — using Chromium capture':
    'A captura nativa falhou: {error} — usando a captura do Chromium',

  // ---- voice/noise.ts (noise suppression modes) ----
  'Off // noise suppression': 'Desativada',
  'No noise suppression. Your mic is sent as it is (echo cancellation stays on).':
    'Sem supressão de ruído. Seu microfone é transmitido do jeito que está (o cancelamento de eco continua ativo).',
  'Standard // noise suppression': 'Padrão',
  'The browser’s built-in suppressor. Light on CPU, handles steady background hum.':
    'O supressor embutido do navegador. Leve para a CPU, dá conta de zumbido de fundo constante.',
  'Enhanced // noise suppression': 'Avançada',
  'RNNoise, a small neural network running on your PC. Removes keyboard clicks, fans and other noise.':
    'RNNoise, uma pequena rede neural rodando no seu PC. Remove cliques de teclado, ventoinhas e outros ruídos.',
  'Enhanced noise suppression couldn’t start, so Standard is used instead.':
    'A supressão de ruído Avançada não conseguiu iniciar, então a Padrão está sendo usada.',

  // ---- voice/ptt.ts (global hotkey status) ----
  'unknown error': 'erro desconhecido',
  'Global hotkeys need the Nexo desktop app. They only work while this window is focused.':
    'Os atalhos globais precisam do app desktop do Nexo. Eles só funcionam com esta janela em foco.',
  'Global hotkeys are unavailable ({error}).': 'Os atalhos globais estão indisponíveis ({error}).',

  // ---- voice/session.ts (share presets, voice errors) ----
  Smooth: 'Fluido',
  'Game // stream quality': 'Jogo',
  Sharp: 'Nítido',
  'Source // stream quality': 'Original',
  'Screen share': 'Compartilhamento de tela',
  '{what}: permission denied': '{what}: permissão negada',
  '{what}: device not found': '{what}: dispositivo não encontrado',
  '{what}: device is in use by another app': '{what}: o dispositivo está sendo usado por outro app',
  '{what}: {error}': '{what}: {error}',
  failed: 'falhou',
  "Couldn't join voice: {error}": 'Não foi possível entrar no canal de voz: {error}',
  'connection failed': 'a conexão falhou',
  'You joined voice from another device': 'Você entrou no canal de voz em outro dispositivo',
  'You were removed from the voice channel': 'Tiraram você do canal de voz',
  'The voice channel was closed': 'O canal de voz foi fechado',
  'The voice server shut down': 'O servidor de voz foi desligado',
  'Lost connection to the voice server': 'A conexão com o servidor de voz caiu',
  'no audio track was captured': 'nenhuma faixa de áudio foi capturada',
  'Screen share: no video track was captured': 'Compartilhamento de tela: nenhuma faixa de vídeo foi capturada',
  'publishing failed': 'a publicação falhou',
  'Stream audio: {error}': 'Áudio da transmissão: {error}',
  'Streaming {name}': 'Transmitindo {name}',
  'Join the voice channel to stream the game': 'Entre no canal de voz para transmitir o jogo',
  'The game has no picture to stream': 'O jogo não tem imagem para transmitir',
  'Left the voice channel': 'Você saiu do canal de voz',
  "Couldn't stream the game: {error}": 'Não foi possível transmitir o jogo: {error}',
  'Game sound: {error}': 'Som do jogo: {error}',

  // ---- voice/soundboard.ts (playback) ----
  "Couldn't load that sound": 'Não foi possível carregar esse som',
  'That sound was deleted': 'Esse som foi excluído',
  "Couldn't play that sound (unsupported audio)": 'Não foi possível tocar esse som (áudio não suportado)',
  "Couldn't play that sound (longer than 5 seconds)": 'Não foi possível tocar esse som (mais de 5 segundos)',
  'a sound': 'um som',

  // ---- voice/voiceActions.ts (wake up, move) ----
  'Nudged {name}': 'Você acordou {name}',
  '{name} moved you to {channel}': '{name} moveu você para {channel}',
  '{name} is trying to get your attention': '{name} está tentando chamar sua atenção',

  // ---- VoiceStage.tsx (people strip under a focused stream / the emulator) ----
  '{count, plural, one {Show # person} other {Show # people}}': '{count, plural, one {Mostrar # pessoa} other {Mostrar # pessoas}}',
  Hide: 'Ocultar',
} satisfies Dict
