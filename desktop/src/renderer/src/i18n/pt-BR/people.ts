// Brazilian Portuguese for the "people" area (the file list is in i18n/README.md and scripts/i18n-check.mjs).
// Keys are the English text exactly as written in t() / msg(); glossary and rules: ../README.md.
import type { Dict } from '../core'

export default {
  // ---- ActivitySettings ----
  Activity: 'Atividade',
  "Couldn't load the activity settings": 'Não foi possível carregar as configurações de atividade',
  "Share what I'm playing": 'Mostrar o que estou jogando',
  "Only the game's name is shared. Detection runs on this computer and your programs never leave it.":
    'Só o nome do jogo é compartilhado. A detecção roda neste computador e seus programas nunca saem dele.',
  'Best effort on this system.': 'Neste sistema, a detecção pode não pegar tudo.',
  'Playing <b>{game}</b> · {elapsed}': 'Jogando <b>{game}</b> · {elapsed}',
  'No game detected right now.': 'Nenhum jogo detectado agora.',
  'Your games': 'Seus jogos',
  'Missing a game? Start it, then add it from your running programs.':
    'Falta algum jogo? Abra ele e depois adicione pela lista de programas abertos.',
  'Remove {name}': 'Remover {name}',
  Remove: 'Remover',
  'Add a game': 'Adicionar jogo',
  'Filter running programs': 'Filtrar programas abertos',
  Refresh: 'Atualizar',
  'Loading running programs…': 'Carregando programas abertos…',
  'No running program matches.': 'Nenhum programa aberto com esse nome.',
  'Running programs': 'Programas abertos',
  'Name others see': 'Nome que os outros veem',
  'Pick a program above': 'Escolha um programa acima',
  'Game name': 'Nome do jogo',
  Cancel: 'Cancelar',
  Add: 'Adicionar',

  // ---- AvatarCropDialog ----
  'Crop your picture': 'Recortar sua foto',
  'Save picture': 'Salvar foto',
  'Stays animated. It plays when someone hovers over you and while you talk.':
    'Continua animada. Ela se mexe quando alguém passa o mouse em você e enquanto você fala.',
  'Picture position. Drag or use the arrow keys to move, + and - to zoom.':
    'Posição da foto. Arraste ou use as setas para mover, + e - para dar zoom.',
  'Crop your banner': 'Recortar seu banner',
  'Save banner': 'Salvar banner',
  'Stays animated. It plays while your profile card is open.': 'Continua animado. Ele roda enquanto seu cartão de perfil está aberto.',
  'Banner position. Drag or use the arrow keys to move, + and - to zoom.':
    'Posição do banner. Arraste ou use as setas para mover, + e - para dar zoom.',
  'Animation simplified to fit {limit}: {changes}': 'Animação simplificada para caber em {limit}: {changes}',
  'Simplifying animation… {percent}%': 'Simplificando animação… {percent}%',
  'Preparing animation… {percent}%': 'Preparando animação… {percent}%',
  'Uploading…': 'Enviando…',
  Zoom: 'Zoom',
  Preview: 'Prévia',

  // ---- BannerSettings ----
  Banner: 'Banner',
  'Animated banner: it plays while your profile card is open': 'Banner animado: ele roda enquanto seu cartão de perfil está aberto',
  'Banner style': 'Estilo do banner',
  'Your uploaded banner shows instead of a style. Remove it to use one.':
    'O banner que você enviou aparece no lugar de um estilo. Remova ele para usar um.',
  'Styles use your color.': 'Os estilos usam a sua cor.',
  'Uploading banner…': 'Enviando banner…',
  'Banner updated': 'Banner atualizado',
  'Banner removed': 'Banner removido',
  'Upload banner': 'Enviar banner',

  // ---- ColorSwatches ----
  Color: 'Cor',

  // ---- MemberList ----
  'voice // fallback channel name': 'voz',
  'Playing <b>{game}</b>': 'Jogando <b>{game}</b>',
  'Right-click to move to another channel': 'Clique com o botão direito para ir para outro canal',
  'Right-click for volume and actions': 'Clique com o botão direito para volume e ações',
  '(you)': '(você)',
  LIVE: 'AO VIVO',
  'In {channel}': 'Em {channel}',
  Members: 'Membros',
  'Online · {count}': 'Online · {count}',
  'Offline · {count}': 'Offline · {count}',
  'Server owner': 'Dono do servidor',
  Admin: 'Admin',

  // ---- MembersSection ----
  "You're the owner. You can make people admins and remove accounts.":
    'Você é o dono. Pode tornar outras pessoas admins e remover contas.',
  "You're an admin. You can remove members. Only the owner can change roles or remove admins.":
    'Você é admin. Pode remover membros. Só o dono pode alterar cargos ou remover admins.',
  'Admins manage channels and accounts. Ask one if you need something changed.':
    'Os admins cuidam dos canais e das contas. Fale com um se precisar mudar alguma coisa.',
  'Removed {name}': 'Conta de {name} removida',
  "This server doesn't have roles yet, so everyone can manage channels. Update the server to manage members here.":
    'Este servidor ainda não tem cargos, então todo mundo pode gerenciar canais. Atualize o servidor para gerenciar os membros aqui.',
  'Role of {name}': 'Cargo de {name}',
  'Remove {name}?': 'Remover {name}?',
  'Remove account': 'Remover conta',
  "This deletes <b>{name}</b>'s account and <b>all of their messages</b> and images, for everyone. Their devices are signed out right away.":
    'Isso exclui a conta de <b>{name}</b> e <b>todas as mensagens</b> e imagens dessa pessoa, para todo mundo. Os dispositivos dela são desconectados na hora.',
  "The name <b>{name}</b> becomes free, so anyone can join with it. This can't be undone.":
    'O nome <b>{name}</b> fica livre, então qualquer pessoa pode entrar com ele. Não dá para desfazer.',

  // ---- ProfileBanner (built-in banner styles) ----
  Solid: 'Sólido',
  Flow: 'Fluxo',
  Aurora: 'Aurora',
  Waves: 'Ondas',
  Dots: 'Pontos',
  Swirl: 'Espiral',

  // ---- ProfileCard ----
  'Open a text channel to mention someone': 'Abra um canal de texto para mencionar alguém',
  'Profile of {name}': 'Perfil de {name}',
  Offline: 'Offline',
  Playing: 'Jogando',
  'In voice': 'Em um canal de voz',
  Deafened: 'Áudio desativado',
  Muted: 'Microfone desativado',
  'Go to channel': 'Ir para o canal',
  Join: 'Entrar',
  'Set status': 'Definir status',
  'Edit profile': 'Editar perfil',
  'Mention {name} in this channel': 'Mencionar {name} neste canal',
  Mention: 'Mencionar',
  'Get their attention': 'Chamar a atenção dessa pessoa',
  'Waking up…': 'Acordando…',
  'Wake up': 'Acordar',

  // ---- StatusMenu ----
  'Shows you as away. Nexo also does this by itself after 10 minutes without input.':
    'Mostra que você está ausente. O Nexo também faz isso sozinho depois de 10 minutos sem você mexer no teclado ou no mouse.',
  "You won't get notification popups or sounds. Wake-ups still ring.":
    'Você não recebe pop-ups nem sons de notificação, mas ainda toca quando alguém te acordar.',
  Status: 'Status',
  'Edit custom status': 'Editar status personalizado',
  'Set a custom status': 'Definir um status personalizado',
  'Clear custom status': 'Limpar status personalizado',
  "What's up?": 'Qual é a boa?',
  'Custom status': 'Status personalizado',
  Clear: 'Limpar',
  Save: 'Salvar',
  'Set your status': 'Definir seu status',
  'Shown under your name in the member list and on your profile card.':
    'Aparece embaixo do seu nome na lista de membros e no seu cartão de perfil.',

  // ---- store/presence (status names) ----
  Online: 'Online',
  Idle: 'Ausente',
  'Do not disturb': 'Não perturbe',

  // ---- lib/activity ----
  'just started': 'começou agora',
  'for {minutes}m': 'há {minutes} min',
  'for {hours}h {minutes}m': 'há {hours}h {minutes}min',
  'for {days}d {hours}h': 'há {days}d {hours}h',
  'Playing {game}': 'Jogando {game}',

  // ---- lib/gifAvatar, lib/gifFit (animated pictures and banners) ----
  "Couldn't read that animation": 'Não foi possível ler essa animação',
  "Couldn't process that animation": 'Não foi possível processar essa animação',
  'shortened to {seconds} seconds': 'encurtada para {seconds} segundos',
  'lower frame rate': 'menos quadros por segundo',
  'fewer colours': 'menos cores',
  'Preparing the animation stopped responding. Try again, or pick a shorter or smaller animation.':
    'A preparação da animação parou de responder. Tente de novo ou escolha uma animação mais curta ou menor.',
  'An animation needs at least two frames': 'Uma animação precisa de pelo menos dois quadros',
  'This animation is too detailed to fit {size}, even simplified. Try a shorter or simpler one.':
    'Essa animação tem detalhes demais para caber em {size}, mesmo simplificada. Tente uma mais curta ou mais simples.',

  // ---- lib/imageCrop, lib/imageEncode ----
  'Pick a PNG, JPEG, WebP or GIF image': 'Escolha uma imagem PNG, JPEG, WebP ou GIF',
  'That image is too large (max 25 MB)': 'Essa imagem é grande demais (máx. 25 MB)',
  "Couldn't read that image": 'Não foi possível ler essa imagem',
  'That image has too many pixels': 'Essa imagem tem pixels demais',
  "Couldn't make that image small enough to upload": 'Não foi possível deixar essa imagem pequena o bastante para enviar',
  "Couldn't process that image": 'Não foi possível processar essa imagem',
  "Couldn't make that image smaller than {size} MB": 'Não foi possível deixar essa imagem com menos de {size} MB',
  'That file is empty': 'Esse arquivo está vazio',
  'That image is too large': 'Essa imagem é grande demais',
  'Only PNG, JPEG, WebP and GIF images can be sent': 'Só dá para enviar imagens PNG, JPEG, WebP e GIF',
  'GIFs are limited to {size} MB': 'GIFs têm limite de {size} MB',
  'Animated images are limited to {size} MB': 'Imagens animadas têm limite de {size} MB',

  // ---- lib/presenceSync ----
  "This server doesn't support custom status yet": 'Este servidor ainda não aceita status personalizado',

  // ---- net/avatar, net/banner ----
  'Not connected to a server': 'Sem conexão com um servidor',
  "This device isn't signed in to the server": 'Este dispositivo não entrou no servidor',
  'The server took too long to respond': 'O servidor demorou demais para responder',
  "Can't reach the server at {url}": 'Não deu para acessar o servidor em {url}',
  'The server rejected the request (HTTP {status})': 'O servidor recusou a solicitação (HTTP {status})',
  'Invalid response from the server': 'Resposta inválida do servidor',
  'Animated profile pictures are limited to {size} MB': 'Fotos de perfil animadas têm limite de {size} MB',
  'Profile pictures are limited to {size} KB': 'Fotos de perfil têm limite de {size} KB',
  "This server doesn't support profile pictures yet (update the Nexo server)":
    'Este servidor ainda não aceita fotos de perfil (atualize o servidor do Nexo)',
  "This server doesn't support banners yet (update the Nexo server)": 'Este servidor ainda não aceita banners (atualize o servidor do Nexo)',
  'Animated banners are limited to {size} MB': 'Banners animados têm limite de {size} MB',
  'Banners are limited to {size} MB': 'Banners têm limite de {size} MB',
} satisfies Dict
