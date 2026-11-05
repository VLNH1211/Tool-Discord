const SteamUser = require('steam-user');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'steam_config.json');

// 32 trò chơi phổ biến tối ưu cày giờ Steam (tối đa 32 game đồng thời)
const GAMES_LIST = [
  { appId: 730, name: 'Counter-Strike 2' },
  { appId: 570, name: 'Dota 2' },
  { appId: 440, name: 'Team Fortress 2' },
  { appId: 578080, name: 'PUBG: BATTLEGROUNDS' },
  { appId: 1172470, name: 'Apex Legends' },
  { appId: 230410, name: 'Warframe' },
  { appId: 1085660, name: 'Destiny 2' },
  { appId: 242760, name: 'The Forest' },
  { appId: 346110, name: 'ARK: Survival Evolved' },
  { appId: 359550, name: "Tom Clancy's Rainbow Six Siege" },
  { appId: 1245620, name: 'ELDEN RING' },
  { appId: 1091500, name: 'Cyberpunk 2077' },
  { appId: 431960, name: 'Wallpaper Engine' },
  { appId: 550, name: 'Left 4 Dead 2' },
  { appId: 648800, name: 'Raft' },
  { appId: 440900, name: 'Conan Exiles' },
  { appId: 435150, name: 'Divinity: Original Sin 2' },
  { appId: 239140, name: 'Dying Light' },
  { appId: 203160, name: 'Tomb Raider' },
  { appId: 220240, name: 'Far Cry 3' },
  { appId: 298110, name: 'Far Cry 4' },
  { appId: 552520, name: 'Far Cry 5' },
  { appId: 1086940, name: "Baldur's Gate 3" },
  { appId: 1627720, name: 'Lies of P' },
  { appId: 1151640, name: 'Horizon Zero Dawn' },
  { appId: 524220, name: 'NieR:Automata' },
  { appId: 924970, name: 'Back 4 Blood' },
  { appId: 1501750, name: 'Lords of the Fallen' },
  { appId: 1260320, name: 'Party Animals' },
  { appId: 1238810, name: 'Battlefield V' },
  { appId: 1238840, name: 'Battlefield 1' },
  { appId: 105600, name: 'Terraria' }
];

const APP_IDS = GAMES_LIST.map(g => g.appId);

class SteamBoosterService {
  constructor() {
    this.client = null;
    this.isLoggedOn = false;
    this.isBlockedByLocal = false;
    this.statusText = 'Chưa khởi động';
    this.steamId64 = '';
    this.loginTime = null;
    this.startTime = Date.now();
    this.steamGuardWaiting = false;
    this.steamGuardDomain = '';
    this.pendingSteamGuardCallback = null;
    this.lastCodeWrong = false;
    this.credentials = {
      username: '',
      password: ''
    };
  }

  loadConfig() {
    // 1. Thử đọc từ biến môi trường
    let username = process.env.STEAM_USERNAME || '';
    let password = process.env.STEAM_PASSWORD || '';

    // 2. Thử đọc từ tệp cấu hình cục bộ nếu biến môi trường chưa có
    if (!username || !password) {
      try {
        if (fs.existsSync(CONFIG_PATH)) {
          const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
          const data = JSON.parse(raw);
          username = username || data.username || '';
          password = password || data.password || '';
        }
      } catch (err) {
        console.warn('[SteamBooster] Không thể đọc steam_config.json:', err.message);
      }
    }

    this.credentials.username = username;
    this.credentials.password = password;
  }

  saveConfig(username, password) {
    this.credentials.username = username;
    this.credentials.password = password;
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ username, password }, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[SteamBooster] Lỗi lưu cấu hình:', err.message);
    }
  }

  init() {
    this.loadConfig();

    this.client = new SteamUser({
      autoRelogin: true,
      promptSteamGuardCode: false
    });

    this.setupEvents();

    if (this.credentials.username && this.credentials.password) {
      this.attemptLogin();
    } else {
      this.statusText = 'Chờ cấu hình tài khoản (STEAM_USERNAME / STEAM_PASSWORD)';
      console.log('[SteamBooster] Chưa cấu hình STEAM_USERNAME hoặc STEAM_PASSWORD. Sẵn sàng cấu hình qua Web UI hoặc biến môi trường.');
    }
  }

  setupEvents() {
    this.client.on('loggedOn', () => {
      this.isLoggedOn = true;
      this.steamGuardWaiting = false;
      this.pendingSteamGuardCallback = null;
      this.lastCodeWrong = false;
      this.loginTime = Date.now();
      this.steamId64 = this.client.steamID ? this.client.steamID.getSteamID64() : '';
      this.statusText = `Đang cày đồng thời ${GAMES_LIST.length} game`;

      console.log(`[SteamBooster] Đăng nhập thành công! SteamID64: ${this.steamId64}`);
      this.client.setPersona(SteamUser.EPersonaState.Online);
      this.client.gamesPlayed(APP_IDS);
      console.log(`[SteamBooster] Đã kích hoạt 32 game. Tốc độ: +32h mỗi 1 giờ thực (+768h/ngày).`);
    });

    this.client.on('steamGuard', (domain, callback, lastCodeWrong) => {
      this.steamGuardWaiting = true;
      this.steamGuardDomain = domain || '';
      this.pendingSteamGuardCallback = callback;
      this.lastCodeWrong = Boolean(lastCodeWrong);
      this.statusText = `Yêu cầu mã Steam Guard ${domain ? `(Email: ${domain})` : '(Mobile Authenticator)'}`;

      console.warn(`[SteamBooster] Yêu cầu mã Steam Guard từ ${domain || 'ứng dụng di động'}. Vui lòng nhập mã trên Web UI.`);
    });

    this.client.on('playingState', (blocked, playingApp) => {
      if (blocked) {
        this.isBlockedByLocal = true;
        this.statusText = `Tạm dừng: Bạn đang chơi game trên PC (AppID: ${playingApp || 'Chưa rõ'}). Đang nhường quyền.`;
        console.log(`[SteamBooster] Phát hiện bạn đang chơi game trên PC. Tạm dừng cày để nhường quyền ưu tiên.`);
      } else {
        if (this.isBlockedByLocal) {
          this.isBlockedByLocal = false;
          this.statusText = `Đang cày đồng thời ${GAMES_LIST.length} game`;
          console.log(`[SteamBooster] Phiên chơi PC kết thúc. Tự động tiếp tục cày 32 game.`);
          this.client.gamesPlayed(APP_IDS);
        }
      }
    });

    this.client.on('error', (err) => {
      this.isLoggedOn = false;
      this.statusText = `Lỗi kết nối Steam: ${err.message}`;
      console.error(`[SteamBooster] Lỗi:`, err.message);
    });

    this.client.on('disconnected', (eresult, msg) => {
      this.isLoggedOn = false;
      this.statusText = `Mất kết nối Steam (Mã: ${eresult} - ${msg || 'Unknown'}). Đang chờ tự động kết nối lại...`;
      console.warn(`[SteamBooster] Mất kết nối: ${eresult} - ${msg}`);
    });
  }

  attemptLogin() {
    if (!this.credentials.username || !this.credentials.password) {
      this.statusText = 'Thiếu thông tin đăng nhập Steam';
      return false;
    }

    this.statusText = `Đang kết nối tài khoản: ${this.credentials.username}...`;
    console.log(`[SteamBooster] Đang gửi yêu cầu đăng nhập tài khoản: ${this.credentials.username}`);

    try {
      this.client.logOn({
        accountName: this.credentials.username,
        password: this.credentials.password
      });
      return true;
    } catch (err) {
      this.statusText = `Lỗi đăng nhập: ${err.message}`;
      console.error('[SteamBooster] Lỗi khi gọi logOn:', err.message);
      return false;
    }
  }

  submitGuardCode(code) {
    if (!code) {
      return { success: false, message: 'Vui lòng cung cấp mã Steam Guard.' };
    }

    const cleanCode = String(code).trim().toUpperCase();

    if (this.pendingSteamGuardCallback) {
      try {
        this.pendingSteamGuardCallback(cleanCode);
        this.steamGuardWaiting = false;
        this.pendingSteamGuardCallback = null;
        this.statusText = 'Đã gửi mã xác nhận Steam Guard, đang xác thực...';
        return { success: true, message: 'Đã gửi mã xác nhận Steam Guard thành công.' };
      } catch (err) {
        return { success: false, message: `Lỗi gửi mã: ${err.message}` };
      }
    }

    // Nếu không có callback đang chờ, thử login lại kèm 2FA code
    if (this.credentials.username && this.credentials.password) {
      try {
        this.client.logOn({
          accountName: this.credentials.username,
          password: this.credentials.password,
          twoFactorCode: cleanCode
        });
        this.statusText = 'Đang đăng nhập kèm mã 2FA...';
        return { success: true, message: 'Đang gửi đăng nhập kèm mã xác nhận.' };
      } catch (err) {
        return { success: false, message: err.message };
      }
    }

    return { success: false, message: 'Không có yêu cầu Steam Guard nào đang chờ xử lý.' };
  }

  reconnect() {
    try {
      if (this.client) {
        this.client.logOff();
      }
    } catch (e) {}

    setTimeout(() => {
      this.attemptLogin();
    }, 1500);

    return { success: true, message: 'Đang tái kết nối tới Steam Network...' };
  }

  getStatus() {
    const uptimeSeconds = this.loginTime ? Math.floor((Date.now() - this.loginTime) / 1000) : 0;
    const uptimeHours = uptimeSeconds > 0 ? (uptimeSeconds / 3600) : 0;
    const totalHoursGained = uptimeHours * GAMES_LIST.length;

    let maskedUsername = '';
    if (this.credentials.username) {
      const u = this.credentials.username;
      maskedUsername = u.length > 4 ? u.slice(0, 2) + '***' + u.slice(-2) : u.slice(0, 1) + '***';
    }

    return {
      configured: Boolean(this.credentials.username && this.credentials.password),
      username: maskedUsername,
      rawUsername: this.credentials.username,
      isLoggedOn: this.isLoggedOn,
      steamId64: this.steamId64,
      statusText: this.statusText,
      isBlockedByLocal: this.isBlockedByLocal,
      steamGuardWaiting: this.steamGuardWaiting,
      steamGuardDomain: this.steamGuardDomain,
      lastCodeWrong: this.lastCodeWrong,
      loginTime: this.loginTime,
      uptimeSeconds,
      uptimeHours: Number(uptimeHours.toFixed(2)),
      totalHoursGained: Number(totalHoursGained.toFixed(2)),
      ratePerHour: GAMES_LIST.length,
      ratePerDay: GAMES_LIST.length * 24,
      gamesCount: GAMES_LIST.length,
      games: GAMES_LIST
    };
  }
}

module.exports = new SteamBoosterService();
