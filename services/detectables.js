const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'detectables_cache.json');
const PRESET_FILE = path.join(__dirname, '..', 'data', 'preset_games.json');

const POPULAR_PRESETS = [
  { id: "730", name: "Counter-Strike 2", executable: "cs2.exe" },
  { id: "700136079562375258", name: "VALORANT", executable: "VALORANT-Win64-Shipping.exe" },
  { id: "1402418586244612216", name: "Warframe", executable: "warframe.x64.exe" },
  { id: "424424351650070529", name: "Grand Theft Auto V", executable: "gta5.exe" },
  { id: "356860074901241856", name: "League of Legends", executable: "League of Legends.exe" },
  { id: "356875221078245376", name: "Minecraft", executable: "javaw.exe" },
  { id: "564177579848564757", name: "Cyberpunk 2077", executable: "Cyberpunk2077.exe" },
  { id: "541484311356604427", name: "Apex Legends", executable: "r5apex.exe" },
  { id: "947214917459447828", name: "Elden Ring", executable: "eldenring.exe" },
  { id: "570", name: "Dota 2", executable: "dota2.exe" },
  { id: "434825944062296064", name: "Rust", executable: "RustClient.exe" },
  { id: "762434991303950386", name: "Genshin Impact", executable: "GenshinImpact.exe" },
  { id: "1086077590891823134", name: "Baldur's Gate 3", executable: "bg3.exe" },
  { id: "432980957394370572", name: "Fortnite", executable: "FortniteClient-Win64-Shipping.exe" },
  { id: "441019183492562945", name: "Tom Clancy's Rainbow Six Siege", executable: "RainbowSix.exe" },
  { id: "433364405380481024", name: "Dead by Daylight", executable: "DeadByDaylight-Win64-Shipping.exe" },
  { id: "1157404467556093952", name: "Call of Duty: Modern Warfare III", executable: "cod.exe" },
  { id: "105600", name: "Terraria", executable: "Terraria.exe" },
  { id: "1199343518290628670", name: "Palworld", executable: "Palworld-Win64-Shipping.exe" },
  { id: "1170757279379701831", name: "Helldivers 2", executable: "helldivers2.exe" },
  { id: "292030", name: "The Witcher 3: Wild Hunt", executable: "witcher3.exe" },
  { id: "117410", name: "Red Dead Redemption 2", executable: "RDR2.exe" },
  { id: "252490", name: "Rust", executable: "RustClient.exe" },
  { id: "413150", name: "Stardew Valley", executable: "Stardew Valley.exe" },
  { id: "271590", name: "Grand Theft Auto V", executable: "GTA5.exe" },
  { id: "1091500", name: "Cyberpunk 2077", executable: "Cyberpunk2077.exe" },
  { id: "1245620", name: "ELDEN RING", executable: "eldenring.exe" },
  { id: "892970", name: "Valheim", executable: "valheim.exe" },
  { id: "230410", name: "Warframe", executable: "Warframe.x64.exe" },
  { id: "218620", name: "PAYDAY 2", executable: "payday2_win32_release.exe" },
  { id: "381210", name: "Dead by Daylight", executable: "DeadByDaylight-Win64-Shipping.exe" },
  { id: "550", name: "Left 4 Dead 2", executable: "left4dead2.exe" },
  { id: "440", name: "Team Fortress 2", executable: "hl2.exe" },
  { id: "4000", name: "Garry's Mod", executable: "gmod.exe" },
  { id: "252950", name: "Rocket League", executable: "RocketLeague.exe" },
  { id: "578080", name: "PUBG: BATTLEGROUNDS", executable: "TslGame.exe" },
  { id: "1086940", name: "Baldur's Gate 3", executable: "bg3_dx11.exe" },
  { id: "1938090", name: "Call of Duty", executable: "cod.exe" },
  { id: "2357570", name: "Overwatch 2", executable: "Overwatch.exe" },
  { id: "1966720", name: "Lethal Company", executable: "Lethal Company.exe" },
  { id: "815370", name: "Green Hell", executable: "GH.exe" },
  { id: "648800", name: "Raft", executable: "Raft.exe" },
  { id: "1145360", name: "Hades", executable: "Hades.exe" },
  { id: "1145350", name: "Hades II", executable: "Hades2.exe" },
  { id: "1817070", name: "Marvel's Spider-Man Remastered", executable: "Spider-Man.exe" },
  { id: "990080", name: "Hogwarts Legacy", executable: "HogwartsLegacy.exe" },
  { id: "1222670", name: "The Sims 4", executable: "TS4_x64.exe" },
  { id: "1172470", name: "Apex Legends", executable: "r5apex.exe" },
  { id: "251570", name: "7 Days to Die", executable: "7DaysToDie.exe" },
  { id: "394360", name: "Hearts of Iron IV", executable: "hoi4.exe" },
  { id: "281990", name: "Stellaris", executable: "stellaris.exe" }
];

class DetectablesService {
  constructor() {
    this.games = [];
    this.validGames = [];
    this.isLoaded = false;
  }

  async init() {
    // 1. Try reading from local cache
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
        this.games = JSON.parse(raw);
        this._processGames();
        this.isLoaded = true;
        console.log(`[Detectables] Loaded ${this.validGames.length} valid games from local cache.`);
        // Refresh cache in background
        this.fetchFromDiscordCDN().catch(() => {});
        return;
      }
    } catch (e) {
      console.warn('[Detectables] Cache read error:', e.message);
    }

    // 2. Fetch from Discord CDN
    await this.fetchFromDiscordCDN();
  }

  async fetchFromDiscordCDN() {
    try {
      console.log('[Detectables] Downloading latest detectables database from Discord CDN...');
      const response = await axios.get('https://cdn.discordapp.com/detectables/games.json', {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9168 Chrome/128.0.6613.186 Electron/32.2.2 Safari/537.36'
        }
      });

      if (Array.isArray(response.data) && response.data.length > 0) {
        this.games = response.data;
        this._processGames();
        this.isLoaded = true;
        console.log(`[Detectables] Successfully loaded and cached ${this.validGames.length} valid games.`);
        
        // Write cache safely
        fs.writeFileSync(CACHE_FILE, JSON.stringify(this.games), 'utf-8');
      }
    } catch (error) {
      console.error('[Detectables] Failed to download from Discord CDN:', error.message);
      if (this.validGames.length === 0) {
        this._fallbackToPresets();
      }
    }
  }

  _processGames() {
    this.validGames = [];
    for (const game of this.games) {
      if (!game || !game.id || !game.name) continue;

      let executable = null;
      if (Array.isArray(game.executables) && game.executables.length > 0) {
        // Prefer win32 executable or non-launcher
        const winExe = game.executables.find(e => e.os === 'win32' && !e.is_launcher);
        if (winExe && winExe.name) {
          executable = winExe.name;
        } else {
          const anyExe = game.executables.find(e => e.name);
          if (anyExe) executable = anyExe.name;
        }
      }

      if (!executable) {
        // If no executable in discord schema, generate a standard safe exe name
        const sanitized = game.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        executable = `${sanitized || 'game'}.exe`;
      }

      this.validGames.push({
        id: String(game.id),
        name: game.name,
        executable: executable,
        icon_hash: game.icon_hash || null
      });
    }
  }

  _fallbackToPresets() {
    console.log('[Detectables] Using built-in popular game presets.');
    this.validGames = POPULAR_PRESETS;
    this.isLoaded = true;
  }

  getPresets() {
    return POPULAR_PRESETS;
  }

  getAllGames() {
    return this.validGames;
  }

  getGameById(id) {
    return this.validGames.find(g => String(g.id) === String(id));
  }

  searchGames(query, limit = 50) {
    if (!query || typeof query !== 'string') return this.validGames.slice(0, limit);
    const q = query.toLowerCase().trim();
    const results = [];
    for (const g of this.validGames) {
      if (g.name.toLowerCase().includes(q) || g.executable.toLowerCase().includes(q) || g.id === q) {
        results.push(g);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  getRandomUniqueGames(count = 100) {
    const pool = [...this.validGames];
    // Fisher-Yates shuffle
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, Math.min(count, pool.length));
  }
}

module.exports = new DetectablesService();
