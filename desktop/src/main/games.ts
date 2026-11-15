// "Playing X" game detection, the pure part (no Electron imports, unit-testable with plain node):
// the curated exe → game map, process-list parsing (Windows `tasklist /fo csv /nh`, elsewhere
// `ps -A -o comm=`) and matching. main/presence.ts runs the commands and owns the state.
//
// Only display names ever leave the machine; exe names stay in main (and the local Settings UI).

/**
 * Popular PC games by executable name (case-insensitive). Curated by hand: only names specific enough
 * not to clash with other programs (no `javaw.exe` for Minecraft Java, no `hl2.exe` / `ShooterGame.exe` /
 * `Client-Win64-Shipping.exe`, which many games share). Users add anything missing in Settings → Activity.
 */
export const KNOWN_GAMES: Readonly<Record<string, string>> = {
  // Competitive shooters / hero shooters
  'cs2.exe': 'Counter-Strike 2',
  'csgo.exe': 'Counter-Strike: Global Offensive',
  'VALORANT-Win64-Shipping.exe': 'VALORANT',
  'r5apex.exe': 'Apex Legends',
  'r5apex_dx12.exe': 'Apex Legends',
  'Overwatch.exe': 'Overwatch 2',
  'TslGame.exe': 'PUBG: Battlegrounds',
  'cod.exe': 'Call of Duty',
  'ModernWarfare.exe': 'Call of Duty: Modern Warfare',
  'BlackOpsColdWar.exe': 'Call of Duty: Black Ops Cold War',
  'RainbowSix.exe': "Tom Clancy's Rainbow Six Siege",
  'RainbowSix_Vulkan.exe': "Tom Clancy's Rainbow Six Siege",
  'RainbowSix_BE.exe': "Tom Clancy's Rainbow Six Siege",
  'FortniteClient-Win64-Shipping.exe': 'Fortnite',
  'Marvel-Win64-Shipping.exe': 'Marvel Rivals',
  'project8.exe': 'Deadlock',
  'Discovery.exe': 'THE FINALS',
  'PortalWars-Win64-Shipping.exe': 'Splitgate',
  'bf6.exe': 'Battlefield 6',
  'bf2042.exe': 'Battlefield 2042',
  'bfv.exe': 'Battlefield V',
  'bf1.exe': 'Battlefield 1',
  'bf4.exe': 'Battlefield 4',
  'destiny2.exe': 'Destiny 2',
  'EscapeFromTarkov.exe': 'Escape from Tarkov',
  'HuntGame.exe': 'Hunt: Showdown 1896',
  'helldivers2.exe': 'Helldivers 2',
  'Paladins.exe': 'Paladins',
  'Titanfall2.exe': 'Titanfall 2',
  'HaloInfinite.exe': 'Halo Infinite',
  'MCC-Win64-Shipping.exe': 'Halo: The Master Chief Collection',
  'BattleBit.exe': 'BattleBit Remastered',
  'DeltaForceClient-Win64-Shipping.exe': 'Delta Force',
  'tf_win64.exe': 'Team Fortress 2',
  'tf.exe': 'Team Fortress 2',
  'left4dead2.exe': 'Left 4 Dead 2',
  'portal2.exe': 'Portal 2',
  'gmod.exe': "Garry's Mod",
  'TheDivision2.exe': "Tom Clancy's The Division 2",
  'GRB.exe': "Tom Clancy's Ghost Recon Breakpoint",
  'NarakaBladepoint.exe': 'NARAKA: BLADEPOINT',
  'DungeonCrawler.exe': 'Dark and Darker',
  'GTFO.exe': 'GTFO',
  'ReadyOrNotSteam-Win64-Shipping.exe': 'Ready or Not',
  'ReadyOrNot-Win64-Shipping.exe': 'Ready or Not',
  'SquadGame.exe': 'Squad',
  'HLL-Win64-Shipping.exe': 'Hell Let Loose',
  'InsurgencyClient-Win64-Shipping.exe': 'Insurgency: Sandstorm',
  'Arma3_x64.exe': 'Arma 3',
  'ArmaReforgerSteam.exe': 'Arma Reforger',
  'DayZ_x64.exe': 'DayZ',
  'aces.exe': 'War Thunder',
  'WorldOfTanks.exe': 'World of Tanks',
  'WorldOfWarships64.exe': 'World of Warships',
  'Mordhau-Win64-Shipping.exe': 'MORDHAU',
  'Chivalry2-Win64-Shipping.exe': 'Chivalry 2',
  'ForHonor.exe': 'For Honor',
  'PAYDAY3Client-Win64-Shipping.exe': 'PAYDAY 3',
  'payday2_win32_release.exe': 'PAYDAY 2',
  'FSD-Win64-Shipping.exe': 'Deep Rock Galactic',
  'Darktide.exe': 'Warhammer 40,000: Darktide',
  'vermintide2.exe': 'Warhammer: Vermintide 2',
  'vermintide2_dx12.exe': 'Warhammer: Vermintide 2',
  'Warframe.x64.exe': 'Warframe',
  'DOOMEternalx64vk.exe': 'DOOM Eternal',
  'DOOMTheDarkAges.exe': 'DOOM: The Dark Ages',

  // MOBA, strategy, card games
  'League of Legends.exe': 'League of Legends',
  'LeagueClient.exe': 'League of Legends',
  'dota2.exe': 'Dota 2',
  'HeroesOfTheStorm_x64.exe': 'Heroes of the Storm',
  'LoR.exe': 'Legends of Runeterra',
  'Hearthstone.exe': 'Hearthstone',
  'MTGA.exe': 'Magic: The Gathering Arena',
  'SNAP.exe': 'MARVEL SNAP',
  'SC2_x64.exe': 'StarCraft II',
  'Warcraft III.exe': 'Warcraft III',
  'AoE2DE_s.exe': 'Age of Empires II: Definitive Edition',
  'RelicCardinal.exe': 'Age of Empires IV',
  'AoMRT_s.exe': 'Age of Mythology: Retold',
  'CivilizationVI.exe': "Sid Meier's Civilization VI",
  'CivilizationVI_DX12.exe': "Sid Meier's Civilization VI",
  'CivilizationVII.exe': "Sid Meier's Civilization VII",
  'eu4.exe': 'Europa Universalis IV',
  'hoi4.exe': 'Hearts of Iron IV',
  'stellaris.exe': 'Stellaris',
  'ck3.exe': 'Crusader Kings III',
  'victoria3.exe': 'Victoria 3',
  'Warhammer3.exe': 'Total War: WARHAMMER III',
  'XCom2.exe': 'XCOM 2',
  'Balatro.exe': 'Balatro',
  'SlayTheSpire.exe': 'Slay the Spire',
  'fm.exe': 'Football Manager',

  // MMOs and online RPGs
  'Wow.exe': 'World of Warcraft',
  'WowClassic.exe': 'World of Warcraft Classic',
  'ffxiv_dx11.exe': 'Final Fantasy XIV',
  'LOSTARK.exe': 'Lost Ark',
  'BlackDesert64.exe': 'Black Desert',
  'Gw2-64.exe': 'Guild Wars 2',
  'eso64.exe': 'The Elder Scrolls Online',
  'NewWorld.exe': 'New World',
  'RuneScape.exe': 'RuneScape',
  'osclient.exe': 'Old School RuneScape',
  'RuneLite.exe': 'Old School RuneScape',
  'Albion-Online.exe': 'Albion Online',
  'PathOfExile.exe': 'Path of Exile',
  'PathOfExile_x64.exe': 'Path of Exile',
  'PathOfExileSteam.exe': 'Path of Exile',
  'PathOfExile_x64Steam.exe': 'Path of Exile',
  'Diablo IV.exe': 'Diablo IV',
  'Diablo III64.exe': 'Diablo III',
  'D2R.exe': 'Diablo II: Resurrected',
  'GenshinImpact.exe': 'Genshin Impact',
  'YuanShen.exe': 'Genshin Impact',
  'StarRail.exe': 'Honkai: Star Rail',
  'ZenlessZoneZero.exe': 'Zenless Zone Zero',
  'EliteDangerous64.exe': 'Elite Dangerous',
  'StarCitizen.exe': 'Star Citizen',
  'NMS.exe': "No Man's Sky",
  'SoTGame.exe': 'Sea of Thieves',

  // Survival, crafting, co-op
  'RustClient.exe': 'Rust',
  'Minecraft.Windows.exe': 'Minecraft',
  'RobloxPlayerBeta.exe': 'Roblox',
  'Among Us.exe': 'Among Us',
  'DeadByDaylight-Win64-Shipping.exe': 'Dead by Daylight',
  'Palworld-Win64-Shipping.exe': 'Palworld',
  'valheim.exe': 'Valheim',
  'Terraria.exe': 'Terraria',
  'Stardew Valley.exe': 'Stardew Valley',
  'StardewModdingAPI.exe': 'Stardew Valley',
  'factorio.exe': 'Factorio',
  'FactoryGame-Win64-Shipping.exe': 'Satisfactory',
  'FactoryGameSteam-Win64-Shipping.exe': 'Satisfactory',
  'FactoryGameEGS-Win64-Shipping.exe': 'Satisfactory',
  'Lethal Company.exe': 'Lethal Company',
  'Phasmophobia.exe': 'Phasmophobia',
  'REPO.exe': 'R.E.P.O.',
  'PEAK.exe': 'PEAK',
  'Content Warning.exe': 'Content Warning',
  'Raft.exe': 'Raft',
  'SonsOfTheForest.exe': 'Sons of the Forest',
  'TheForest.exe': 'The Forest',
  '7DaysToDie.exe': '7 Days to Die',
  'ConanSandbox.exe': 'Conan Exiles',
  'ArkAscended.exe': 'ARK: Survival Ascended',
  'ProjectZomboid64.exe': 'Project Zomboid',
  'Subnautica.exe': 'Subnautica',
  'SubnauticaZero.exe': 'Subnautica: Below Zero',
  'enshrouded.exe': 'Enshrouded',
  'VRising.exe': 'V Rising',
  'AbioticFactor-Win64-Shipping.exe': 'Abiotic Factor',
  'Maine-Win64-Shipping.exe': 'Grounded',
  'dontstarve_steam_x64.exe': "Don't Starve Together",
  'Schedule I.exe': 'Schedule I',
  "Liar's Bar.exe": "Liar's Bar",
  'RimWorldWin64.exe': 'RimWorld',
  'Oxygen Not Included.exe': 'Oxygen Not Included',
  'DSPGAME.exe': 'Dyson Sphere Program',
  'Cities.exe': 'Cities: Skylines',
  'Cities2.exe': 'Cities: Skylines II',
  'TS4_x64.exe': 'The Sims 4',
  'Supermarket Simulator.exe': 'Supermarket Simulator',
  'FarmingSimulator2022.exe': 'Farming Simulator 22',
  'FarmingSimulator2025.exe': 'Farming Simulator 25',
  'SnowRunner.exe': 'SnowRunner',

  // Party and indie
  'FallGuys_client_game.exe': 'Fall Guys',
  'PartyAnimals.exe': 'Party Animals',
  'Overcooked2.exe': 'Overcooked! 2',
  'ItTakesTwo.exe': 'It Takes Two',
  'SplitFiction.exe': 'Split Fiction',
  'Golf With Your Friends.exe': 'Golf With Your Friends',
  'Brawlhalla.exe': 'Brawlhalla',
  'osu!.exe': 'osu!',
  'Risk of Rain 2.exe': 'Risk of Rain 2',
  'VampireSurvivors.exe': 'Vampire Survivors',
  'Brotato.exe': 'Brotato',
  'isaac-ng.exe': 'The Binding of Isaac: Rebirth',
  'Hades.exe': 'Hades',
  'Hades2.exe': 'Hades II',
  'hollow_knight.exe': 'Hollow Knight',
  'Hollow Knight.exe': 'Hollow Knight',
  'Hollow Knight Silksong.exe': 'Hollow Knight: Silksong',
  'Celeste.exe': 'Celeste',
  'Cuphead.exe': 'Cuphead',
  'deadcells.exe': 'Dead Cells',

  // Fighting and racing / sports
  'StreetFighter6.exe': 'Street Fighter 6',
  'Polaris-Win64-Shipping.exe': 'TEKKEN 8',
  'MK12.exe': 'Mortal Kombat 1',
  'GGST-Win64-Shipping.exe': 'Guilty Gear -Strive-',
  'RocketLeague.exe': 'Rocket League',
  'ForzaHorizon5.exe': 'Forza Horizon 5',
  'ForzaHorizon4.exe': 'Forza Horizon 4',
  'F1_24.exe': 'F1 24',
  'F1_25.exe': 'F1 25',
  'FC24.exe': 'EA SPORTS FC 24',
  'FC25.exe': 'EA SPORTS FC 25',
  'FC26.exe': 'EA SPORTS FC 26',
  'NBA2K25.exe': 'NBA 2K25',
  'NBA2K26.exe': 'NBA 2K26',
  'iRacingSim64DX11.exe': 'iRacing',
  'acs.exe': 'Assetto Corsa',
  'AC2-Win64-Shipping.exe': 'Assetto Corsa Competizione',
  'BeamNG.drive.x64.exe': 'BeamNG.drive',
  'eurotrucks2.exe': 'Euro Truck Simulator 2',
  'amtrucks.exe': 'American Truck Simulator',
  'Trackmania.exe': 'Trackmania',
  'NeedForSpeedUnbound.exe': 'Need for Speed Unbound',
  'NeedForSpeedHeat.exe': 'Need for Speed Heat',
  'TheCrewMotorfest.exe': 'The Crew Motorfest',
  'FlightSimulator.exe': 'Microsoft Flight Simulator',
  'FlightSimulator2024.exe': 'Microsoft Flight Simulator 2024',

  // Story / action RPGs
  'eldenring.exe': 'ELDEN RING',
  'nightreign.exe': 'ELDEN RING NIGHTREIGN',
  'bg3.exe': "Baldur's Gate 3",
  'bg3_dx11.exe': "Baldur's Gate 3",
  'GTA5.exe': 'Grand Theft Auto V',
  'GTA5_Enhanced.exe': 'Grand Theft Auto V',
  'RDR2.exe': 'Red Dead Redemption 2',
  'Cyberpunk2077.exe': 'Cyberpunk 2077',
  'witcher3.exe': 'The Witcher 3: Wild Hunt',
  'HogwartsLegacy.exe': 'Hogwarts Legacy',
  'Starfield.exe': 'Starfield',
  'SkyrimSE.exe': 'The Elder Scrolls V: Skyrim',
  'TESV.exe': 'The Elder Scrolls V: Skyrim',
  'Fallout4.exe': 'Fallout 4',
  'Fallout76.exe': 'Fallout 76',
  'MonsterHunterWilds.exe': 'Monster Hunter Wilds',
  'MonsterHunterWorld.exe': 'Monster Hunter: World',
  'MonsterHunterRise.exe': 'Monster Hunter Rise',
  'sekiro.exe': 'Sekiro: Shadows Die Twice',
  'DarkSoulsIII.exe': 'DARK SOULS III',
  'armoredcore6.exe': 'ARMORED CORE VI',
  'ACValhalla.exe': "Assassin's Creed Valhalla",
  'ACMirage.exe': "Assassin's Creed Mirage",
  'ACShadows.exe': "Assassin's Creed Shadows",
  'ACOdyssey.exe': "Assassin's Creed Odyssey",
  'FarCry6.exe': 'Far Cry 6',
  'FarCry5.exe': 'Far Cry 5',
  'KingdomCome.exe': 'Kingdom Come: Deliverance',
  'b1-Win64-Shipping.exe': 'Black Myth: Wukong',
  'Stalker2-Win64-Shipping.exe': 'S.T.A.L.K.E.R. 2',
  're4.exe': 'Resident Evil 4',
  're2.exe': 'Resident Evil 2',
  're8.exe': 'Resident Evil Village',
  'DyingLightGame_x64_rwdi.exe': 'Dying Light 2',
  'DyingLightGame.exe': 'Dying Light',
  'Spider-Man.exe': "Marvel's Spider-Man Remastered",
  'GoW.exe': 'God of War',
  'GoWR.exe': 'God of War Ragnarök',
  'GhostOfTsushima.exe': 'Ghost of Tsushima',
  'HorizonForbiddenWest.exe': 'Horizon Forbidden West',
  'P5R.exe': 'Persona 5 Royal',
  'ffxvi.exe': 'Final Fantasy XVI',
  'EoCApp.exe': 'Divinity: Original Sin 2',
}

/** A game the user added in Settings → Activity (overrides the curated name for the same exe). */
export interface GameEntry {
  exe: string
  name: string
}

/** Lowercase, trimmed, without a trailing `.exe`: what process names are compared by. */
export function normalizeExe(exe: string): string {
  return exe.trim().toLowerCase().replace(/\.exe$/, '')
}

/** Linux truncates `comm` to 15 characters (TASK_COMM_LEN - 1). */
const LINUX_COMM_MAX = 15

export interface GameMatcher {
  /** Display name of the game this process is, or null. */
  match(processName: string): string | null
}

/** Curated games plus the user's own (which win on the same exe). */
export function createMatcher(custom: readonly GameEntry[] = [], known: Readonly<Record<string, string>> = KNOWN_GAMES): GameMatcher {
  const exact = new Map<string, string>()
  for (const [exe, name] of Object.entries(known)) exact.set(normalizeExe(exe), name)
  for (const g of custom) exact.set(normalizeExe(g.exe), g.name)
  // Truncated Linux names ("RocketLeague.ex" for "RocketLeague.exe" under Proton) match by prefix.
  const truncated = new Map<string, string>()
  for (const [key, name] of exact) {
    const full = `${key}.exe`
    if (full.length > LINUX_COMM_MAX) truncated.set(full.slice(0, LINUX_COMM_MAX), name)
    if (key.length > LINUX_COMM_MAX) truncated.set(key.slice(0, LINUX_COMM_MAX), name)
  }
  return {
    match(processName) {
      const raw = processName.trim().toLowerCase()
      if (!raw) return null
      const hit = exact.get(normalizeExe(raw))
      if (hit) return hit
      return raw.length === LINUX_COMM_MAX ? (truncated.get(raw) ?? null) : null
    },
  }
}

export interface ProcessInfo {
  /** Executable name, e.g. "cs2.exe" (never a path). */
  exe: string
  /** Windows session number: 0 = services (not something the user runs). null when unknown. */
  session: number | null
}

/**
 * One CSV record of `tasklist /fo csv /nh`: `"Image Name","PID","Session Name","Session#","Mem Usage"`.
 * Fields are always quoted; a quote inside a field is doubled. Returns null for anything else
 * (blank lines, "INFO: No tasks are running…", truncated output).
 */
function parseCsvLine(line: string): string[] | null {
  const fields: string[] = []
  let i = 0
  while (i < line.length) {
    if (line[i] !== '"') return null
    let value = ''
    i++
    for (;;) {
      if (i >= line.length) return null // unterminated quote
      const c = line[i]
      if (c === '"') {
        if (line[i + 1] === '"') {
          value += '"'
          i += 2
          continue
        }
        i++
        break
      }
      value += c
      i++
    }
    fields.push(value)
    if (i >= line.length) break
    if (line[i] !== ',') return null
    i++
  }
  return fields.length > 0 ? fields : null
}

/** Processes from `tasklist /fo csv /nh` output (any Windows display language: only the layout is used). */
export function parseTasklistCsv(output: string): ProcessInfo[] {
  const out: ProcessInfo[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const fields = parseCsvLine(line)
    if (!fields || fields.length < 2) continue
    const exe = fields[0].trim()
    // The PID column is numeric; anything else is not a process record (e.g. a header line).
    if (!exe || !/^\d+$/.test(fields[1].trim())) continue
    const session = fields.length >= 4 && /^\d+$/.test(fields[3].trim()) ? Number(fields[3].trim()) : null
    out.push({ exe, session })
  }
  return out
}

/** Processes from `ps -A -o comm=` (Linux: the 15-char comm; macOS: the full path, reduced to its file name). */
export function parsePsOutput(output: string): ProcessInfo[] {
  const out: ProcessInfo[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const exe = line.slice(line.lastIndexOf('/') + 1).trim()
    if (exe) out.push({ exe, session: null })
  }
  return out
}

/**
 * Detection step: given the games running now (display names) and when each was first seen, returns the
 * updated first-seen map (games that stopped are dropped, new ones get `now`) and the activity to show:
 * the most recently started game, keeping the current one on a tie.
 */
export function nextActivity(
  running: Iterable<string>,
  firstSeen: ReadonlyMap<string, number>,
  current: { name: string; startedAt: number } | null,
  now: number,
): { firstSeen: Map<string, number>; activity: { name: string; startedAt: number } | null } {
  const next = new Map<string, number>()
  for (const name of running) next.set(name, firstSeen.get(name) ?? now)
  let best: { name: string; startedAt: number } | null = null
  for (const [name, startedAt] of next) {
    if (
      !best ||
      startedAt > best.startedAt ||
      (startedAt === best.startedAt && name === current?.name)
    ) {
      best = { name, startedAt }
    }
  }
  return { firstSeen: next, activity: best }
}

/** Windows/system processes never worth offering in "Add a game" (lowercase, without `.exe`). */
const NOT_GAMES = new Set(
  [
    'system', 'system idle process', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass',
    'svchost', 'fontdrvhost', 'dwm', 'explorer', 'sihost', 'taskhostw', 'ctfmon', 'conhost', 'runtimebroker',
    'searchhost', 'searchapp', 'searchindexer', 'searchprotocolhost', 'searchfilterhost', 'startmenuexperiencehost',
    'shellexperiencehost', 'textinputhost', 'applicationframehost', 'systemsettings', 'lockapp', 'dllhost',
    'backgroundtaskhost', 'securityhealthsystray', 'securityhealthservice', 'smartscreen', 'msmpeng', 'nissrv',
    'audiodg', 'spoolsv', 'wmiprvse', 'tasklist', 'cmd', 'powershell', 'pwsh', 'windowsterminal', 'openconsole',
    'taskmgr', 'useroobebroker', 'widgets', 'widgetservice', 'phoneexperiencehost', 'crossdeviceresume',
    'msedgewebview2', 'identity_helper', 'gamebar', 'gamebarftserver', 'gamebarpresencewriter', 'nvcontainer',
    'nvidia share', 'nvidia web helper', 'nvsphelper64', 'nvdisplay.container', 'radeonsoftware', 'amdrsserv',
    'onedrive', 'filecoauth', 'memory compression', 'secure system', 'unsecapp', 'wudfhost', 'sgrmbroker',
    'mousocoreworker', 'compattelrunner', 'dashost', 'atiesrxx', 'atieclxx', 'igfxem', 'rtkauduservice64',
    'steamwebhelper', 'steamservice', 'epicwebhelper', 'easyanticheat', 'easyanticheat_eos', 'beservice',
    'vgc', 'vgtray', 'crashpad_handler', 'nexo', 'nexo-media', 'electron',
  ],
)

/**
 * The user's own processes for "Add a game": unique exe names (first spelling seen), without services
 * (session 0), known system processes and Nexo itself, sorted case-insensitively.
 */
export function userProcessNames(processes: readonly ProcessInfo[], selfExe?: string): string[] {
  const seen = new Map<string, string>()
  const self = selfExe ? normalizeExe(selfExe) : null
  for (const p of processes) {
    if (p.session === 0) continue
    const key = normalizeExe(p.exe)
    if (!key || NOT_GAMES.has(key) || key === self || seen.has(key)) continue
    seen.set(key, p.exe)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}
