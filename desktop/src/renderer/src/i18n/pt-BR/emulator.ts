// Brazilian Portuguese for the "emulator" area (the file list is in i18n/README.md and scripts/i18n-check.mjs).
// Keys are the English text exactly as written in t() / msg(); glossary and rules: ../README.md.
// Terms: gamepad / controller (a player's port) → controle; controls (the button mapping) → comandos; d-pad →
// direcional; stick → analógico; host → host; quick save / load → salvar / carregar rápido.
import type { Dict } from '../core'

export default {
  // ---- EmulatorArea ----
  Emulator: 'Emulador',
  'Paused // game': 'Pausado',
  Live: 'Ao vivo',
  'hosted by you': 'hospedado por você',
  'hosted by {name}': 'hospedado por {name}',
  someone: 'alguém',
  'Load another game (any console)': 'Carregar outro jogo (qualquer console)',
  'Loading…': 'Carregando…',
  'Load another game': 'Carregar outro jogo',
  'End the game for everyone': 'Encerrar o jogo para todo mundo',
  Stop: 'Parar',
  'Show people instead': 'Mostrar as pessoas no lugar',
  Hide: 'Ocultar',
  "Your game isn't running on this device. Load the game file again, or stop the session.":
    'Seu jogo não está rodando neste dispositivo. Carregue o arquivo do jogo de novo ou encerre a sessão.',
  'Load a game file': 'Carregar um arquivo de jogo',
  Resume: 'Continuar',
  'Paused by the host': 'Pausado pelo host',
  'Drop to load this game': 'Solte para carregar este jogo',
  Controllers: 'Controles',
  "You're <b>player {number}</b>.": 'Você joga como <b>player {number}</b>.',
  'Your keys go straight to the game.': 'Suas teclas vão direto para o jogo.',
  "Your keys go to {name}'s game while this view is open.":
    'Suas teclas vão para o jogo de {name} enquanto esta tela estiver aberta.',
  "Your keys go to the host's game while this view is open.":
    'Suas teclas vão para o jogo do host enquanto esta tela estiver aberta.',
  'Take a free controller to play. Everyone else watches.': 'Pegue um controle livre para jogar. O resto do pessoal assiste.',
  'Hide controls': 'Ocultar comandos',
  'Show controls': 'Mostrar comandos',
  'You play without delay. Friends see your stream, so their presses reach the game after a short round trip (about 0.1–0.2 s on a good connection).':
    'Você joga sem atraso. Seus amigos veem sua transmissão, então os comandos deles chegam ao jogo depois de uma ida e volta rápida (uns 0,1–0,2 s numa conexão boa).',
  "You see {name}'s stream, so a press takes a round trip to their computer and back: about 0.1–0.2 s on a good connection. Fine for most games, noticeable in fast action games.":
    'Você vê a transmissão de {name}, então cada comando faz uma ida e volta até o computador dessa pessoa: uns 0,1–0,2 s numa conexão boa. Tranquilo na maioria dos jogos, dá pra notar em jogos de ação rápidos.',
  "You see the host's stream, so a press takes a round trip to their computer and back: about 0.1–0.2 s on a good connection. Fine for most games, noticeable in fast action games.":
    'Você vê a transmissão do host, então cada comando faz uma ida e volta até o computador do host: uns 0,1–0,2 s numa conexão boa. Tranquilo na maioria dos jogos, dá pra notar em jogos de ação rápidos.',
  "Loading {name}'s stream…": 'Carregando a transmissão de {name}…',
  "Loading the host's stream…": 'Carregando a transmissão do host…',
  "Waiting for {name}'s stream…": 'Esperando a transmissão de {name}…',
  "Waiting for the host's stream…": 'Esperando a transmissão do host…',
  Pause: 'Pausar',
  "The console's reset button": 'O botão de reset do console',
  'Reset // console button': 'Resetar',
  'Remember this moment (until you load another game)': 'Guarda este momento (até você carregar outro jogo)',
  'Quick save': 'Salvar rápido',
  'Go back to the quick save': 'Volta para o salvamento rápido',
  'Quick load': 'Carregar rápido',
  'Your game is your stream in this call': 'Seu jogo é a sua transmissão nesta chamada',
  LIVE: 'AO VIVO',
  Streaming: 'Transmitindo',
  'Starting the stream…': 'Iniciando a transmissão…',
  'Not streaming': 'Sem transmissão',
  'Stream it': 'Transmitir',
  'Game volume (only for you)': 'Volume do jogo (só para você)',
  "You're deafened: no game sound.": 'Seu áudio está desativado: sem som do jogo.',
  'Game sound comes with the stream.': 'O som do jogo vem junto com a transmissão.',
  'Game volume': 'Volume do jogo',
  '{label}: {percent}%': '{label}: {percent}%',
  Volume: 'Volume',
  Someone: 'Alguém',
  '(you)': '(você)',
  host: 'host',
  'Free // controller': 'Livre',
  'Give up this controller (watch instead)': 'Largar este controle (e só assistir)',
  'Leave // controller': 'Largar',
  'Move // controller': 'Trocar',
  'Take // controller': 'Pegar',
  'Assign controller {number}': 'Escolher quem usa o controle {number}',
  'Assign this controller': 'Escolher quem usa este controle',
  'Controller {number}': 'Controle {number}',
  'Nobody else is in the call.': 'Não tem mais ninguém na chamada.',
  'Free this controller': 'Liberar este controle',
  'left stick click': 'clique do analógico esquerdo',
  'right stick click': 'clique do analógico direito',
  'd-pad': 'direcional',
  Arrows: 'Setas',
  'left stick': 'analógico esquerdo',
  'right stick': 'analógico direito',
  "This console's controls aren't known to this version of Nexo.":
    'Esta versão do Nexo não conhece os comandos deste console.',
  '{console}: console button · gamepad · keyboard': '{console}: botão do console · controle · teclado',
  'Gamepad buttons go by position, like on an Xbox pad: A bottom, B right, X left, Y top.':
    'Os botões do controle valem pela posição, como num controle de Xbox: A embaixo, B na direita, X na esquerda, Y em cima.',
  'Gamepads work too (plug one in and press a button); the left stick works as the d-pad.':
    'Controles também funcionam (conecte um e aperte um botão); o analógico esquerdo funciona como direcional.',
  "A gamepad's sticks work as the console's: the right stick presses the C buttons. On a keyboard, the arrows / WASD move the control stick.":
    'Os analógicos do controle funcionam como os do console: o analógico direito aperta os botões C. No teclado, as setas / WASD movem o analógico.',
  "A gamepad's sticks work as the console's analog sticks. On a keyboard, the arrows / WASD are the d-pad: most games play fine with it, the few that need the analog sticks need a gamepad.":
    'Os analógicos do controle funcionam como os do console. No teclado, as setas / WASD são o direcional: a maioria dos jogos roda bem assim, e os poucos que precisam dos analógicos pedem um controle.',

  // ---- EmulatorEntry ----
  'Reading {name}…': 'Lendo {name}…',
  'Starting {name}…': 'Iniciando {name}…',
  Cancel: 'Cancelar',
  'Which console is this game for?': 'Esse jogo é de qual console?',
  "Nexo can't tell from <b>{file}</b> alone. Is it a {consoles} game?":
    'O Nexo não consegue saber só pelo <b>{file}</b>. É um jogo de {consoles}?',
  'PlayStation games usually come with a .cue file: pick it together with the .bin files.':
    'Jogos de PlayStation costumam vir com um arquivo .cue: escolha ele junto com os arquivos .bin.',
  'Hide the game (show people)': 'Ocultar o jogo (mostrar as pessoas)',
  'Show {title}': 'Mostrar {title}',
  'Loading the game…': 'Carregando o jogo…',
  'Play a game: load a SNES, Mega Drive, PlayStation or Nintendo 64 game file you own':
    'Jogar: carregue um arquivo de jogo de SNES, Mega Drive, PlayStation ou Nintendo 64 que você tenha',
  '{line} (paused)': '{line} (pausado)',

  // ---- host.ts ----
  'A game is already loading': 'Já tem um jogo carregando',
  'Join the voice channel to host a game': 'Entre no canal de voz para hospedar um jogo',
  'Someone is already hosting a game here': 'Alguém já está hospedando um jogo aqui',
  'The file changed while it was being read': 'O arquivo mudou enquanto estava sendo lido',
  "Couldn't start that game": 'Não deu pra iniciar esse jogo',
  'The game crashed and stopped. Load it again to keep playing.':
    'O jogo travou e parou. Carregue de novo para continuar jogando.',
  'Saved // emulator quick save': 'Jogo salvo',
  'The game was stopped': 'O jogo foi encerrado',

  // ---- emulator/engine.ts, zip.ts: picking and starting a game ----
  "This console isn't supported": 'Esse console não é suportado',
  "The {console} emulator couldn't start (it failed to load)": 'O emulador de {console} não iniciou (falhou ao carregar)',
  "This .zip file doesn't contain a {console} game": 'Esse arquivo .zip não tem nenhum jogo de {console}',
  'This disc image is too big for a PlayStation game': 'Essa imagem de disco é grande demais para um jogo de PlayStation',
  'This file is too big to be a {console} game': 'Esse arquivo é grande demais para ser um jogo de {console}',
  'Pick one game at a time': 'Escolha um jogo por vez',
  'Pick the .cue together with its .bin files': 'Escolha o .cue junto com os arquivos .bin dele',
  'Unzip PlayStation games first, then pick the .cue together with its .bin files':
    'Descompacte os jogos de PlayStation primeiro e depois escolha o .cue junto com os arquivos .bin dele',
  'Pick a game file': 'Escolha um arquivo de jogo',
  '"{name}" isn\'t a game file the emulator reads ({extensions})':
    '"{name}" não é um arquivo de jogo que o emulador lê ({extensions})',
  '"{name}" is empty': '"{name}" está vazio',
  'Pick the .zip file alone': 'Escolha só o arquivo .zip',
  "This .cue file isn't a disc's track list": 'Esse arquivo .cue não é uma lista de faixas de disco',
  "This .cue file couldn't be read": 'Não deu pra ler esse arquivo .cue',
  "This .cue file doesn't list any track files": 'Esse arquivo .cue não lista nenhum arquivo de faixa',
  'Pick the .cue together with its .bin files (missing: {files})':
    'Escolha o .cue junto com os arquivos .bin dele (faltando: {files})',
  'This .zip file is damaged or uses an unsupported format': 'Esse arquivo .zip está corrompido ou usa um formato não suportado',
  "This .zip file doesn't contain a game the emulator reads": 'Esse arquivo .zip não tem nenhum jogo que o emulador lê',
  "The file couldn't be read": 'Não deu pra ler o arquivo',
  'This looks like a PlayStation BIOS file: pick it together with the game files':
    'Isso parece uma BIOS de PlayStation: escolha ela junto com os arquivos do jogo',
  'This .zip file is password-protected': 'Esse arquivo .zip é protegido por senha',

  // ---- emulator/engine.ts ENGINE_MESSAGES: what the engines reject with (shown through tKnown) ----
  "This .zip file doesn't contain a SNES game": 'Esse arquivo .zip não tem nenhum jogo de SNES',
  "This .zip file doesn't contain a Mega Drive game": 'Esse arquivo .zip não tem nenhum jogo de Mega Drive',
  "This .zip file doesn't contain a Nintendo 64 game": 'Esse arquivo .zip não tem nenhum jogo de Nintendo 64',
  'This file is empty': 'Esse arquivo está vazio',
  "This file isn't a SNES game": 'Esse arquivo não é um jogo de SNES',
  "This file isn't a Mega Drive / Genesis game": 'Esse arquivo não é um jogo de Mega Drive / Genesis',
  "This file isn't a PlayStation game": 'Esse arquivo não é um jogo de PlayStation',
  "This file isn't a Nintendo 64 game": 'Esse arquivo não é um jogo de Nintendo 64',
  'This file is too big to be a SNES game': 'Esse arquivo é grande demais para ser um jogo de SNES',
  'This file is too big to be a Mega Drive game': 'Esse arquivo é grande demais para ser um jogo de Mega Drive',
  'This file is too big to be a Nintendo 64 game': 'Esse arquivo é grande demais para ser um jogo de Nintendo 64',
  "This .cue file doesn't list any track": 'Esse arquivo .cue não lista nenhuma faixa',
  'This is a PlayStation BIOS, not a game: pick it together with the game':
    'Isso é uma BIOS de PlayStation, não um jogo: escolha ela junto com o jogo',
  '.mdf images need their .mds: convert the disc to .cue/.bin or .chd':
    'Imagens .mdf precisam do .mds delas: converta o disco para .cue/.bin ou .chd',
  "This SNES game couldn't be loaded (the file may be corrupt)":
    'Não deu pra carregar esse jogo de SNES (o arquivo pode estar corrompido)',
  "This Mega Drive game couldn't be loaded (the file may be corrupt)":
    'Não deu pra carregar esse jogo de Mega Drive (o arquivo pode estar corrompido)',
  "This Nintendo 64 game couldn't be loaded (the file may be corrupt)":
    'Não deu pra carregar esse jogo de Nintendo 64 (o arquivo pode estar corrompido)',
  "This PlayStation game couldn't be loaded (the disc image may be incomplete or corrupt)":
    'Não deu pra carregar esse jogo de PlayStation (a imagem do disco pode estar incompleta ou corrompida)',
  "The SNES emulator couldn't start (its core failed to load)": 'O emulador de SNES não iniciou (o núcleo falhou ao carregar)',
  "The Mega Drive emulator couldn't start (its core failed to load)":
    'O emulador de Mega Drive não iniciou (o núcleo falhou ao carregar)',
  "The PlayStation emulator couldn't start (its core failed to load)":
    'O emulador de PlayStation não iniciou (o núcleo falhou ao carregar)',
  "The Nintendo 64 emulator couldn't start (its core failed to load)":
    'O emulador de Nintendo 64 não iniciou (o núcleo falhou ao carregar)',
  "The emulator couldn't create its screen": 'O emulador não conseguiu criar a tela',
  "The Nintendo 64 emulator couldn't create its screen": 'O emulador de Nintendo 64 não conseguiu criar a tela',
  "The emulator couldn't start its sound output": 'O emulador não conseguiu iniciar a saída de som',
  "The Nintendo 64 emulator needs WebGL 2, which isn't available (check the graphics driver)":
    'O emulador de Nintendo 64 precisa de WebGL 2, que não está disponível (confira o driver de vídeo)',
  'The game stopped working': 'O jogo parou de funcionar',
  'The game has been closed': 'O jogo foi fechado',
  "The game couldn't be saved": 'Não deu pra salvar o jogo',
  "This save doesn't belong to this game": 'Esse save não é deste jogo',

  // ---- emulator/systems.ts: console controls ----
  'D-pad (also the left stick)': 'Direcional (também o analógico esquerdo)',
  'X (6-button pad)': 'X (controle de 6 botões)',
  'Y (6-button pad)': 'Y (controle de 6 botões)',
  'Z (6-button pad)': 'Z (controle de 6 botões)',
  'D-pad': 'Direcional',
  'Left stick (the d-pad in games without analog)': 'Analógico esquerdo (o direcional em jogos sem analógico)',
  'Select (L1 + R1 + Select: the ANALOG button)': 'Select (L1 + R1 + Select: o botão ANALOG)',
  'Right stick (DualShock)': 'Analógico direito (DualShock)',
  '✕ Cross': '✕ X',
  '○ Circle': '○ Bola',
  '□ Square': '□ Quadrado',
  '△ Triangle': '△ Triângulo',
  'Control stick (keyboard: the arrows / WASD)': 'Analógico (teclado: setas / WASD)',
  'D-pad (with a gamepad)': 'Direcional (com controle)',
  'C buttons': 'Botões C',
} satisfies Dict
