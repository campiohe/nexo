// Brazilian Portuguese for the "shell" area (the file list is in i18n/README.md and scripts/i18n-check.mjs).
// Keys are the English text exactly as written in t() / msg(); glossary and rules: ../README.md.
import type { Dict } from '../core'

export default {
  // ---- TitleBar ----
  'Jump to a channel': 'Ir para um canal',

  // ---- MainLayout ----
  'Pinned messages': 'Mensagens fixadas',
  'Toggle member list': 'Mostrar/ocultar lista de membros',
  'Hide members': 'Ocultar membros',
  'Show members': 'Mostrar membros',
  'Connection problem. Retrying…': 'Problema na conexão. Tentando de novo…',
  'Reconnecting…': 'Reconectando…',
  'No channel selected': 'Nenhum canal selecionado',
  'Create a channel with the + button in the sidebar.': 'Crie um canal com o botão + na barra lateral.',
  'There are no channels yet. Ask an admin to create one.': 'Ainda não tem nenhum canal. Peça para um admin criar um.',

  // ---- Sidebar ----
  Channels: 'Canais',
  'Text channels': 'Canais de texto',
  'Voice channels': 'Canais de voz',
  'Create text channel': 'Criar canal de texto',
  'Create voice channel': 'Criar canal de voz',
  'new-channel': 'novo-canal',
  'New voice channel': 'Novo canal de voz',
  Create: 'Criar',
  'No text channels yet': 'Nenhum canal de texto ainda',
  'No voice channels yet': 'Nenhum canal de voz ainda',
  Save: 'Salvar',
  ', unread messages': ', mensagens não lidas',
  'You were mentioned': 'Mencionaram você',
  '1 unread mention': '1 menção não lida',
  '{count} unread mentions': '{count} menções não lidas',
  ', mentioned': ', mencionaram você',
  'Rename {name}': 'Renomear {name}',
  Rename: 'Renomear',
  'Delete {name}': 'Excluir {name}',
  Delete: 'Excluir',
  'Delete {channel}?': 'Excluir {channel}?',
  "This deletes the channel and <b>all of its messages</b> for everyone. This can't be undone.":
    'Isso exclui o canal e <b>todas as mensagens dele</b> para todo mundo. Não dá para desfazer.',
  "Everyone in this voice channel will be disconnected. This can't be undone.":
    'Todo mundo neste canal de voz vai ser desconectado. Não dá para desfazer.',
  'Delete channel': 'Excluir canal',
  'Channel name': 'Nome do canal',
  Unknown: 'Desconhecido',
  'Click for your profile': 'Clique para ver seu perfil',
  'Click for your profile; right-click or drag to move to another channel':
    'Clique para ver seu perfil; clique com o botão direito ou arraste para mudar de canal',
  'Click for profile; right-click for volume and actions; drag to move':
    'Clique para ver o perfil; botão direito para volume e ações; arraste para mover',
  'Click for profile; right-click for volume and actions': 'Clique para ver o perfil; botão direito para volume e ações',
  ', speaking': ', falando',
  'Wake up {name}': 'Acordar {name}',
  'Wake up': 'Acordar',
  '{count} watching: {names}': '{count} assistindo: {names}',
  Someone: 'Alguém',
  Streaming: 'Transmitindo',
  LIVE: 'AO VIVO',
  'Camera on': 'Câmera ligada',
  Deafened: 'Áudio desativado',
  Muted: 'Microfone desativado',
  'Connecting…': 'Conectando…',
  Offline: 'Offline',
  'Set your status': 'Definir seu status',
  Settings: 'Configurações',

  // ---- QuickSwitcher ----
  'Search channels…': 'Buscar canais…',
  'Search channels': 'Buscar canais',
  Text: 'Texto',
  'Voice — joins': 'Voz (entra no canal)',
  'No channels match “{query}”.': 'Nenhum canal corresponde a “{query}”.',
  'Unread messages': 'Mensagens não lidas',

  // ---- Toasts ----
  Notifications: 'Notificações',
  Dismiss: 'Dispensar',

  // ---- UpdateBanner ----
  'Nexo {version} is ready': 'Nexo {version} está pronto',
  'A new version of Nexo is ready': 'Uma nova versão do Nexo está pronta',
  'Nexo restarts to install the update, which leaves the voice call':
    'O Nexo reinicia para instalar a atualização, e isso te tira da chamada',
  'Restart (leaves the call)': 'Reiniciar (sai da chamada)',
  'Restart to update': 'Reiniciar para atualizar',
  'Nexo {version} is available': 'Nexo {version} está disponível',
  'A new version of Nexo is available': 'Uma nova versão do Nexo está disponível',
  Download: 'Baixar',
  'Downloading Nexo {version}… {percent}%': 'Baixando o Nexo {version}… {percent}%',
  'Downloading a new version of Nexo… {percent}%': 'Baixando uma nova versão do Nexo… {percent}%',
  'Update download': 'Download da atualização',
  'Dismiss (the update still installs when you quit Nexo)': 'Dispensar (a atualização ainda é instalada quando você fechar o Nexo)',

  // ---- Splash ----
  "Can't connect": 'Não foi possível conectar',
  'The connection failed.': 'A conexão falhou.',
  'Still retrying in the background…': 'Ainda tentando em segundo plano…',
  'Retry now': 'Tentar agora',
  'Change server': 'Trocar de servidor',
  'Connecting to {server}…': 'Conectando a {server}…',

  // ---- Modal ----
  Close: 'Fechar',
  'Close (Esc)': 'Fechar (Esc)',
  Cancel: 'Cancelar',
  Confirm: 'Confirmar',

  // ---- notifications (lib/notify.ts) ----
  '{count, plural, one {[image]} other {[# images]}}': '{count, plural, one {[imagem]} other {[# imagens]}}',
  '{name} in {channel}': '{name} em {channel}',
  '{count, plural, one {# mention in {channel}} other {# mentions in {channel}}}':
    '{count, plural, one {# menção em {channel}} other {# menções em {channel}}}',
  '{count, plural, one {# new message in {channel}} other {# new messages in {channel}}}':
    '{count, plural, one {# mensagem nova em {channel}} other {# mensagens novas em {channel}}}',
  '{count, plural, one {# unread mention} other {# unread mentions}}':
    '{count, plural, one {# menção não lida} other {# menções não lidas}}',
  '{count, plural, one {At least # unread mention} other {At least # unread mentions}}':
    '{count, plural, one {Pelo menos # menção não lida} other {Pelo menos # menções não lidas}}',
} satisfies Dict
