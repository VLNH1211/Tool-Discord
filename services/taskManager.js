const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const discordClient = require('./discordClient');
const detectables = require('./detectables');
const gateway = require('./gateway');

const PLAYTIME_FILE = path.join(__dirname, '../data/playtime_stats.json');

class TaskManager {
  constructor() {
    this.sseClients = new Set();
    this.logs = [];
    this.maxLogs = 300;

    this.user = {
      token: null,
      analyticsToken: null,
      profile: null
    };

    this.settings = {
      enableGatewayPresence: true,
      diversityDelayMs: 1200,
      diversityJitterMs: 600,
      playtimeIntervalSec: 30
    };

    this.accumulatedPlaytimeSeconds = 0;
    this.targetPlaytimeHours = 5000;
    this._loadPlaytimeStats();

    this.diversityTask = {
      status: 'idle', // 'idle' | 'running' | 'paused' | 'stopped' | 'completed'
      current: 0,
      target: 100,
      currentGame: null,
      successCount: 0,
      errorCount: 0,
      recentSpoofed: [],
      shouldPause: false,
      shouldStop: false
    };

    this.playtimeTask = {
      status: 'idle', // 'idle' | 'running' | 'stopped'
      game: null,
      sessionId: null,
      sequence: 0,
      totalHeartbeats: 0,
      elapsedSeconds: 0,
      startedAt: null,
      timer: null,
      intervalSec: 30,
      speedMultiplier: 1,
      autoHourlyInject: true,
      autoInjectHours: 10,
      lastAutoInjectHour: 0,
      autoInjectCount: 0,
      autoInjectTotalHours: 0
    };

    this.turboPlaytime = {
      status: 'idle', // 'idle' | 'running' | 'completed' | 'error'
      gameName: '',
      targetHours: 0,
      currentHours: 0,
      percent: 0,
      currentBatch: 0,
      totalBatches: 0,
      message: ''
    };

    this.questTask = {
      status: 'idle', // 'idle' | 'running' | 'stopped' | 'completed'
      mode: 'parallel', // 'parallel' | 'single' | 'all'
      questId: null,
      questName: null,
      gameId: null,
      gameName: null,
      executable: null,
      targetSeconds: 900,
      elapsedSeconds: 0,
      sessionId: null,
      sequence: 0,
      timer: null,
      queueIndex: 0,
      queueTotal: 0,
      activeQuests: [],
      shouldStop: false
    };
    this._questResolve = null;

    this.purgeTask = {
      status: 'idle', // 'idle' | 'running' | 'stopped' | 'completed'
      channelId: null,
      totalScanned: 0,
      totalDeleted: 0,
      shouldStop: false
    };

    // Attach gateway logger
    gateway.setLogger((msg, type) => {
      this.addLog(msg, type);
    });
  }

  // --- SSE & LOGGING ---

  addSSEClient(res) {
    this.sseClients.add(res);
    // Send initial status and cached logs
    this.sendSSE(res, 'init', {
      user: this.user.profile,
      settings: this.settings,
      diversity: this.getDiversityStatus(),
      playtime: this.getPlaytimeStatus(),
      quest: this.getQuestStatus(),
      purge: this.getPurgeStatus(),
      autoResponder: gateway.getAutoResponderSettings(),
      logs: this.logs.slice(-100)
    });
  }

  removeSSEClient(res) {
    this.sseClients.delete(res);
  }

  broadcastSSE(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch (e) {
        this.sseClients.delete(client);
      }
    }
  }

  broadcastEvent(event, data) {
    this.broadcastSSE(event, data);
  }

  sendSSE(client, event, data) {
    try {
      client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      this.sseClients.delete(client);
    }
  }

  addLog(message, level = 'INFO', meta = null) {
    const timestamp = new Date().toLocaleTimeString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour12: false
    });
    const logItem = {
      id: uuidv4().slice(0, 8),
      time: timestamp,
      timestamp: Date.now(),
      level, // INFO, SUCCESS, WARN, ERROR, SCIENCE, DIVERSITY, QUEST, GATEWAY
      message,
      meta
    };

    this.logs.push(logItem);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    console.log(`[${timestamp}] [${level}] ${message}`);
    this.broadcastSSE('log', logItem);
  }

  clearLogs() {
    this.logs = [];
    this.broadcastSSE('logs_cleared', {});
  }

  // --- AUTH & USER PROFILE ---

  setUser(token, analyticsToken, profile) {
    this.user.token = token;
    this.user.analyticsToken = analyticsToken;
    this.user.profile = profile;

    this._loadPlaytimeStats();

    if (this.settings.enableGatewayPresence && token) {
      gateway.connect(token);
    }

    this.broadcastSSE('user_update', {
      user: profile,
      hasAnalyticsToken: Boolean(analyticsToken)
    });
    this.broadcastSSE('playtime_status', this.getPlaytimeStatus());
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    if (newSettings.enableGatewayPresence !== undefined) {
      if (newSettings.enableGatewayPresence && this.user.token) {
        gateway.connect(this.user.token);
      } else {
        gateway.disconnect();
      }
    }
    this.broadcastSSE('settings_update', this.settings);
    this.addLog(`Cấu hình đã được cập nhật thành công.`, 'INFO');
  }

  // --- GAME DIVERSITY 100+ BOOSTER ---

  getDiversityStatus() {
    return {
      status: this.diversityTask.status,
      current: this.diversityTask.current,
      target: this.diversityTask.target,
      currentGame: this.diversityTask.currentGame,
      successCount: this.diversityTask.successCount,
      errorCount: this.diversityTask.errorCount,
      recentSpoofed: this.diversityTask.recentSpoofed.slice(-10)
    };
  }

  async startDiversity({ targetCount = 100, delayMs = 1200, jitterMs = 500 }) {
    if (!this.user.token || !this.user.analyticsToken) {
      throw new Error('Chưa đăng nhập Discord Token hoặc thiếu Analytics Token!');
    }

    if (this.diversityTask.status === 'running') {
      throw new Error('Tiến trình Game Diversity đang chạy!');
    }

    const pool = detectables.getRandomUniqueGames(targetCount);
    if (pool.length === 0) {
      throw new Error('Không tải được danh sách trò chơi hợp lệ từ Discord detectables.');
    }

    this.diversityTask.status = 'running';
    this.diversityTask.current = 0;
    this.diversityTask.target = Math.min(targetCount, pool.length);
    this.diversityTask.successCount = 0;
    this.diversityTask.errorCount = 0;
    this.diversityTask.recentSpoofed = [];
    this.diversityTask.shouldPause = false;
    this.diversityTask.shouldStop = false;

    this.addLog(`🚀 Bắt đầu giả lập Game Diversity: Mục tiêu ${this.diversityTask.target} games.`, 'DIVERSITY');
    this.broadcastSSE('diversity_status', this.getDiversityStatus());

    // Execute async loop
    this._runDiversityLoop(pool, delayMs, jitterMs);
    return { success: true, target: this.diversityTask.target };
  }

  pauseDiversity() {
    if (this.diversityTask.status !== 'running') return;
    this.diversityTask.status = 'paused';
    this.diversityTask.shouldPause = true;
    this.addLog('⏸ Đã tạm dừng tiến trình Game Diversity.', 'WARN');
    this.broadcastSSE('diversity_status', this.getDiversityStatus());
  }

  resumeDiversity() {
    if (this.diversityTask.status !== 'paused') return;
    this.diversityTask.status = 'running';
    this.diversityTask.shouldPause = false;
    this.addLog('▶ Tiếp tục tiến trình Game Diversity.', 'INFO');
    this.broadcastSSE('diversity_status', this.getDiversityStatus());
  }

  stopDiversity() {
    this.diversityTask.shouldStop = true;
    this.diversityTask.status = 'stopped';
    this.addLog('⏹ Đã dừng tiến trình Game Diversity.', 'WARN');
    this.broadcastSSE('diversity_status', this.getDiversityStatus());
  }

  async _runDiversityLoop(games, baseDelay, jitter) {
    for (let i = 0; i < games.length; i++) {
      if (this.diversityTask.shouldStop) {
        break;
      }

      while (this.diversityTask.shouldPause) {
        if (this.diversityTask.shouldStop) break;
        await new Promise(r => setTimeout(r, 500));
      }

      if (this.diversityTask.shouldStop) break;

      const game = games[i];
      this.diversityTask.current = i + 1;
      this.diversityTask.currentGame = game;

      const sessionId = uuidv4();
      const events = discordClient.createGameDiversityEvents(game, sessionId);

      try {
        const result = await discordClient.sendScienceEvents(
          this.user.token,
          this.user.analyticsToken,
          events
        );

        if (result.success) {
          this.diversityTask.successCount++;
          const entry = {
            index: i + 1,
            name: game.name,
            executable: game.executable,
            id: game.id,
            time: new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false })
          };
          this.diversityTask.recentSpoofed.push(entry);

          this.addLog(
            `[${i + 1}/${this.diversityTask.target}] Spoofed thành công: "${game.name}" (${game.executable})`,
            'SUCCESS'
          );

          // Update Gateway presence briefly if enabled
          if (this.settings.enableGatewayPresence) {
            gateway.updatePresence(game.name, game.id);
          }
        } else {
          this.diversityTask.errorCount++;
          if (result.status === 429) {
            const waitSec = Math.ceil(result.retryAfter || 5);
            this.addLog(`⚠️ Bị Discord Rate Limit (429)! Đang nghỉ ${waitSec} giây để bảo vệ tài khoản...`, 'WARN');
            await new Promise(r => setTimeout(r, waitSec * 1000 + 1000));
            // Retry current game
            i--;
            continue;
          } else {
            this.addLog(`❌ Lỗi giả lập game "${game.name}": ${result.message}`, 'ERROR');
          }
        }
      } catch (err) {
        this.diversityTask.errorCount++;
        this.addLog(`❌ Ngoại lệ khi gửi science: ${err.message}`, 'ERROR');
      }

      this.broadcastSSE('diversity_status', this.getDiversityStatus());

      // Safe sleep with randomized jitter
      const actualDelay = baseDelay + Math.floor(Math.random() * jitter);
      await new Promise(r => setTimeout(r, actualDelay));
    }

    if (!this.diversityTask.shouldStop) {
      this.diversityTask.status = 'completed';
      this.addLog(
        `🎉 Hoàn thành Game Diversity Booster! Tổng cộng: ${this.diversityTask.successCount}/${this.diversityTask.target} games đã được kích hoạt trên hệ thống Discord Analytics.`,
        'SUCCESS'
      );
    }

    this.diversityTask.currentGame = null;
    this.broadcastSSE('diversity_status', this.getDiversityStatus());

    if (this.settings.enableGatewayPresence) {
      gateway.clearPresence();
    }
  }

  // --- PLAYTIME HOURS AFK BOOSTER ---

  _loadPlaytimeStats() {
    try {
      if (fs.existsSync(PLAYTIME_FILE)) {
        const raw = fs.readFileSync(PLAYTIME_FILE, 'utf8');
        const data = JSON.parse(raw);
        const currentId = this.user.profile?.id || 'default';
        const userStats = data.accounts?.[currentId] || data;
        this.accumulatedPlaytimeSeconds = userStats.accumulatedSeconds || 0;
        this.targetPlaytimeHours = userStats.targetHours || 5000;
      }
    } catch (e) {
      this.accumulatedPlaytimeSeconds = 0;
      this.targetPlaytimeHours = 5000;
    }
  }

  _savePlaytimeStats() {
    try {
      fs.mkdirSync(path.dirname(PLAYTIME_FILE), { recursive: true });
      const currentId = this.user.profile?.id || 'default';
      const currentUsername = this.user.profile?.username || 'user';

      let data = {};
      if (fs.existsSync(PLAYTIME_FILE)) {
        try {
          data = JSON.parse(fs.readFileSync(PLAYTIME_FILE, 'utf8'));
        } catch (e) {}
      }
      if (!data.accounts) data.accounts = {};

      const currentTotalSeconds = this.accumulatedPlaytimeSeconds + (this.playtimeTask.status === 'running' ? this.playtimeTask.elapsedSeconds : 0);

      data.accounts[currentId] = {
        username: currentUsername,
        accumulatedSeconds: currentTotalSeconds,
        targetHours: this.targetPlaytimeHours,
        lastUpdated: new Date().toISOString()
      };
      data.accumulatedSeconds = currentTotalSeconds;
      data.targetHours = this.targetPlaytimeHours;

      fs.writeFileSync(PLAYTIME_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      // ignore
    }
  }

  getPlaytimeStatus() {
    return {
      status: this.playtimeTask.status,
      game: this.playtimeTask.game,
      sessionId: this.playtimeTask.sessionId,
      sequence: this.playtimeTask.sequence,
      totalHeartbeats: this.playtimeTask.totalHeartbeats,
      elapsedSeconds: this.playtimeTask.elapsedSeconds,
      accumulatedSeconds: this.accumulatedPlaytimeSeconds + this.playtimeTask.elapsedSeconds,
      targetHours: this.targetPlaytimeHours,
      startedAt: this.playtimeTask.startedAt,
      intervalSec: this.playtimeTask.intervalSec,
      speedMultiplier: this.playtimeTask.speedMultiplier || 1,
      autoHourlyInject: Boolean(this.playtimeTask.autoHourlyInject),
      autoInjectHours: parseInt(this.playtimeTask.autoInjectHours) || 10,
      autoInjectCount: parseInt(this.playtimeTask.autoInjectCount) || 0,
      autoInjectTotalHours: parseInt(this.playtimeTask.autoInjectTotalHours) || 0,
      nextAutoInjectInSeconds: this.playtimeTask.status === 'running' && this.playtimeTask.autoHourlyInject
        ? Math.max(0, 3600 - (this.playtimeTask.elapsedSeconds % 3600))
        : 0,
      turbo: this.turboPlaytime
    };
  }

  async startPlaytime({ gameId, gameName, executable, intervalSec = 30, targetHours = 5000, speedMultiplier = 1, autoHourlyInject = true, autoInjectHours = 10 }) {
    if (!this.user.token || !this.user.analyticsToken) {
      throw new Error('Chưa đăng nhập Discord Token hoặc thiếu Analytics Token!');
    }

    if (this.playtimeTask.status === 'running') {
      throw new Error('Tiến trình Playtime Booster đang hoạt động!');
    }

    if (targetHours) {
      this.targetPlaytimeHours = parseInt(targetHours) || 5000;
      this._savePlaytimeStats();
    }

    const game = {
      id: String(gameId || '730'),
      name: gameName || 'Counter-Strike 2',
      executable: executable || 'cs2.exe'
    };

    const multiplier = Math.max(1, parseInt(speedMultiplier) || 1);
    const sessionId = uuidv4();
    this.playtimeTask.status = 'running';
    this.playtimeTask.game = game;
    this.playtimeTask.sessionId = sessionId;
    this.playtimeTask.sequence = 1;
    this.playtimeTask.totalHeartbeats = 0;
    this.playtimeTask.elapsedSeconds = 0;
    this.playtimeTask.sessionElapsedSeconds = 0;
    this.playtimeTask.startedAt = Date.now();
    this.playtimeTask.intervalSec = Math.max(10, parseInt(intervalSec) || 30);
    this.playtimeTask.speedMultiplier = multiplier;
    this.playtimeTask.autoHourlyInject = autoHourlyInject !== undefined ? Boolean(autoHourlyInject) : true;
    this.playtimeTask.autoInjectHours = Math.max(1, parseInt(autoInjectHours) || 10);
    this.playtimeTask.lastAutoInjectHour = 0;
    this.playtimeTask.autoInjectCount = 0;
    this.playtimeTask.autoInjectTotalHours = 0;

    const speedDesc = multiplier > 1 ? ` [⚡ Turbo ${multiplier}x Tốc Độ]` : '';
    const autoDesc = this.playtimeTask.autoHourlyInject ? ` [⚡ Tự động nạp: +${this.playtimeTask.autoInjectHours}h/1h]` : '';
    this.addLog(
      `🎮 Khởi động AFK Playtime${speedDesc}${autoDesc}: "${game.name}" (Heartbeat mỗi ${this.playtimeTask.intervalSec}s). Session ID: ${sessionId.slice(0, 8)}...`,
      'SCIENCE'
    );

    if (this.settings.enableGatewayPresence) {
      gateway.updatePresence(game.name, game.id);
    }

    // Send initial launch + heartbeat
    await this._sendPlaytimeHeartbeat(true);

    // Setup timer
    this.playtimeTask.timer = setInterval(async () => {
      const tickSec = (this.playtimeTask.intervalSec * this.playtimeTask.speedMultiplier);
      this.playtimeTask.elapsedSeconds += tickSec;
      this.playtimeTask.sessionElapsedSeconds = (this.playtimeTask.sessionElapsedSeconds || 0) + tickSec;

      // Session Rotation: Rotate and close session every 3600 seconds (1 hour)
      // This sends final_heartbeat: true to ensure Discord permanently commits the completed hour into badges!
      if (this.playtimeTask.sessionElapsedSeconds >= 3600) {
        this.addLog(`🔄 [Session Rotate] Đã cày tròn 1 giờ phiên. Đang chốt sổ phiên cũ lên Discord và mở phiên mới...`, 'INFO');
        await this._sendPlaytimeHeartbeat(false, true);

        this.playtimeTask.sessionId = uuidv4();
        this.playtimeTask.sequence = 1;
        this.playtimeTask.sessionElapsedSeconds = 0;
        await this._sendPlaytimeHeartbeat(true, false);
      } else {
        await this._sendPlaytimeHeartbeat(false, false);
      }

      // Check Auto-Hourly Injection: trigger every 3600 seconds of elapsed playtime
      if (this.playtimeTask.autoHourlyInject && this.playtimeTask.status === 'running') {
        const currentHour = Math.floor(this.playtimeTask.elapsedSeconds / 3600);
        if (currentHour > (this.playtimeTask.lastAutoInjectHour || 0)) {
          const hoursPassed = currentHour - (this.playtimeTask.lastAutoInjectHour || 0);
          this.playtimeTask.lastAutoInjectHour = currentHour;
          const hoursToInject = (this.playtimeTask.autoInjectHours || 10) * hoursPassed;
          this._performAutoHourlyInjection(hoursToInject, currentHour).catch(err => {
            console.error('Auto hourly injection error:', err);
          });
        }
      }

      this.broadcastSSE('playtime_status', this.getPlaytimeStatus());
    }, this.playtimeTask.intervalSec * 1000);

    this.broadcastSSE('playtime_status', this.getPlaytimeStatus());
    return { success: true, game, speedMultiplier: multiplier, autoHourlyInject: this.playtimeTask.autoHourlyInject, autoInjectHours: this.playtimeTask.autoInjectHours };
  }

  updateAutoInjectSettings({ enabled, hours }) {
    if (enabled !== undefined) {
      this.playtimeTask.autoHourlyInject = Boolean(enabled);
    }
    if (hours !== undefined) {
      this.playtimeTask.autoInjectHours = Math.max(1, parseInt(hours) || 10);
    }
    // If currently running, sync lastAutoInjectHour to current elapsed hour so it won't inject duplicate backlog
    if (this.playtimeTask.status === 'running') {
      this.playtimeTask.lastAutoInjectHour = Math.floor(this.playtimeTask.elapsedSeconds / 3600);
    }
    this.addLog(`⚙️ Cấu hình Tự Động Bơm Giờ: ${this.playtimeTask.autoHourlyInject ? 'ĐÃ BẬT' : 'ĐÃ TẮT'} (Cứ 1h trôi qua tự động nạp: +${this.playtimeTask.autoInjectHours}h).`, 'INFO');
    this.broadcastSSE('playtime_status', this.getPlaytimeStatus());
    return {
      success: true,
      autoHourlyInject: this.playtimeTask.autoHourlyInject,
      autoInjectHours: this.playtimeTask.autoInjectHours
    };
  }

  async _performAutoHourlyInjection(hoursToInject, currentHour) {
    if (!this.user.token || !this.user.analyticsToken) return;
    const game = this.playtimeTask.game;
    if (!game) return;

    const hours = Math.max(1, parseInt(hoursToInject) || 10);
    const dayOffset = (this.playtimeTask.autoInjectCount || 0) + 1;
    this.addLog(`⚡ [TỰ ĐỘNG BƠM GIỜ] Đã cày tròn ${currentHour} tiếng AFK liên tục! Đang tự động nạp ngầm +${hours} giờ chơi cho "${game.name}" vào ${dayOffset} ngày trước (Tránh trùng lặp mốc thời gian, chuẩn PE Fingerprint)...`, 'WARN');

    try {
      const events = discordClient.buildSlicedHistoryEvents(game, this.user.profile?.id, hours, { maxHoursPerDay: 10, startDayOffset: dayOffset });
      const res = await discordClient.sendScienceEvents(this.user.token, this.user.analyticsToken, events);

      if (res.success) {
        this.accumulatedPlaytimeSeconds += (hours * 3600);
        this.playtimeTask.autoInjectCount = (this.playtimeTask.autoInjectCount || 0) + 1;
        this.playtimeTask.autoInjectTotalHours = (this.playtimeTask.autoInjectTotalHours || 0) + hours;
        this._savePlaytimeStats();

        const currentTotal = ((this.accumulatedPlaytimeSeconds + this.playtimeTask.elapsedSeconds) / 3600).toFixed(2);
        this.addLog(`🎉 [TỰ ĐỘNG NẠP THÀNH CÔNG] Đã nạp thành công +${hours}h vào Discord (Mốc ${dayOffset} ngày trước, không trùng lặp)! Tổng tích lũy: ${currentTotal}h.`, 'SUCCESS');
        this.broadcastSSE('playtime_status', this.getPlaytimeStatus());
      } else {
        this.addLog(`⚠️ [TỰ ĐỘNG NẠP Cảnh báo] Discord từ chối nạp tự động +${hours}h: ${res.message}`, 'WARN');
      }
    } catch (err) {
      this.addLog(`❌ [TỰ ĐỘNG NẠP Lỗi] Ngoại lệ khi nạp tự động: ${err.message}`, 'ERROR');
    }
  }

  async _sendPlaytimeHeartbeat(isInitial = false, isFinal = false) {
    try {
      // Auto-heal Gateway connection & continuously enforce Game Presence on Discord profile
      if (this.settings.enableGatewayPresence && this.user.token) {
        if (!gateway.isConnected) {
          gateway.connect(this.user.token);
        }
        if (this.playtimeTask.game && (!gateway.currentActivity || gateway.currentActivity.name !== this.playtimeTask.game.name)) {
          gateway.updatePresence(this.playtimeTask.game.name, this.playtimeTask.game.id);
        }
      }

      const multiplier = this.playtimeTask.speedMultiplier || 1;
      const durationMs = this.playtimeTask.intervalSec * 1000 * multiplier;
      const events = discordClient.createPlaytimeHeartbeatEvent(
        this.playtimeTask.game,
        this.playtimeTask.sessionId,
        this.playtimeTask.sequence,
        isInitial,
        durationMs,
        isFinal,
        this.user.profile?.id
      );

      const result = await discordClient.sendScienceEvents(
        this.user.token,
        this.user.analyticsToken,
        events
      );

      if (result.success) {
        this.playtimeTask.totalHeartbeats++;
        this.playtimeTask.sequence++;
        const totalHours = ((this.accumulatedPlaytimeSeconds + this.playtimeTask.elapsedSeconds) / 3600).toFixed(2);
        this.addLog(
          `⏱ [Playtime] Heartbeat #${this.playtimeTask.totalHeartbeats} (${multiplier}x) cho "${this.playtimeTask.game.name}" thành công! Tổng tích lũy hiện tại: ${totalHours} giờ.`,
          'SCIENCE'
        );
        if (this.playtimeTask.totalHeartbeats % 3 === 0) {
          this._savePlaytimeStats();
        }
      } else {
        this.addLog(`⚠️ Playtime heartbeat cảnh báo: ${result.message}`, 'WARN');
      }
    } catch (err) {
      this.addLog(`❌ Lỗi gửi Playtime heartbeat: ${err.message}`, 'ERROR');
    }
  }

  /**
   * TURBO INSTANT INJECTOR: Bơm siêu tốc trực tiếp hàng trăm / hàng nghìn giờ lên Discord
   * Sử dụng công nghệ Daily Session Slicing + 146-byte PE Fingerprint
   */
  async turboInjectPlaytime({ gameId, gameName, executable, hoursToAdd = 5000 }) {
    if (!this.user.token || !this.user.analyticsToken) {
      throw new Error('Chưa đăng nhập Discord Token hoặc thiếu Analytics Token!');
    }

    const hours = parseInt(hoursToAdd) || 5000;
    const game = {
      id: String(gameId || '700136079562375258'),
      name: gameName || 'Counter-Strike 2',
      executable: executable || 'cs2.exe'
    };

    // Build verified sliced history events across recent days (max 20h/day to evade single-day anomaly check)
    const allEvents = discordClient.buildSlicedHistoryEvents(game, this.user.profile?.id, hours, { maxHoursPerDay: 20, startDayOffset: 1 });
    const totalDays = Math.ceil(hours / 20);

    // Each day has 3 events (launch, initial heartbeat, final heartbeat)
    // Send in batches of 60 events (20 days per batch)
    const eventsPerBatch = 60;
    const totalBatches = Math.ceil(allEvents.length / eventsPerBatch);

    this.turboPlaytime = {
      status: 'running',
      gameName: game.name,
      targetHours: hours,
      currentHours: 0,
      percent: 0,
      currentBatch: 0,
      totalBatches: totalBatches,
      message: `Đang khởi tạo gói bơm siêu tốc +${hours.toLocaleString()} giờ (${totalDays} ngày phân lát lịch sử, chuẩn PE Fingerprint)...`
    };

    this.addLog(`⚡ [TURBO INJECTION] Bắt đầu kích hoạt gói bơm siêu tốc +${hours.toLocaleString()} GIỜ cho game "${game.name}" (${totalDays} ngày phân lát, ${totalBatches} đợt nạp chuẩn Windows PE Fingerprint)...`, 'WARN');
    this.broadcastSSE('playtime_status', this.getPlaytimeStatus());

    let totalSuccessHours = 0;
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const chunkEvents = allEvents.slice(batchIndex * eventsPerBatch, (batchIndex + 1) * eventsPerBatch);
      const chunkDays = Math.floor(chunkEvents.length / 3);
      const chunkHours = Math.round(chunkDays * (hours / totalDays));

      this.turboPlaytime.currentBatch = batchIndex + 1;
      this.turboPlaytime.message = `Đang gửi đợt ${batchIndex + 1}/${totalBatches} (+${chunkHours}h phân lát lịch sử)...`;
      this.broadcastSSE('playtime_status', this.getPlaytimeStatus());

      const res = await discordClient.sendScienceEvents(this.user.token, this.user.analyticsToken, chunkEvents);

      if (res.success) {
        totalSuccessHours += chunkHours;
        this.turboPlaytime.currentHours = Math.min(hours, totalSuccessHours);
        this.turboPlaytime.percent = Math.min(100, Math.round(((batchIndex + 1) / totalBatches) * 100));
        this.turboPlaytime.message = `Đã nạp thành công đợt ${batchIndex + 1}/${totalBatches} (+${chunkHours}h)!`;
        this.broadcastSSE('playtime_status', this.getPlaytimeStatus());

        this.addLog(`⚡ [TURBO] Đã bơm thành công đợt ${batchIndex + 1}/${totalBatches} (+${chunkHours}h chuẩn PE Fingerprint)! Tiến độ: ${this.turboPlaytime.percent}%.`, 'SUCCESS');
      } else {
        this.turboPlaytime.status = 'error';
        this.turboPlaytime.message = `Discord từ chối đợt ${batchIndex + 1}: ${res.message}`;
        this.broadcastSSE('playtime_status', this.getPlaytimeStatus());
        this.addLog(`⚠️ [TURBO] Discord từ chối đợt bơm ${batchIndex + 1}: ${res.message}`, 'WARN');
        break;
      }

      if (batchIndex < totalBatches - 1) {
        await new Promise(r => setTimeout(r, 500)); // Safe stagger
      }
    }

    if (this.settings.enableGatewayPresence) {
      gateway.updatePresence(game.name, game.id);
    }

    this.accumulatedPlaytimeSeconds += (totalSuccessHours * 3600);
    this.turboPlaytime.status = totalSuccessHours > 0 ? 'completed' : 'error';
    this.turboPlaytime.currentHours = totalSuccessHours;
    this.turboPlaytime.percent = 100;
    this.turboPlaytime.message = `Hoàn tất bơm +${totalSuccessHours.toLocaleString()} giờ chuẩn Windows PE Fingerprint lên Discord!`;

    this._savePlaytimeStats();
    this.broadcastSSE('playtime_status', this.getPlaytimeStatus());
    this.addLog(`👑 [TURBO HOÀN TẤT] Bơm thành công tổng cộng +${totalSuccessHours.toLocaleString()} giờ chơi chuẩn Windows PE Fingerprint lên máy chủ Discord!`, 'SUCCESS');

    return {
      success: true,
      addedHours: totalSuccessHours,
      totalAccumulatedHours: (this.accumulatedPlaytimeSeconds / 3600).toFixed(1)
    };
  }

  /**
   * TURBO DIVERSITY INJECTOR: Bơm siêu tốc hàng trăm / hàng nghìn game khác nhau vào Discord Analytics
   */
  async turboInjectDiversity({ targetCount = 100 }) {
    if (!this.user.token || !this.user.analyticsToken) {
      throw new Error('Chưa đăng nhập Discord Token hoặc thiếu Analytics Token!');
    }

    const count = Math.min(Math.max(parseInt(targetCount) || 100, 1), 25000);
    const pool = detectables.getRandomUniqueGames(count);
    if (pool.length === 0) {
      throw new Error('Không tải được danh sách trò chơi hợp lệ từ Discord detectables.');
    }

    this.diversityTask.status = 'running';
    this.diversityTask.current = 0;
    this.diversityTask.target = Math.min(count, pool.length);
    this.diversityTask.successCount = 0;
    this.diversityTask.errorCount = 0;
    this.diversityTask.recentSpoofed = [];
    this.diversityTask.shouldPause = false;
    this.diversityTask.shouldStop = false;

    this.addLog(`⚡ [TURBO DIVERSITY] Bắt đầu kích hoạt gói bơm siêu tốc +${this.diversityTask.target.toLocaleString()} GAME để mở khóa Huy hiệu Thuyết Phổ Quát (Thần Thoại)...`, 'WARN');
    this.broadcastSSE('diversity_status', this.getDiversityStatus());

    // Execute background injection loop
    (async () => {
      const batchSize = 20;
      for (let i = 0; i < pool.length; i += batchSize) {
        if (this.diversityTask.shouldStop) break;

        const chunk = pool.slice(i, i + batchSize);
        let events = [];
        for (const g of chunk) {
          events.push(...discordClient.createGameDiversityEvents(g));
        }

        try {
          const res = await discordClient.sendScienceEvents(this.user.token, this.user.analyticsToken, events);
          if (res.success) {
            this.diversityTask.successCount += chunk.length;
            this.diversityTask.current = this.diversityTask.successCount;
            for (const g of chunk) {
              this.diversityTask.recentSpoofed.push({
                index: this.diversityTask.recentSpoofed.length + 1,
                name: g.name,
                executable: g.executable,
                id: g.id,
                time: new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false })
              });
            }
            this.addLog(`⚡ [TURBO DIVERSITY] Đã nạp đợt +${chunk.length} game. Tiến trình: ${this.diversityTask.successCount} / ${this.diversityTask.target} games.`, 'SUCCESS');
          } else {
            if (res.status === 429) {
              const waitSec = Math.ceil(res.retryAfter || 5);
              this.addLog(`⚠️ Bị Discord Rate Limit (429)! Chờ ${waitSec} giây...`, 'WARN');
              await new Promise(r => setTimeout(r, waitSec * 1000 + 1000));
              i -= batchSize;
              continue;
            } else {
              this.diversityTask.errorCount += chunk.length;
              this.addLog(`❌ Lỗi nạp đợt game: ${res.message}`, 'ERROR');
            }
          }
        } catch (err) {
          this.diversityTask.errorCount += chunk.length;
          this.addLog(`❌ Ngoại lệ khi nạp game: ${err.message}`, 'ERROR');
        }

        this.broadcastSSE('diversity_status', this.getDiversityStatus());

        if (i + batchSize < pool.length) {
          await new Promise(r => setTimeout(r, 120));
        }
      }

      this.diversityTask.status = 'completed';
      this.diversityTask.currentGame = null;
      this.broadcastSSE('diversity_status', this.getDiversityStatus());
      this.addLog(`🎉 [TURBO DIVERSITY HOÀN TẤT] Tổng cộng ${this.diversityTask.successCount.toLocaleString()} / ${this.diversityTask.target.toLocaleString()} games đã nạp thành công lên Discord! Hãy mở Discord kiểm tra huy hiệu!`, 'SUCCESS');
    })();

    return {
      success: true,
      target: this.diversityTask.target
    };
  }

  stopPlaytime() {
    if (this.playtimeTask.status !== 'running') return;

    // Send final heartbeat to Discord Science to close and commit the active session
    if (this.user.token && this.user.analyticsToken && this.playtimeTask.game) {
      try {
        const finalEvents = discordClient.createPlaytimeHeartbeatEvent(
          this.playtimeTask.game,
          this.playtimeTask.sessionId,
          this.playtimeTask.sequence + 1,
          false,
          this.playtimeTask.intervalSec * 1000,
          true, // isFinal = true: commits session in Discord big data pipeline
          this.user.profile?.id
        );
        discordClient.sendScienceEvents(this.user.token, this.user.analyticsToken, finalEvents).catch(err => {
          console.warn('Final heartbeat warning on stop:', err.message);
        });
      } catch (_) {}
    }

    if (this.playtimeTask.timer) {
      clearInterval(this.playtimeTask.timer);
      this.playtimeTask.timer = null;
    }

    const gameName = this.playtimeTask.game ? this.playtimeTask.game.name : 'Unknown';
    const totalSecs = this.playtimeTask.elapsedSeconds;
    const hours = (totalSecs / 3600).toFixed(2);

    this.playtimeTask.status = 'stopped';
    this.accumulatedPlaytimeSeconds += this.playtimeTask.elapsedSeconds;
    this._savePlaytimeStats();
    this.addLog(`⏹ Đã dừng AFK Playtime cho "${gameName}". Tổng thời gian phiên: ${hours} giờ (${totalSecs}s). Tổng tích lũy: ${(this.accumulatedPlaytimeSeconds / 3600).toFixed(2)} giờ.`, 'WARN');
    this.broadcastSSE('playtime_status', this.getPlaytimeStatus());

    if (this.settings.enableGatewayPresence) {
      gateway.clearPresence();
    }
  }

  // --- DISCORD QUESTS AUTOMATION (ĐÃ VÔ HIỆU HÓA HOÀN TOÀN ĐỂ BẢO VỆ TÀI KHOẢN) ---

  getQuestStatus() {
    return {
      status: 'disabled',
      mode: 'parallel',
      questId: null,
      questName: null,
      gameName: null,
      targetSeconds: 0,
      elapsedSeconds: 0,
      percentage: 0,
      queueIndex: 0,
      queueTotal: 0,
      activeQuests: []
    };
  }

  async startAutoFarmAllQuests(userToken) {
    this.addLog('⚠️ Tính năng Discord Quests đã bị gỡ bỏ vĩnh viễn để bảo vệ an toàn tài khoản!', 'WARN');
    return {
      success: false,
      message: 'Tính năng Discord Quests đã bị gỡ bỏ vĩnh viễn để bảo vệ an toàn tài khoản.'
    };
  }

  async startQuestFarm(options) {
    this.addLog('⚠️ Tính năng Discord Quests đã bị gỡ bỏ vĩnh viễn để bảo vệ an toàn tài khoản!', 'WARN');
    return {
      success: false,
      message: 'Tính năng Discord Quests đã bị gỡ bỏ vĩnh viễn để bảo vệ an toàn tài khoản.'
    };
  }

  stopQuestFarm() {
    this.questTask.shouldStop = true;
    if (this.questTask.timer) {
      clearInterval(this.questTask.timer);
      this.questTask.timer = null;
    }
    this.questTask.status = 'idle';
    this.questTask.activeQuests = [];
    if (this.settings.enableGatewayPresence) {
      gateway.clearPresence();
    }
    this.broadcastSSE('quest_status', this.getQuestStatus());
  }

  // ==========================================
  // GHOST MESSAGE PURGER (MASS DELETE MESSAGES)
  // ==========================================

  getPurgeStatus() {
    return {
      status: this.purgeTask.status,
      channelId: this.purgeTask.channelId,
      totalScanned: this.purgeTask.totalScanned,
      totalDeleted: this.purgeTask.totalDeleted
    };
  }

  async startMessagePurge({ channelId, delayMs = 1200 }) {
    if (!this.user.token) {
      throw new Error('Chưa đăng nhập Discord Token!');
    }
    if (!channelId) {
      throw new Error('Vui lòng nhập Channel ID hoặc DM ID cần xóa tin nhắn!');
    }
    if (this.purgeTask.status === 'running') {
      throw new Error('Đang có tiến trình xóa tin nhắn đang chạy!');
    }

    const myUserId = this.user.profile?.id;
    if (!myUserId) {
      throw new Error('Không xác định được ID người dùng của bạn.');
    }

    this.purgeTask.status = 'running';
    this.purgeTask.channelId = channelId;
    this.purgeTask.totalScanned = 0;
    this.purgeTask.totalDeleted = 0;
    this.purgeTask.shouldStop = false;

    this.addLog(`🗑️ Bắt đầu quét và xóa tin nhắn của bạn trong kênh ID: ${channelId}...`, 'INFO');
    this.broadcastSSE('purge_status', this.getPurgeStatus());

    this._runPurgeLoop(channelId, myUserId, Math.max(800, parseInt(delayMs) || 1200));
    return { success: true };
  }

  stopMessagePurge() {
    if (this.purgeTask.status !== 'running') return;
    this.purgeTask.shouldStop = true;
    this.purgeTask.status = 'stopped';
    this.addLog('⏹ Đã dừng tiến trình xóa tin nhắn.', 'WARN');
    this.broadcastSSE('purge_status', this.getPurgeStatus());
  }

  async _runPurgeLoop(channelId, myUserId, baseDelay) {
    let beforeId = null;
    let hasMore = true;

    while (hasMore && !this.purgeTask.shouldStop) {
      const fetchRes = await discordClient.getMessages(this.user.token, channelId, beforeId, 100);
      if (!fetchRes.success || !Array.isArray(fetchRes.data) || fetchRes.data.length === 0) {
        hasMore = false;
        break;
      }

      const messages = fetchRes.data;
      this.purgeTask.totalScanned += messages.length;
      beforeId = messages[messages.length - 1].id;

      // Filter for messages sent by me
      const myMessages = messages.filter(m => m.author && m.author.id === myUserId);

      for (const msg of myMessages) {
        if (this.purgeTask.shouldStop) break;

        const delRes = await discordClient.deleteMessage(this.user.token, channelId, msg.id);
        if (delRes.success) {
          this.purgeTask.totalDeleted++;
          this.addLog(`[PURGE] Đã xóa tin nhắn ID: ${msg.id} ("${(msg.content || '[File/Ảnh]').slice(0, 30)}...")`, 'INFO');
        } else if (delRes.status === 429) {
          const waitTime = 3000;
          this.addLog(`⚠️ Bị rate-limit xóa tin nhắn. Chờ 3 giây...`, 'WARN');
          await new Promise(r => setTimeout(r, waitTime));
        }

        this.broadcastSSE('purge_status', this.getPurgeStatus());
        await new Promise(r => setTimeout(r, baseDelay + Math.floor(Math.random() * 300)));
      }

      if (messages.length < 100) {
        hasMore = false;
      }
    }

    if (!this.purgeTask.shouldStop) {
      this.purgeTask.status = 'completed';
      this.addLog(`🎉 Hoàn tất xóa tin nhắn! Đã quét: ${this.purgeTask.totalScanned} tin, đã xóa: ${this.purgeTask.totalDeleted} tin nhắn của bạn.`, 'SUCCESS');
    }
    this.broadcastSSE('purge_status', this.getPurgeStatus());
  }

  // ==========================================
  // BATCH FRIEND & GUILD OPERATIONS
  // ==========================================

  async batchRemoveRelationships(userIds, delayMs = 1200) {
    if (!this.user.token) throw new Error('Chưa đăng nhập Token!');
    this.addLog(`👥 Bắt đầu hủy quan hệ / unfriend hàng loạt cho ${userIds.length} người dùng...`, 'INFO');

    let successCount = 0;
    for (let i = 0; i < userIds.length; i++) {
      const uid = userIds[i];
      const res = await discordClient.removeRelationship(this.user.token, uid);
      if (res.success) {
        successCount++;
        this.addLog(`[${i + 1}/${userIds.length}] Đã gỡ bạn / hủy yêu cầu với User ID: ${uid}`, 'SUCCESS');
      } else {
        this.addLog(`[${i + 1}/${userIds.length}] Thất bại gỡ User ID: ${uid} (${res.message})`, 'WARN');
      }
      await new Promise(r => setTimeout(r, delayMs));
    }

    this.addLog(`🎉 Hoàn tất! Đã gỡ thành công ${successCount}/${userIds.length} người.`, 'SUCCESS');
    return { success: true, count: successCount };
  }

  async batchLeaveGuilds(guildIds, delayMs = 1500) {
    if (!this.user.token) throw new Error('Chưa đăng nhập Token!');
    this.addLog(`🏰 Bắt đầu rời hàng loạt ${guildIds.length} server...`, 'INFO');

    let successCount = 0;
    for (let i = 0; i < guildIds.length; i++) {
      const gid = guildIds[i];
      const res = await discordClient.leaveGuild(this.user.token, gid);
      if (res.success) {
        successCount++;
        this.addLog(`[${i + 1}/${guildIds.length}] Đã rời server Guild ID: ${gid}`, 'SUCCESS');
      } else {
        this.addLog(`[${i + 1}/${guildIds.length}] Thất bại rời server: ${gid} (${res.message})`, 'WARN');
      }
      await new Promise(r => setTimeout(r, delayMs));
    }

    this.addLog(`🎉 Hoàn tất rời server! Thành công ${successCount}/${guildIds.length} server.`, 'SUCCESS');
    return { success: true, count: successCount };
  }
}

module.exports = new TaskManager();
