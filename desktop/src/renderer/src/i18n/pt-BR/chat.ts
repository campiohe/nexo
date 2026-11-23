// Brazilian Portuguese for the "chat" area (the file list is in i18n/README.md and scripts/i18n-check.mjs).
// Keys are the English text exactly as written in t() / msg(); glossary and rules: ../README.md.
// Not translated on purpose: the search filter keywords (from:, in:), @everyone, emoji names and :shortcodes:.
import type { Dict } from '../core'

export default {
  // ---- Composer ----
  'Only images (PNG, JPEG, WebP, GIF) can be attached': 'Só dá para anexar imagens (PNG, JPEG, WebP, GIF)',
  'Not connected. Your message is still in the box.': 'Sem conexão. Sua mensagem continua na caixa.',
  'An image failed to upload. Retry or remove it, then send again.':
    'Uma imagem não foi enviada. Tente de novo ou remova ela e envie outra vez.',
  Members: 'Membros',
  'Emoji matching <q>:{query}</q>': 'Emojis que combinam com <q>:{query}</q>',
  'Mention someone': 'Mencionar alguém',
  'Insert an emoji': 'Inserir um emoji',
  'Replying to <b>{name}</b>': 'Respondendo a <b>{name}</b>',
  'Cancel reply': 'Cancelar resposta',
  'Cancel reply (Esc)': 'Cancelar resposta (Esc)',
  'Images to send': 'Imagens para enviar',
  'Attach images': 'Anexar imagens',
  'Up to {count} images per message': 'Até {count} imagens por mensagem',
  'Attach images (or paste / drop them)': 'Anexar imagens (ou cole / arraste elas aqui)',
  'Reply in #{channel}': 'Responder em #{channel}',
  'Message #{channel}': 'Conversar em #{channel}',
  Emoji: 'Emoji',
  'Emoji (or type :name)': 'Emoji (ou digite :nome)',
  '{count} characters max': 'Máximo de {count} caracteres',
  'Send message': 'Enviar mensagem',
  'Sending when the images finish uploading…': 'Enviando assim que as imagens terminarem de subir…',
  'An image failed to upload: retry or remove it': 'Uma imagem não foi enviada: tente de novo ou remova ela',
  'Send (Enter) · New line (Shift+Enter)': 'Enviar (Enter) · Nova linha (Shift+Enter)',
  'offline // mention suggestion': 'offline',
  'Notify everyone': 'Notificar todo mundo',
  'Uploading {name}': 'Enviando {name}',
  'Retry uploading {name}': 'Tentar enviar {name} de novo',
  'Retry: {error}': 'Tentar de novo: {error}',
  'Remove {name}': 'Remover {name}',
  Remove: 'Remover',

  // ---- TextChannel ----
  'Drop images to send': 'Solte as imagens para enviar',
  'to #{channel} · up to {count} per message': 'em #{channel} · até {count} por mensagem',

  // ---- TypingLine ----
  Someone: 'Alguém',
  '{name} is typing…': '{name} está digitando…',
  '{a} and {b} are typing…': '{a} e {b} estão digitando…',
  '{a}, {b} and {c} are typing…': '{a}, {b} e {c} estão digitando…',
  'Several people are typing…': 'Várias pessoas estão digitando…',

  // ---- MessageList ----
  '({count, plural, one {# image} other {# images}})': '({count, plural, one {# imagem} other {# imagens}})',
  '(+ {count, plural, one {# image} other {# images}})': '(+ {count, plural, one {# imagem} other {# imagens}})',
  'That message no longer exists': 'Essa mensagem não existe mais',
  'Original message is further up': 'A mensagem original está mais para cima',
  'That message is too far back to jump to': 'Essa mensagem é antiga demais para pular até ela',
  'Messages in #{channel}': 'Mensagens em #{channel}',
  'The start of #{channel}.': 'O começo de #{channel}.',
  'Loading older messages…': 'Carregando mensagens antigas…',
  'Loading messages…': 'Carregando mensagens…',
  'a deleted user': 'um usuário excluído',
  '{count, plural, one {New message} other {# new messages}}': '{count, plural, one {Nova mensagem} other {# novas mensagens}}',
  'Add a reaction': 'Adicionar uma reação',
  'Delete message?': 'Excluir mensagem?',
  "Delete {name}'s message?": 'Excluir a mensagem de {name}?',
  "Delete this user's message?": 'Excluir a mensagem deste usuário?',
  'Tip: hold Shift while clicking delete to skip this.': 'Dica: segure Shift ao clicar em excluir para pular esta confirmação.',
  Delete: 'Excluir',
  'Original message was deleted': 'A mensagem original foi excluída',
  'Deleted user': 'Usuário excluído',
  'Go to the original message': 'Ir para a mensagem original',
  'Replying to {name}: {text}. Go to the original message': 'Respondendo a {name}: {text}. Ir para a mensagem original',
  image: 'imagem',
  '[image]': '[imagem]',
  'Pinned by {name} · {when}': 'Fixada por {name} · {when}',
  'Profile of {name}': 'Perfil de {name}',
  'Unknown user': 'Usuário desconhecido',
  'Edited {when}': 'Editada em {when}',
  '(edited)': '(editada)',

  // ---- MessageActions ----
  'Message actions': 'Ações da mensagem',
  'React with {name}': 'Reagir com {name}',
  'Add reaction': 'Adicionar reação',
  Reply: 'Responder',
  'Pin message': 'Fixar mensagem',
  'Unpin message': 'Desafixar mensagem',
  Edit: 'Editar',
  'Edit message': 'Editar mensagem',
  'Delete message (Shift+click to skip confirmation)': 'Excluir mensagem (Shift+clique para pular a confirmação)',
  'Delete message': 'Excluir mensagem',

  // ---- MessageEditor ----
  'escape to <cancel>cancel</cancel> • enter to <save>save</save>':
    'esc para <cancel>cancelar</cancel> • enter para <save>salvar</save>',

  // ---- MessageContent ----
  'Notifies everyone': 'Notifica todo mundo',
  'Spoiler, press to reveal': 'Spoiler, pressione para revelar',
  'Spoiler: click to reveal': 'Spoiler: clique para revelar',
  "Couldn't copy to the clipboard": 'Não deu para copiar para a área de transferência',
  '{lang} code': 'Código {lang}',
  Code: 'Código',
  'Copy code': 'Copiar código',
  Copied: 'Copiado',
  Copy: 'Copiar',
  'unknown-user': 'usuário-desconhecido',
  'Open image ({width}×{height})': 'Abrir imagem ({width}×{height})',
  "This image couldn't be loaded": 'Não deu para carregar esta imagem',
  'Click to enlarge': 'Clique para ampliar',
  'Image unavailable': 'Imagem indisponível',

  // ---- Reactions ----
  You: 'Você',
  '{names} and {count} more': '{names} e mais {count}',
  '{count, plural, one {{names} reacted with {emoji}} other {{names} reacted with {emoji}}}':
    '{count, plural, one {{names} reagiu com {emoji}} other {{names} reagiram com {emoji}}}',
  '{label}. Click to remove your reaction': '{label}. Clique para remover sua reação',
  '{label}. Click to react': '{label}. Clique para reagir',

  // ---- EmojiPicker (lib/emoji.ts skin tones, lib/emojiData.ts categories) ----
  'Search results': 'Resultados da busca',
  Recent: 'Recentes',
  'Choose an emoji': 'Escolha um emoji',
  'Search emoji': 'Buscar emoji',
  'Skin tone: {tone}': 'Tom de pele: {tone}',
  'Skin tone': 'Tom de pele',
  'Emoji categories': 'Categorias de emoji',
  'Shift+click to pick several': 'Shift+clique para escolher vários',
  'No emoji found': 'Nenhum emoji encontrado',
  'Default // skin tone': 'Padrão',
  'Light // skin tone': 'Claro',
  'Medium-light // skin tone': 'Médio-claro',
  'Medium // skin tone': 'Médio',
  'Medium-dark // skin tone': 'Médio-escuro',
  'Dark // skin tone': 'Escuro',
  'Smileys & Emotion': 'Smileys e emoções',
  'People & Body': 'Pessoas e corpo',
  'Animals & Nature': 'Animais e natureza',
  'Food & Drink': 'Comidas e bebidas',
  Activities: 'Atividades',
  'Travel & Places': 'Viagens e lugares',
  Objects: 'Objetos',
  Symbols: 'Símbolos',
  Flags: 'Bandeiras',

  // ---- EmbedCard ----
  'Open in browser: {url}': 'Abrir no navegador: {url}',
  'Play {title} in the browser': 'Reproduzir {title} no navegador',
  'Open {title} in the browser': 'Abrir {title} no navegador',

  // ---- ImageLightbox ----
  Close: 'Fechar',
  'Open original': 'Abrir original',

  // ---- PanelMessage ----
  'Message from {name}, {when}': 'Mensagem de {name}, {when}',
  'deleted-channel': 'canal-excluído',
  '{count, plural, one {# image} other {# images}}': '{count, plural, one {# imagem} other {# imagens}}',
  Jump: 'Pular',

  // ---- PinsPanel ----
  'Pinned messages': 'Mensagens fixadas',
  'Close pinned messages': 'Fechar mensagens fixadas',
  'Close (Esc)': 'Fechar (Esc)',
  'Pins live in text channels.': 'Mensagens fixadas ficam nos canais de texto.',
  'Loading pins…': 'Carregando mensagens fixadas…',
  "This channel doesn't have any pinned messages yet.": 'Este canal ainda não tem nenhuma mensagem fixada.',
  'Hover a message and use the pin button to keep it here.':
    'Passe o mouse em uma mensagem e use o botão de fixar para guardar ela aqui.',
  'Pinned by {name}': 'Fixada por {name}',
  Unpin: 'Desafixar',

  // ---- SearchBox (store/chatPanels.ts too) ----
  'user // search filter': 'usuário',
  'channel // search filter': 'canal',
  'No member named "{name}"': 'Nenhum membro chamado "{name}"',
  'Type a name after from:': 'Digite um nome depois de from:',
  'No text channel named #{channel}': 'Nenhum canal de texto chamado #{channel}',
  'Type a channel after in:': 'Digite um canal depois de in:',
  'Add some words or a from: filter to search': 'Adicione algumas palavras ou um filtro from: para buscar',
  'Type something to search for': 'Digite algo para buscar',
  'Search is limited to {count} characters': 'A busca é limitada a {count} caracteres',
  Search: 'Buscar',
  'Search messages': 'Buscar mensagens',
  'Clear search': 'Limpar busca',
  'From user': 'Do usuário',
  'In channel': 'No canal',
  'Search options': 'Opções de busca',
  'Search suggestions': 'Sugestões de busca',

  // ---- SearchPanel ----
  '{count}+ results': '{count}+ resultados',
  '{count, plural, one {# result} other {# results}}':
    '{count, plural, =0 {Nenhum resultado} one {# resultado} other {# resultados}}',
  'Searching…': 'Buscando…',
  'Close search results': 'Fechar resultados da busca',
  'The in: filter already picks a channel': 'O filtro in: já escolhe um canal',
  'Only search the channel you are viewing': 'Buscar só no canal que você está vendo',
  'This channel only': 'Só neste canal',
  'No messages found.': 'Nenhuma mensagem encontrada.',
  'Try other words, or fewer filters.': 'Tente outras palavras ou menos filtros.',
  'Load more': 'Carregar mais',

  // ---- net/attachments.ts ----
  "This server doesn't support images yet. Ask the host to update.":
    'Este servidor ainda não aceita imagens. Peça para quem hospeda atualizar.',
  'Not connected to a server': 'Sem conexão com um servidor',
  "This device isn't signed in to the server": 'Este dispositivo não entrou no servidor',
  'The upload took too long': 'O envio demorou demais',
  "Can't reach the server at {url}": 'Não deu para acessar o servidor em {url}',
  'The server rejected the image (HTTP {status})': 'O servidor recusou a imagem (HTTP {status})',
  'Invalid response from the server': 'Resposta inválida do servidor',
  "Couldn't upload {name}: {error}": 'Não deu para enviar {name}: {error}',
  "Couldn't upload the image: {error}": 'Não deu para enviar a imagem: {error}',
  'You can attach up to {count} images per message': 'Você pode anexar até {count} imagens por mensagem',
} satisfies Dict
