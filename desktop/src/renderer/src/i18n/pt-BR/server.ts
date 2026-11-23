// Messages the server sends in English (errors in acks and handshakes), by their exact text: lib/toast.ts translates them with tKnown(). Not t() keys, so the checker never calls them unused. Source: server/src (fail(ack, '…'), *_ERRORS).
// Keys are the English text exactly as written in t() / msg(); glossary and rules: ../README.md.
//
// tKnown() looks a text up as is, without parsing it. So a message with a number in it is keyed by the text the
// server actually sends: limits that are constants (shared/protocol.ts, server LIMITS) are written out here (when
// one changes, its entry falls back to English until it's updated), and the few messages whose number or type
// varies at run time are listed for every value they can take (see the bottom of the file).
import type { Dict } from '../core'

const MESSAGES: Dict = {
  // ---- handshake (HANDSHAKE_ERRORS; UNKNOWN_TOKEN / NOT_RECOGNIZED are codes the client handles itself) ----
  'Names must be 2–24 letters, numbers, spaces, . _ or -': 'O nome precisa ter de 2 a 24 letras, números, espaços, . _ ou -',
  'That name is already taken': 'Esse nome já está em uso',
  'Wrong server password': 'Senha do servidor incorreta',
  'Server error, try again': 'Erro no servidor, tente de novo',
  'Server error': 'Erro no servidor',
  'Unknown device token': 'Este dispositivo não é reconhecido pelo servidor',

  // ---- roles and permissions (PERMISSION_ERRORS) ----
  'Only admins can manage channels': 'Só admins podem gerenciar canais',
  "Only admins can delete other people's messages": 'Só admins podem excluir mensagens de outras pessoas',
  'Only the owner can change roles': 'Só o dono pode alterar cargos',
  "The owner's role can't be changed": 'O cargo do dono não pode ser alterado',
  'Invalid role': 'Cargo inválido',
  'Only admins can remove accounts': 'Só admins podem remover contas',
  "You can't remove your own account": 'Você não pode remover sua própria conta',
  "The owner can't be removed": 'O dono não pode ser removido',
  'Only the owner can remove admins': 'Só o dono pode remover admins',
  'Only admins can answer sign-in requests': 'Só admins podem responder pedidos de acesso',
  'User not found': 'Usuário não encontrado',
  'This sign-in request expired or was already answered': 'Esse pedido de acesso expirou ou já foi respondido',
  'Invalid answer': 'Resposta inválida',
  'Only admins can move people': 'Só admins podem mover pessoas',
  "Admins can't move the owner": 'Admins não podem mover o dono',

  // ---- channels ----
  'Invalid channel type': 'Tipo de canal inválido',
  'Invalid channel name': 'Nome de canal inválido',
  'Too many channels': 'O servidor já tem o máximo de canais',
  'Channel not found': 'Canal não encontrado',
  'The channel list changed, try again': 'A lista de canais mudou, tente de novo',

  // ---- messages (MESSAGE_ERRORS, message:send) ----
  'Message not found': 'Mensagem não encontrada',
  'Message is empty': 'A mensagem está vazia',
  'Messages are limited to 4000 characters': 'As mensagens têm limite de 4.000 caracteres',
  'Invalid message': 'Mensagem inválida',
  'The message you replied to was not found': 'A mensagem que você respondeu não foi encontrada',
  'You can only edit your own messages': 'Você só pode editar suas próprias mensagens',
  'Invalid emoji': 'Emoji inválido',
  'Invalid reaction': 'Reação inválida',
  'Messages can have at most 20 different reactions': 'Uma mensagem pode ter no máximo 20 reações diferentes',
  'Slow down': 'Calma aí',
  'Invalid pin': 'Fixação inválida',
  'This channel has 50 pinned messages. Unpin one first': 'Este canal já tem 50 mensagens fixadas. Desafixe uma primeiro',
  'Only the person who pinned it, its author or an admin can unpin it':
    'Só quem fixou, quem escreveu a mensagem ou um admin pode desafixar',
  'Invalid attachments': 'Anexos inválidos',
  'Messages can have at most 4 images': 'Uma mensagem pode ter no máximo 4 imagens',
  'The same image is attached twice': 'A mesma imagem foi anexada duas vezes',
  'An image upload expired or was not found. Remove it and add it again':
    'Um envio de imagem expirou ou não foi encontrado. Remova e adicione de novo',

  // ---- search (SEARCH_ERRORS) ----
  'Invalid search': 'Busca inválida',
  'Search is limited to 200 characters': 'A busca tem limite de 200 caracteres',
  'Type at least one word to search': 'Digite pelo menos uma palavra para buscar',
  'Slow down: too many searches': 'Calma aí: muitas buscas seguidas',

  // ---- voice (VOICE_ERRORS, voice:join / stream) ----
  'Voice channel not found': 'Canal de voz não encontrado',
  'Join the voice channel before streaming': 'Entre no canal de voz antes de transmitir',
  "They're not in voice": 'Essa pessoa não está em um canal de voz',
  "You can't nudge yourself": 'Você não pode se acordar',
  "They're not muted": 'O microfone dessa pessoa não está desativado',

  // ---- soundboard (SOUND_ERRORS, SOUND_HTTP_ERRORS) ----
  'Sound not found': 'Som não encontrado',
  'Join a voice channel to play sounds': 'Entre em um canal de voz para tocar sons',
  'Wait a moment before playing another sound': 'Espere um pouco antes de tocar outro som',
  'Sounds must be 16-bit PCM WAV audio (Content-Type audio/wav)':
    'Os sons precisam ser áudio WAV PCM de 16 bits (Content-Type audio/wav)',
  'The file is not a valid WAV audio file': 'O arquivo não é um áudio WAV válido',
  'Sounds are limited to 512 KB': 'Os sons têm limite de 512 KB',
  'The upload is empty': 'O arquivo enviado está vazio',
  'Give the sound a name': 'Dê um nome ao som',
  'Sound names are limited to 32 characters': 'O nome do som tem limite de 32 caracteres',
  'The sound has no audio': 'O som não tem áudio',
  'Sounds are limited to 5 seconds': 'Os sons têm limite de 5 segundos',
  'The soundboard is full (100 sounds). Delete one first': 'O painel de sons está cheio (100 sons). Exclua um primeiro',
  'Slow down: too many sounds in the last minute': 'Calma aí: muitos sons no último minuto',
  'No such sound': 'Esse som não existe',
  'Only the uploader or admins can delete this sound': 'Só quem enviou ou admins podem excluir este som',

  // ---- plugins (PLUGIN_ERRORS) ----
  'Only admins can change plugins': 'Só admins podem alterar plugins',
  'Unknown plugin': 'Plugin desconhecido',
  'Invalid plugin setting': 'Configuração de plugin inválida',

  // ---- music (MUSIC_ERRORS) ----
  'The Music plugin is off': 'O plugin de música está desativado',
  'Join the voice channel to control its music': 'Entre no canal de voz para controlar a música',
  'Invalid track': 'Faixa inválida',
  'You can add at most 100 tracks at once': 'Você pode adicionar no máximo 100 faixas de uma vez',
  'The queue is full (200 tracks)': 'A fila está cheia (200 faixas)',
  'That track is no longer in the queue': 'Essa faixa não está mais na fila',
  'Invalid music action': 'Ação de música inválida',

  // ---- emulator (EMU_ERRORS) ----
  'The Emulator plugin is off': 'O plugin do emulador está desativado',
  'Join the voice channel to play': 'Entre no canal de voz para jogar',
  'Unsupported console': 'Console não suportado',
  'Invalid game title': 'Nome de jogo inválido',
  'Someone is already hosting a game here': 'Alguém já está hospedando um jogo aqui',
  'No game is running in this channel': 'Nenhum jogo rodando neste canal',
  'Only the host can do that': 'Só o host pode fazer isso',
  'Invalid controller': 'Controle inválido',
  'That controller is taken': 'Esse controle já está em uso',
  "They're not in this voice channel": 'Essa pessoa não está neste canal de voz',
  'Invalid pause setting': 'Pausa inválida',

  // ---- profile (PROFILE_ERRORS) ----
  'Nothing to update': 'Nada para atualizar',
  'Invalid color': 'Cor inválida',
  'Invalid status': 'Status inválido',
  'Status is limited to 64 characters': 'O status tem limite de 64 caracteres',
  'Invalid banner': 'Banner inválido',

  // ---- profile picture and banner uploads (avatars.ts) ----
  'Slow down: you can change your picture again in a few seconds': 'Calma aí: você pode trocar sua foto de novo em alguns segundos',
  'Slow down: you can change your banner again in a few seconds': 'Calma aí: você pode trocar seu banner de novo em alguns segundos',
  'Profile pictures must be WebP, PNG, JPEG or GIF (Content-Type image/webp, image/png, image/jpeg or image/gif)':
    'A foto de perfil precisa ser WebP, PNG, JPEG ou GIF (Content-Type image/webp, image/png, image/jpeg ou image/gif)',
  'Banners must be WebP, PNG, JPEG or GIF (Content-Type image/webp, image/png, image/jpeg or image/gif)':
    'O banner precisa ser WebP, PNG, JPEG ou GIF (Content-Type image/webp, image/png, image/jpeg ou image/gif)',
  'Profile pictures are limited to 512 KB': 'A foto de perfil tem limite de 512 KB',
  'Animated profile pictures are limited to 2 MB': 'A foto de perfil animada tem limite de 2 MB',
  'Banners are limited to 2 MB': 'O banner tem limite de 2 MB',
  'Animated banners are limited to 4 MB': 'O banner animado tem limite de 4 MB',
  'The file is not a WebP, PNG, JPEG or GIF image': 'O arquivo não é uma imagem WebP, PNG, JPEG ou GIF',
  'No profile picture': 'Sem foto de perfil',
  'No banner': 'Sem banner',

  // ---- image attachments (attachments.ts) ----
  'Slow down: too many images in the last minute': 'Calma aí: muitas imagens no último minuto',
  'Images must be PNG, JPEG, WebP or GIF (Content-Type image/png, image/jpeg, image/webp or image/gif)':
    'As imagens precisam ser PNG, JPEG, WebP ou GIF (Content-Type image/png, image/jpeg, image/webp ou image/gif)',
  'The file is not a PNG, JPEG, WebP or GIF image': 'O arquivo não é uma imagem PNG, JPEG, WebP ou GIF',
  "Couldn't read the image size (is the file damaged?)": 'Não deu pra ler o tamanho da imagem (o arquivo está corrompido?)',
  'Images are limited to 16384×16384 pixels': 'As imagens têm limite de 16384×16384 pixels',
  'Images are limited to 10 MB': 'As imagens têm limite de 10 MB',
  'No such image': 'Essa imagem não existe',

  // ---- link previews (EMBED_ERRORS) ----
  'Invalid link': 'Link inválido',
  'Slow down: too many link previews in the last minute': 'Calma aí: muitas prévias de link no último minuto',

  // ---- sign-in requests (ACCESS_REQUEST_ERRORS, accounts.ts) ----
  'No account with that name': 'Nenhuma conta com esse nome',
  'Too many sign-in requests from this device. Wait for an answer or cancel one first':
    'Pedidos de acesso demais deste dispositivo. Espere uma resposta ou cancele um primeiro',
  'Too many sign-in requests right now. Try again in a few minutes':
    'Muitos pedidos de acesso agora. Tente de novo em alguns minutos',
  'No such sign-in request (it expired, was answered or was cancelled)':
    'Esse pedido de acesso não existe (expirou, foi respondido ou foi cancelado)',
  'Request too large': 'Pedido grande demais',
}

// ---- messages with a run-time value: every value they can take ----

// VOICE_ERRORS.nudgeCooldown: "You can nudge them again in N s", N from 1 to NUDGE_COOLDOWN_MS (15 s) rounded up.
// A margin up to 60 covers a server configured with a longer cooldown.
for (let s = 1; s <= 60; s++) {
  MESSAGES[`You can nudge them again in ${s} s`] = `Você pode acordar essa pessoa de novo em ${s} s`
}

// Upload whose content doesn't match its Content-Type: "The file is image/png, not image/jpeg" (both image types).
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
for (const actual of IMAGE_TYPES) {
  for (const declared of IMAGE_TYPES) {
    if (actual !== declared) MESSAGES[`The file is ${actual}, not ${declared}`] = `O arquivo é ${actual}, não ${declared}`
  }
}

export default MESSAGES
