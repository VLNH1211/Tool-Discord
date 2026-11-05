const SteamUser = require('steam-user');
const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'steam_config.json');
const VAULT_PATH = path.join(__dirname, '..', 'data', 'steam_vault.json');

// 32 trò chơi sở hữu trong tài khoản Steam của bạn có giờ chơi 0h (chưa từng mở)
const GAMES_LIST = [
  { appId: 220, name: 'Half-Life 2', initialPlaytime: '0.0h' },
  { appId: 320, name: 'Half-Life 2: Deathmatch', initialPlaytime: '0.0h' },
  { appId: 340, name: 'Half-Life 2: Lost Coast', initialPlaytime: '0.0h' },
  { appId: 360, name: 'Half-Life Deathmatch: Source', initialPlaytime: '0.0h' },
  { appId: 380, name: 'Half-Life 2: Episode One', initialPlaytime: '0.0h' },
  { appId: 420, name: 'Half-Life 2: Episode Two', initialPlaytime: '0.0h' },
  { appId: 261570, name: 'Ori and the Blind Forest', initialPlaytime: '0.0h' },
  { appId: 287390, name: 'METRO Last Light Redux', initialPlaytime: '0.0h' },
  { appId: 356190, name: 'Middle-earth: Shadow of War', initialPlaytime: '0.0h' },
  { appId: 359550, name: "Tom Clancy's Rainbow Six Siege", initialPlaytime: '0.0h' },
  { appId: 391220, name: 'Rise of the Tomb Raider', initialPlaytime: '0.0h' },
  { appId: 407530, name: 'ARK: The Survival Of The Fittest', initialPlaytime: '0.0h' },
  { appId: 412020, name: 'Metro Exodus', initialPlaytime: '0.0h' },
  { appId: 438100, name: 'VRChat', initialPlaytime: '0.0h' },
  { appId: 627690, name: 'Idle Champions of the Forgotten Realms', initialPlaytime: '0.0h' },
  { appId: 689350, name: 'Ruin City Gasolina', initialPlaytime: '0.0h' },
  { appId: 750920, name: 'Shadow of the Tomb Raider: Definitive Edition', initialPlaytime: '0.0h' },
  { appId: 981600, name: 'Eternium', initialPlaytime: '0.0h' },
  { appId: 1057090, name: 'Ori and the Will of the Wisps', initialPlaytime: '0.0h' },
  { appId: 1085660, name: 'Destiny 2', initialPlaytime: '0.0h' },
  { appId: 1113280, name: 'Persona 4 Golden', initialPlaytime: '0.0h' },
  { appId: 1174180, name: 'Red Dead Redemption 2', initialPlaytime: '0.0h' },
  { appId: 1203220, name: 'NARAKA: BLADEPOINT', initialPlaytime: '0.0h' },
  { appId: 1240440, name: 'Halo Infinite', initialPlaytime: '0.0h' },
  { appId: 1282270, name: 'Strinova', initialPlaytime: '0.0h' },
  { appId: 1367080, name: 'MOBILE FORCE GUNDAM BATTLE OPERATION 2', initialPlaytime: '0.0h' },
  { appId: 1531430, name: 'Paragon: The Overprime', initialPlaytime: '0.0h' },
  { appId: 1629910, name: 'Souls of Chronos', initialPlaytime: '0.0h' },
  { appId: 1638660, name: 'Blood Spear', initialPlaytime: '0.0h' },
  { appId: 1675900, name: 'Warlander', initialPlaytime: '0.0h' },
  { appId: 1691340, name: 'STEEL HUNTERS', initialPlaytime: '0.0h' },
  { appId: 1818450, name: 'STALZONE', initialPlaytime: '0.0h' }
];

const APP_IDS = GAMES_LIST.map(g => g.appId);

class SteamBoosterService {
  constructor() {
    this.client = null;
    this.isLoggedOn = false;
    this.isRunning = true; // Trạng thái BẬT / TẮT cày game của Bot
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
      password: '',
      refreshToken: ''
    };
    this.vaultAccounts = [];
    this.activeQrSession = null;
    this.qrStatus = {
      state: 'idle',
      message: 'Sẵn sàng tạo mã QR đăng nhập.',
      qrDataUrl: '',
      qrUrl: '',
      expiresAt: null
    };
  }

  // --- STEAM ACCOUNT VAULT PERSISTENCE ---
  loadVault() {
    try {
      if (fs.existsSync(VAULT_PATH)) {
        const raw = fs.readFileSync(VAULT_PATH, 'utf-8');
        this.vaultAccounts = JSON.parse(raw);
        if (!Array.isArray(this.vaultAccounts)) this.vaultAccounts = [];
      } else {
        this.vaultAccounts = [];
      }
    } catch (e) {
      console.warn('[SteamBooster Vault] Lỗi đọc steam_vault.json:', e.message);
      this.vaultAccounts = [];
    }
  }

  saveVault() {
    try {
      fs.mkdirSync(path.dirname(VAULT_PATH), { recursive: true });
      fs.writeFileSync(VAULT_PATH, JSON.stringify(this.vaultAccounts, null, 2), 'utf-8');
    } catch (e) {
      console.warn('[SteamBooster Vault] Lỗi lưu steam_vault.json:', e.message);
    }
  }

  addOrUpdateSavedAccount(accountData) {
    this.loadVault();
    const id = accountData.steamId64 || accountData.username;
    if (!id) return;

    const existingIdx = this.vaultAccounts.findIndex(a => a.id === id || a.username === accountData.username);
    const now = Date.now();

    // Mark other accounts as inactive
    this.vaultAccounts.forEach(a => a.isActive = false);

    const record = {
      id,
      username: accountData.username || (existingIdx >= 0 ? this.vaultAccounts[existingIdx].username : 'Unknown'),
      steamId64: accountData.steamId64 || (existingIdx >= 0 ? this.vaultAccounts[existingIdx].steamId64 : ''),
      password: accountData.password || (existingIdx >= 0 ? this.vaultAccounts[existingIdx].password : ''),
      refreshToken: accountData.refreshToken || (existingIdx >= 0 ? this.vaultAccounts[existingIdx].refreshToken : ''),
      label: accountData.label || `@${accountData.username}`,
      addedAt: existingIdx >= 0 ? this.vaultAccounts[existingIdx].addedAt : now,
      lastUsed: now,
      isActive: true
    };

    if (existingIdx >= 0) {
      this.vaultAccounts[existingIdx] = record;
    } else {
      this.vaultAccounts.unshift(record);
    }

    this.saveVault();
    console.log(`[SteamBooster Vault] Đã lưu tài khoản Steam: @${record.username} (${record.steamId64})`);
  }

  getSavedAccounts() {
    this.loadVault();
    return this.vaultAccounts.map(a => ({
      id: a.id,
      username: a.username,
      steamId64: a.steamId64,
      label: a.label || `@${a.username}`,
      hasPassword: Boolean(a.password),
      hasRefreshToken: Boolean(a.refreshToken),
      isActive: a.isActive || (this.steamId64 && a.steamId64 === this.steamId64) || (this.credentials.username && a.username === this.credentials.username),
      addedAt: a.addedAt,
      lastUsed: a.lastUsed
    }));
  }

  switchAccount(id) {
    this.loadVault();
    const acc = this.vaultAccounts.find(a => a.id === id || a.steamId64 === id || a.username === id);
    if (!acc) {
      return { success: false, message: 'Không tìm thấy tài khoản trong Vault.' };
    }

    this.vaultAccounts.forEach(a => a.isActive = (a.id === acc.id));
    this.saveVault();

    this.credentials.username = acc.username || '';
    this.credentials.password = acc.password || '';
    this.credentials.refreshToken = acc.refreshToken || '';

    this.saveConfig(this.credentials.username, this.credentials.password, this.credentials.refreshToken);

    try {
      if (this.client) this.client.logOff();
    } catch (e) {}

    setTimeout(() => {
      this.attemptLogin();
    }, 1200);

    return { success: true, message: `Đang chuyển sang tài khoản @${acc.username}...` };
  }

  deleteSavedAccount(id) {
    this.loadVault();
    this.vaultAccounts = this.vaultAccounts.filter(a => a.id !== id && a.steamId64 !== id && a.username !== id);
    this.saveVault();
    return { success: true, message: 'Đã xóa tài khoản khỏi Vault.' };
  }

  // --- BOT RUNTIME CONTROLS (BẬT / TẮT) ---
  startBot() {
    this.isRunning = true;
    if (this.isLoggedOn && this.client) {
      this.client.setPersona(SteamUser.EPersonaState.Online);
      this.client.gamesPlayed(APP_IDS);
      this.statusText = `Đang cày đồng thời ${GAMES_LIST.length} game 0h`;
      console.log(`[SteamBooster] Đã BẬT cày 32 game Steam.`);
      return { success: true, message: 'Đã BẬT bot! Đang cày 32 game 0h liên tục.', isRunning: true };
    } else {
      this.attemptLogin();
      return { success: true, message: 'Đang kết nối lại và kích hoạt cày 32 game.', isRunning: true };
    }
  }

  stopBot() {
    this.isRunning = false;
    if (this.isLoggedOn && this.client) {
      this.client.gamesPlayed([]); // Dừng cày toàn bộ trò chơi
      this.statusText = 'Đã tạm dừng: Bot đang TẮT (Không cày game)';
      console.log(`[SteamBooster] Đã TẮT cày game (Tạm dừng hoạt động).`);
    } else {
      this.statusText = 'Bot đang TẮT (Không hoạt động)';
    }
    return { success: true, message: 'Đã TẮT bot! Toàn bộ 32 game đã tạm dừng cày.', isRunning: false };
  }

  toggleBot() {
    return this.isRunning ? this.stopBot() : this.startBot();
  }

  // --- CONFIG LOADER & INITIALIZATION ---
  loadConfig() {
    this.loadVault();

    let username = process.env.STEAM_USERNAME || '';
    let password = process.env.STEAM_PASSWORD || '';
    let refreshToken = process.env.STEAM_REFRESH_TOKEN || '';

    // 1. Đọc từ tệp cấu hình cục bộ
    if (!refreshToken && (!username || !password)) {
      try {
        if (fs.existsSync(CONFIG_PATH)) {
          const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
          const data = JSON.parse(raw);
          username = username || data.username || '';
          password = password || data.password || '';
          refreshToken = refreshToken || data.refreshToken || '';
        }
      } catch (err) {
        console.warn('[SteamBooster] Không thể đọc steam_config.json:', err.message);
      }
    }

    // 2. Nếu vẫn trống, thử nạp tài khoản active gần nhất từ steam_vault.json
    if (!refreshToken && (!username || !password) && this.vaultAccounts.length > 0) {
      const active = this.vaultAccounts.find(a => a.isActive) || this.vaultAccounts[0];
      if (active) {
        username = active.username || '';
        password = active.password || '';
        refreshToken = active.refreshToken || '';
        console.log(`[SteamBooster] Tự động nạp tài khoản lưu trong Vault: @${username}`);
      }
    }

    this.credentials.username = username;
    this.credentials.password = password;
    this.credentials.refreshToken = refreshToken;
  }

  saveConfig(username, password, refreshToken = '') {
    if (username) this.credentials.username = username;
    if (password) this.credentials.password = password;
    if (refreshToken) this.credentials.refreshToken = refreshToken;

    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        username: this.credentials.username,
        password: this.credentials.password,
        refreshToken: this.credentials.refreshToken
      }, null, 2), 'utf-8');
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

    if (this.credentials.refreshToken || (this.credentials.username && this.credentials.password)) {
      this.attemptLogin();
    } else {
      this.statusText = 'Chờ cấu hình tài khoản (Quét mã QR hoặc nhập tài khoản)';
      console.log('[SteamBooster] Sẵn sàng đăng nhập Steam qua mã QR hoặc biểu mẫu tài khoản.');
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

      // Tự động lưu tài khoản vào Vault
      this.addOrUpdateSavedAccount({
        id: this.steamId64 || this.credentials.username,
        username: this.credentials.username,
        steamId64: this.steamId64,
        password: this.credentials.password,
        refreshToken: this.credentials.refreshToken
      });

      if (this.isRunning) {
        this.statusText = `Đang cày đồng thời ${GAMES_LIST.length} game 0h`;
        console.log(`[SteamBooster] Đăng nhập thành công! SteamID64: ${this.steamId64}`);
        this.client.setPersona(SteamUser.EPersonaState.Online);
        this.client.gamesPlayed(APP_IDS);
        console.log(`[SteamBooster] Đã kích hoạt 32 game 0h. Tốc độ: +32h mỗi 1 giờ thực (+768h/ngày).`);
      } else {
        this.statusText = 'Đã kết nối Steam (Bot đang TẮT)';
        this.client.gamesPlayed([]);
        console.log(`[SteamBooster] Đăng nhập thành công nhưng Bot đang ở chế độ TẮT.`);
      }
    });

    this.client.on('steamGuard', (domain, callback, lastCodeWrong) => {
      this.steamGuardWaiting = true;
      this.steamGuardDomain = domain || '';
      this.pendingSteamGuardCallback = callback;
      this.lastCodeWrong = Boolean(lastCodeWrong);
      this.statusText = `Yêu cầu mã Steam Guard ${domain ? `(Email: ${domain})` : '(Mobile Authenticator)'}`;

      console.warn(`[SteamBooster] Yêu cầu mã Steam Guard từ ${domain || 'ứng dụng di động'}.`);
    });

    this.client.on('playingState', (blocked, playingApp) => {
      if (blocked) {
        this.isBlockedByLocal = true;
        this.statusText = `Tạm dừng: Bạn đang chơi game trên PC (AppID: ${playingApp || 'Chưa rõ'}). Đang nhường quyền.`;
        console.log(`[SteamBooster] Phát hiện chơi game trên PC. Tạm dừng để nhường quyền ưu tiên.`);
      } else {
        if (this.isBlockedByLocal) {
          this.isBlockedByLocal = false;
          if (this.isRunning) {
            this.statusText = `Đang cày đồng thời ${GAMES_LIST.length} game 0h`;
            console.log(`[SteamBooster] Phiên chơi PC kết thúc. Tự động tiếp tục cày 32 game.`);
            this.client.gamesPlayed(APP_IDS);
          } else {
            this.statusText = 'Bot đang TẮT';
          }
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
      this.statusText = `Mất kết nối Steam (Mã: ${eresult} - ${msg || 'Unknown'}). Chờ kết nối lại...`;
      console.warn(`[SteamBooster] Mất kết nối: ${eresult} - ${msg}`);
    });
  }

  attemptLogin() {
    // 1. Ưu tiên đăng nhập bằng Refresh Token từ phiên quét mã QR
    if (this.credentials.refreshToken) {
      this.statusText = 'Đang đăng nhập bằng phiên ủy quyền QR (Refresh Token)...';
      console.log('[SteamBooster] Đang đăng nhập Steam bằng Refresh Token đã lưu...');
      try {
        this.client.logOn({
          refreshToken: this.credentials.refreshToken
        });
        return true;
      } catch (err) {
        this.statusText = `Lỗi đăng nhập Refresh Token: ${err.message}`;
        console.error('[SteamBooster] Lỗi đăng nhập Refresh Token:', err.message);
      }
    }

    // 2. Đăng nhập bằng tên tài khoản và mật khẩu
    if (this.credentials.username && this.credentials.password) {
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

    this.statusText = 'Thiếu thông tin đăng nhập Steam';
    return false;
  }

  // --- QUÉT MÃ QR STEAM LOGIN (STEAM MOBILE APP) ---
  async startQrLogin() {
    if (this.activeQrSession) {
      try {
        this.activeQrSession.cancelLoginAttempt();
      } catch (e) {}
      this.activeQrSession = null;
    }

    const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
    this.activeQrSession = session;

    this.qrStatus = {
      state: 'generating',
      message: 'Đang kết nối Steam Network để tạo mã QR...',
      qrDataUrl: '',
      qrUrl: '',
      expiresAt: Date.now() + 180000
    };

    try {
      const res = await session.startWithQR();
      this.qrStatus.state = 'waiting_for_scan';
      this.qrStatus.qrUrl = res.qrChallengeUrl;

      // Sinh ảnh Base64 Data URL của mã QR
      this.qrStatus.qrDataUrl = await QRCode.toDataURL(res.qrChallengeUrl, {
        margin: 2,
        scale: 6,
        color: {
          dark: '#000000',
          light: '#ffffff'
        }
      });
      this.qrStatus.message = 'Mở ứng dụng Steam trên điện thoại và quét mã QR này.';

      // Người dùng đã quét mã trên điện thoại
      session.on('remoteInteraction', () => {
        console.log('[SteamBooster QR] Đã quét mã QR! Chờ người dùng bấm xác nhận trên điện thoại...');
        this.qrStatus.state = 'scanned';
        this.qrStatus.message = 'Đã quét mã! Vui lòng nhấn "Xác nhận đăng nhập" (Sign in) trên điện thoại.';
      });

      // Người dùng đã phê duyệt đăng nhập trên điện thoại
      session.on('authenticated', async () => {
        const steamId = session.steamID ? session.steamID.getSteamID64() : '';
        console.log(`[SteamBooster QR] Phê duyệt QR thành công! SteamID: ${steamId}`);
        this.qrStatus.state = 'authenticated';
        this.qrStatus.message = 'Xác thực thành công! Đang lưu phiên và tự động cày 32 game...';

        this.credentials.refreshToken = session.refreshToken;
        this.credentials.username = session.accountName || this.credentials.username || `SteamID_${steamId}`;
        this.saveConfig(this.credentials.username, this.credentials.password, session.refreshToken);

        // Lưu vào Vault
        this.addOrUpdateSavedAccount({
          id: steamId || this.credentials.username,
          username: this.credentials.username,
          steamId64: steamId,
          refreshToken: session.refreshToken
        });

        try {
          if (this.client) this.client.logOff();
        } catch (e) {}

        setTimeout(() => {
          this.attemptLogin();
        }, 1200);
      });

      session.on('timeout', () => {
        this.qrStatus.state = 'expired';
        this.qrStatus.message = 'Mã QR đã hết hạn. Vui lòng bấm tạo mã mới.';
      });

      session.on('error', (err) => {
        this.qrStatus.state = 'error';
        this.qrStatus.message = `Lỗi xác thực QR: ${err.message}`;
      });

      return { success: true, qrStatus: this.qrStatus };
    } catch (err) {
      this.qrStatus.state = 'error';
      this.qrStatus.message = `Không thể tạo mã QR: ${err.message}`;
      return { success: false, message: err.message };
    }
  }

  getQrStatus() {
    return this.qrStatus;
  }

  cancelQrLogin() {
    if (this.activeQrSession) {
      try {
        this.activeQrSession.cancelLoginAttempt();
      } catch (e) {}
      this.activeQrSession = null;
    }
    this.qrStatus = {
      state: 'idle',
      message: 'Đã hủy phiên QR.',
      qrDataUrl: '',
      qrUrl: '',
      expiresAt: null
    };
    return { success: true };
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
      configured: Boolean(this.credentials.refreshToken || (this.credentials.username && this.credentials.password)),
      hasRefreshToken: Boolean(this.credentials.refreshToken),
      isRunning: this.isRunning,
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
      ratePerHour: this.isRunning ? GAMES_LIST.length : 0,
      ratePerDay: this.isRunning ? (GAMES_LIST.length * 24) : 0,
      gamesCount: GAMES_LIST.length,
      games: GAMES_LIST,
      qrStatus: this.qrStatus,
      savedAccounts: this.getSavedAccounts()
    };
  }
}

module.exports = new SteamBoosterService();
