// Brazilian Portuguese for the "accounts" area (the file list is in i18n/README.md and scripts/i18n-check.mjs).
// Keys are the English text exactly as written in t() / msg(); glossary and rules: ../README.md.
import type { Dict } from '../core'

export default {
  // ---- Onboarding ----
  'Enter a valid server address, like {example}': 'Digite um endereço de servidor válido, como {example}',
  'Names must be 2–24 letters, numbers, spaces, . _ or -': 'O nome precisa ter de 2 a 24 letras, números, espaços, . _ ou -',
  'Join a server': 'Entre em um servidor',
  'Ask whoever runs it for the address.': 'Peça o endereço para quem cuida dele.',
  'Server address': 'Endereço do servidor',
  'Your name': 'Seu nome',
  'e.g. Ana': 'ex.: Ana',
  Color: 'Cor',
  'Server password': 'Senha do servidor',
  'The server has a password': 'O servidor tem senha',
  'Is <b>{name}</b> you, on another device?': '<b>{name}</b> é você, em outro dispositivo?',
  'Sending…': 'Enviando…',
  'This is my account': 'Essa conta é minha',
  'Connecting…': 'Conectando…',
  Join: 'Entrar',

  // ---- SignInSteps ----
  'Welcome back': 'Que bom te ver de novo',
  'This device is linked to these accounts on {server}.': 'Este dispositivo está vinculado a estas contas em {server}.',
  'This device is linked to this account on {server}.': 'Este dispositivo está vinculado a esta conta em {server}.',
  'Signing in…': 'Entrando…',
  Continue: 'Continuar',
  'Not you? Create a new account': 'Não é você? Crie uma conta nova',
  'Sign-in request sent': 'Pedido de acesso enviado',
  'Waiting for an admin to approve…': 'Esperando um admin aprovar…',
  "Ask an admin to approve <b>{name}</b>, or approve it yourself from a device where you're signed in. It expires in about {minutes, plural, one {# minute} other {# minutes}}.":
    'Peça para um admin aprovar <b>{name}</b> ou aprove por conta própria em um dispositivo em que você já entrou. O pedido expira em cerca de {minutes, plural, one {# minuto} other {# minutos}}.',
  'Cancel request': 'Cancelar pedido',

  // ---- AccessRequestBanners ----
  'Sign-in requests': 'Pedidos de acesso',
  'Requested {time}': 'Pedido feito em {time}',
  'Someone wants to sign in to your account on a new device ({address})':
    'Alguém quer entrar na sua conta em um dispositivo novo ({address})',
  'Someone wants to sign in to your account on a new device': 'Alguém quer entrar na sua conta em um dispositivo novo',
  '<b>{name}</b> wants to sign in on a new device ({address})': '<b>{name}</b> quer entrar em um dispositivo novo ({address})',
  '<b>{name}</b> wants to sign in on a new device': '<b>{name}</b> quer entrar em um dispositivo novo',
  '<b>Someone</b> wants to sign in on a new device ({address})': '<b>Alguém</b> quer entrar em um dispositivo novo ({address})',
  '<b>Someone</b> wants to sign in on a new device': '<b>Alguém</b> quer entrar em um dispositivo novo',
  'Approving…': 'Aprovando…',
  Approve: 'Aprovar',
  'Denying…': 'Recusando…',
  Deny: 'Recusar',

  // ---- lib/permissions (role names) ----
  Owner: 'Dono',
  Admin: 'Admin',
  Member: 'Membro',

  // ---- net/accounts, net/socket (connection and request errors) ----
  'The server took too long to respond': 'O servidor demorou demais para responder',
  "Can't reach the server at {url}": 'Não deu para acessar o servidor em {url}',
  "Couldn't send the sign-in request. The server at {url} may be offline, or too old for sign-in requests (update the Nexo server).":
    'Não foi possível enviar o pedido de acesso. O servidor em {url} pode estar offline ou ser antigo demais para pedidos de acesso (atualize o servidor do Nexo).',
  "This server doesn't support sign-in requests yet (update the Nexo server)":
    'Este servidor ainda não aceita pedidos de acesso (atualize o servidor do Nexo)',
  'The server rejected the request (HTTP {status})': 'O servidor recusou a solicitação (HTTP {status})',
  'Invalid response from the server': 'Resposta inválida do servidor',
  'Not connected to the server': 'Sem conexão com o servidor',
  'Request failed': 'A solicitação falhou',
  'Connection failed': 'Falha na conexão',
  "Can't reach the server at {url}. Check the address and that the server is running.":
    'Não deu para acessar o servidor em {url}. Confira o endereço e se o servidor está rodando.',
  "This server doesn't recognize this device anymore.": 'Este servidor não reconhece mais este dispositivo.',
  "This device isn't linked to that account anymore.": 'Este dispositivo não está mais vinculado a essa conta.',
  "This server doesn't recognize this device anymore (its data may have been reset). Pick a name to join again.":
    'Este servidor não reconhece mais este dispositivo (os dados dele podem ter sido apagados). Escolha um nome para entrar de novo.',

  // ---- store/app (message checks before sending) ----
  'Message is empty': 'A mensagem está vazia',
  'Messages are limited to {max} characters': 'As mensagens têm limite de {max} caracteres',
  'Messages can have at most {max} different reactions': 'Uma mensagem pode ter no máximo {max} reações diferentes',

  // ---- store/signin (onboarding notices, saved login) ----
  "Nexo couldn't read the login saved on this device for this server. If you already have an account there, don't create a new one: pick it below, or enter your name and choose “This is my account”.":
    'O Nexo não conseguiu ler o login salvo neste dispositivo para este servidor. Se você já tem uma conta lá, não crie outra: escolha a sua abaixo ou digite seu nome e clique em “Essa conta é minha”.',
  "This device isn't linked to that account anymore. Enter your name and choose “This is my account” to ask an admin to let you in.":
    'Este dispositivo não está mais vinculado a essa conta. Digite seu nome e clique em “Essa conta é minha” para pedir a um admin que libere seu acesso.',
  'Your sign-in request was denied.': 'Seu pedido de acesso foi recusado.',
  'Your sign-in request expired or was cancelled. You can send a new one.':
    'Seu pedido de acesso expirou ou foi cancelado. Você pode enviar outro.',
  "Nexo couldn't save your login on this device. You're signed in for now; if Nexo doesn't remember you next time, use “This is my account” instead of making a new account.":
    'O Nexo não conseguiu salvar seu login neste dispositivo. Sua sessão continua ativa por enquanto; se o Nexo não lembrar de você na próxima vez, use “Essa conta é minha” em vez de criar uma conta nova.',
} satisfies Dict
