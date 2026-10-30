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
      speedMultiplier: 1
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
    const timestamp = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const logItem = {
      id: uuidv4().slice(0, 8),
      time: timestamp,
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
            time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
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
      speedMultiplier: this.playtimeTask.speedMultiplier || 1
    };
  }

  async startPlaytime({ gameId, gameName, executable, intervalSec = 30, targetHours = 5000, speedMultiplier = 1 }) {
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
    this.playtimeTask.startedAt = Date.now();
    this.playtimeTask.intervalSec = Math.max(10, parseInt(intervalSec) || 30);
    this.playtimeTask.speedMultiplier = multiplier;

    const speedDesc = multiplier > 1 ? ` [⚡ Turbo ${multiplier}x Tốc Độ]` : '';
    this.addLog(
      `🎮 Khởi động AFK Playtime${speedDesc}: "${game.name}" (Heartbeat mỗi ${this.playtimeTask.intervalSec}s). Session ID: ${sessionId.slice(0, 8)}...`,
      'SCIENCE'
    );

    if (this.settings.enableGatewayPresence) {
      gateway.updatePresence(game.name, game.id);
    }

    // Send initial launch + heartbeat
    await this._sendPlaytimeHeartbeat(true);

    // Setup timer
    this.playtimeTask.timer = setInterval(async () => {
      this.playtimeTask.elapsedSeconds += (this.playtimeTask.intervalSec * this.playtimeTask.speedMultiplier);
      await this._sendPlaytimeHeartbeat(false);
      this.broadcastSSE('playtime_status', this.getPlaytimeStatus());
    }, this.playtimeTask.intervalSec * 1000);

    this.broadcastSSE('playtime_status', this.getPlaytimeStatus());
    return { success: true, game, speedMultiplier: multiplier };
  }

  async _sendPlaytimeHeartbeat(isInitial = false) {
    try {
      const multiplier = this.playtimeTask.speedMultiplier || 1;
      const durationMs = this.playtimeTask.intervalSec * 1000 * multiplier;
      const events = discordClient.createPlaytimeHeartbeatEvent(
        this.playtimeTask.game,
        this.playtimeTask.sessionId,
        this.playtimeTask.sequence,
        isInitial,
        durationMs
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
   */
  async turboInjectPlaytime({ gameId, gameName, executable, hoursToAdd = 5000 }) {
    if (!this.user.token || !this.user.analyticsToken) {
      throw new Error('Chưa đăng nhập Discord Token hoặc thiếu Analytics Token!');
    }

    const hours = parseInt(hoursToAdd) || 5000;
    const game = {
      id: String(gameId || '700136079562375258'),
      name: gameName || 'VALORANT',
      executable: executable || 'VALORANT-Win64-Shipping.exe'
    };

    this.addLog(`⚡ [TURBO INJECTION] Bắt đầu kích hoạt gói bơm siêu tốc +${hours.toLocaleString()} GIỜ cho game "${game.name}"...`, 'WARN');

    // Chunks of max 5,000h per telemetry batch to avoid integer overflow
    const chunkSize = 5000;
    let remaining = hours;
    let totalSuccess = 0;
    const sessionId = uuidv4();
    let seq = 1;

    // Send initial launch game event
    try {
      const launchEvents = discordClient.createPlaytimeHeartbeatEvent(game, sessionId, seq++, true, 60000);
      await discordClient.sendScienceEvents(this.user.token, this.user.analyticsToken, launchEvents);
    } catch (e) {
      console.warn('Turbo launch warning:', e.message);
    }

    while (remaining > 0) {
      const batchHours = Math.min(remaining, chunkSize);
      const durationMs = batchHours * 3600 * 1000;
      const isFinal = (remaining - batchHours <= 0);
      const heartbeatEvents = discordClient.createPlaytimeHeartbeatEvent(game, sessionId, seq++, false, durationMs, isFinal);

      const res = await discordClient.sendScienceEvents(this.user.token, this.user.analyticsToken, heartbeatEvents);
      if (res.success) {
        totalSuccess += batchHours;
        remaining -= batchHours;
        this.accumulatedPlaytimeSeconds += (batchHours * 3600);
        this.addLog(`⚡ [TURBO] Đã bơm thành công đợt +${batchHours.toLocaleString()}h! Tổng tiến độ: ${totalSuccess.toLocaleString()} / ${hours.toLocaleString()} giờ.`, 'SUCCESS');
      } else {
        this.addLog(`⚠️ [TURBO] Discord từ chối đợt bơm: ${res.message}`, 'WARN');
        break;
      }

      if (remaining > 0) {
        await new Promise(r => setTimeout(r, 600)); // safe interval between batches
      }
    }

    if (this.settings.enableGatewayPresence) {
      gateway.updatePresence(game.name, game.id);
    }

    this._savePlaytimeStats();
    this.broadcastSSE('playtime_status', this.getPlaytimeStatus());
    this.addLog(`👑 [TURBO HOÀN TẤT] Bơm thành công tổng cộng +${totalSuccess.toLocaleString()} giờ chơi lên máy chủ Discord! Hãy mở Discord kiểm tra huy hiệu!`, 'SUCCESS');

    return {
      success: true,
      addedHours: totalSuccess,
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
                time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
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

  // --- DISCORD QUESTS AUTOMATION ---

  getQuestStatus() {
    const target = this.questTask.targetSeconds || 900;
    const elapsed = this.questTask.elapsedSeconds || 0;
    const percentage = target > 0 ? Math.min(100, Math.round((elapsed / target) * 100)) : 0;
    const activeQuests = (this.questTask.activeQuests || []).map(q => ({
      id: q.id,
      name: q.name,
      gameName: q.gameName,
      targetSeconds: q.targetSeconds,
      elapsedSeconds: q.elapsedSeconds,
      percentage: q.targetSeconds > 0 ? Math.min(100, Math.round((q.elapsedSeconds / q.targetSeconds) * 100)) : 0,
      completed: q.completed,
      claimed: q.claimed
    }));
    return {
      status: this.questTask.status,
      mode: this.questTask.mode || 'parallel',
      questId: this.questTask.questId,
      questName: this.questTask.questName,
      gameName: this.questTask.gameName,
      targetSeconds: target,
      elapsedSeconds: elapsed,
      percentage,
      queueIndex: this.questTask.queueIndex || 0,
      queueTotal: this.questTask.queueTotal || activeQuests.length || 0,
      activeQuests
    };
  }

  async startAutoFarmAllQuests(userToken) {
    if (userToken) {
      this.user.token = String(userToken).trim().replace(/^['"]|['"]$/g, '').replace(/^(Authorization:|Bearer|Bot)\s+/i, '').trim();
    }
    if (!this.user.token) {
      throw new Error('Chưa đăng nhập Discord Token!');
    }

    // Always fetch fresh profile & analytics token for current user token
    const uRes = await discordClient.getCurrentUser(this.user.token);
    if (!uRes.success) {
      this.questTask.status = 'idle';
      this.broadcastSSE('quest_status', this.getQuestStatus());
      throw new Error(`Token không hợp lệ hoặc đã hết hạn: ${uRes.message || '401 Unauthorized'}`);
    }
    this.user.profile = uRes.data;
    if (uRes.data?.analytics_token) {
      this.user.analyticsToken = uRes.data.analytics_token;
    }

    if (this.questTask.status === 'running') {
      this.stopQuestFarm();
      await new Promise(r => setTimeout(r, 400));
    }

    this.questTask.status = 'running';
    this.questTask.mode = 'parallel';
    this.questTask.shouldStop = false;
    this.questTask.elapsedSeconds = 0;
    this.questTask.targetSeconds = 900;
    this.questTask.queueIndex = 0;
    this.questTask.queueTotal = 0;
    this.questTask.activeQuests = [];
    this.broadcastSSE('quest_status', this.getQuestStatus());

    this.addLog(`🔍 Đang quét danh sách Discord Quests cho @${this.user.profile.username}...`, 'QUEST');
    const questRes = await discordClient.getQuests(this.user.token);
    if (!questRes.success) {
      this.questTask.status = 'idle';
      this.broadcastSSE('quest_status', this.getQuestStatus());
      throw new Error(`Không thể lấy danh sách Quests: ${questRes.message}`);
    }

    const allQuests = questRes.quests || [];
    const now = new Date();

    // Auto-claim any completed but unclaimed quests right away
    for (const q of allQuests) {
      if (q.user_status?.completed_at && !q.user_status?.claimed_at) {
        const qTitle = q.config?.messages?.quest_name || q.config?.messages?.game_title || q.id;
        this.addLog(`🎁 Phát hiện nhiệm vụ đã xong chưa nhận thưởng: "${qTitle}". Đang tự động nhận...`, 'QUEST');
        const claimRes = await discordClient.claimQuest(this.user.token, q.id);
        if (claimRes.success) {
          this.addLog(`🏆 Đã nhận thưởng thành công cho "${qTitle}"!`, 'SUCCESS');
        }
      }
    }

    // Filter pending: not completed and not expired
    const pendingQuests = allQuests.filter(q => {
      const isExpired = q.config?.expires_at && new Date(q.config.expires_at) < now;
      return !q.user_status?.completed_at && !isExpired;
    });

    if (pendingQuests.length === 0) {
      this.questTask.status = 'idle';
      this.addLog(`ℹ️ Tài khoản @${this.user.profile.username} hiện không còn nhiệm vụ nào cần cày (tất cả đã hoàn thành hoặc hết hạn).`, 'INFO');
      this.broadcastSSE('quest_status', this.getQuestStatus());
      return { 
        success: true, 
        message: `Tài khoản @${this.user.profile.username} hiện không còn nhiệm vụ nào cần cày (tất cả đã hoàn thành hoặc hết hạn).`, 
        total: 0 
      };
    }

    // Split into Video Trailer Quests and Play Desktop Quests
    const activeItems = [];
    const videoItems = [];
    const gameItems = [];

    for (const q of pendingQuests) {
      const tasksObj = q.config?.task_config_v2?.tasks || q.config?.task_config?.tasks || {};
      const isVideo = Boolean(tasksObj.WATCH_VIDEO);
      const taskObj = tasksObj.WATCH_VIDEO || tasksObj.PLAY_ON_DESKTOP || Object.values(tasksObj)[0];
      const targetSeconds = taskObj?.target || (isVideo ? 30 : 900);
      const questName = q.config?.messages?.quest_name || q.config?.messages?.game_title || 'Discord Quest';
      const gameTitle = q.config?.messages?.game_title || q.config?.application?.name || 'Game';
      const appId = String(q.config?.application?.id || '');
      const matched = detectables.getGameById(appId);
      const executable = matched?.executable || 'game.exe';

      const item = {
        id: String(q.id),
        name: questName,
        gameId: appId,
        gameName: gameTitle,
        executable: executable,
        isVideo: isVideo,
        targetSeconds: targetSeconds,
        elapsedSeconds: 0,
        sessionId: uuidv4(),
        sequence: 1,
        completed: false,
        claimed: false
      };

      activeItems.push(item);
      if (isVideo) {
        videoItems.push(item);
      } else {
        gameItems.push(item);
      }
    }

    // IMMEDIATELY set status and activeQuests so UI lights up right away!
    this.questTask.activeQuests = activeItems;
    this.questTask.queueTotal = activeItems.length;
    this.questTask.mode = 'parallel';
    this.questTask.status = 'running';
    this.questTask.shouldStop = false;
    this.questTask.elapsedSeconds = 0;
    this.questTask.targetSeconds = Math.max(...activeItems.map(q => q.targetSeconds), 900);

    this.addLog(
      `🚀 KÍCH HOẠT CÀY SONG SONG ĐỒNG THỜI ${activeItems.length} NHIỆM VỤ (${videoItems.length} Video Trailer + ${gameItems.length} Chơi Game)!`,
      'SUCCESS'
    );

    // Broadcast IMMEDIATELY so every card on user screen shows progress!
    this.broadcastSSE('quest_status', this.getQuestStatus());

    // Run execution loop in background
    this._runUnifiedParallelFarm(videoItems, gameItems);

    return {
      success: true,
      total: activeItems.length,
      videoTotal: videoItems.length,
      gameTotal: gameItems.length,
      message: `Đã kích hoạt cày song song đồng thời ${activeItems.length} nhiệm vụ!`
    };
  }

  async _runUnifiedParallelFarm(videoItems, gameItems) {
    // 1. Process Video Trailer Quests in parallel/fast
    (async () => {
      for (const vq of videoItems) {
        if (this.questTask.shouldStop) break;
        try {
          this.addLog(`🎬 [Video Quest] Đang kích hoạt & xem trailer: "${vq.name}"...`, 'QUEST');
          await discordClient.enrollQuest(this.user.token, vq.id);
          await new Promise(r => setTimeout(r, 400));
          await discordClient.sendQuestVideoProgress(this.user.token, vq.id, vq.targetSeconds);
          vq.elapsedSeconds = vq.targetSeconds;
          vq.completed = true;
          this.broadcastSSE('quest_status', this.getQuestStatus());
          await new Promise(r => setTimeout(r, 600));
          const claimRes = await discordClient.claimQuest(this.user.token, vq.id);
          if (claimRes.success) {
            vq.claimed = true;
            this.addLog(`🏆 [Video Quest] Hoàn thành & nhận thưởng thành công cho "${vq.name}"!`, 'SUCCESS');
          } else {
            this.addLog(`ℹ️ [Video Quest] Đã gửi xem video "${vq.name}". (${claimRes.message || 'Kiểm tra hòm đồ'})`, 'INFO');
          }
          this.broadcastSSE('quest_status', this.getQuestStatus());
        } catch (e) {
          this.addLog(`⚠️ Lỗi video quest "${vq.name}": ${e.message}`, 'WARN');
        }
      }
    })();

    // 2. Enroll all game quests and start gateway presence
    if (this.settings.enableGatewayPresence && gameItems[0]) {
      gateway.updatePresence(gameItems[0].gameName, gameItems[0].gameId);
    }

    for (const gq of gameItems) {
      if (this.questTask.shouldStop) break;
      try {
        await discordClient.enrollQuest(this.user.token, gq.id);
      } catch (e) {}
    }

    // 3. Send initial heartbeats for game quests
    for (const item of gameItems) {
      if (this.questTask.shouldStop) break;
      await this._sendSingleQuestItemHeartbeat(item, true, 15, false);
      await new Promise(r => setTimeout(r, 150));
    }
    this.broadcastSSE('quest_status', this.getQuestStatus());

    // 4. Timer loop ticking all game items together
    const intervalSec = 15;
    this.questTask.timer = setInterval(async () => {
      if (this.questTask.shouldStop) {
        clearInterval(this.questTask.timer);
        this.questTask.timer = null;
        this.questTask.status = 'stopped';
        if (this.settings.enableGatewayPresence) gateway.clearPresence();
        this.broadcastSSE('quest_status', this.getQuestStatus());
        return;
      }

      this.questTask.elapsedSeconds += intervalSec;

      for (const item of gameItems) {
        if (this.questTask.shouldStop) break;
        if (item.completed) continue;

        item.elapsedSeconds += intervalSec;
        const isFinished = item.elapsedSeconds >= item.targetSeconds;

        await this._sendSingleQuestItemHeartbeat(item, false, intervalSec, isFinished);
        await new Promise(r => setTimeout(r, 150));

        if (isFinished) {
          item.completed = true;
          this.addLog(`🎉 [Song Song] Nhiệm vụ "${item.name}" đã hoàn thành! Đang tự động nhận thưởng...`, 'SUCCESS');
          try {
            const claimRes = await discordClient.claimQuest(this.user.token, item.id);
            if (claimRes.success) {
              item.claimed = true;
              this.addLog(`🏆 Nhận thưởng thành công cho "${item.name}"! Đã nạp vào tài khoản Discord.`, 'SUCCESS');
            } else {
              this.addLog(`ℹ️ Kết quả nhận thưởng "${item.name}": ${claimRes.message || 'Kiểm tra hòm đồ Discord'}`, 'INFO');
            }
          } catch (e) {
            this.addLog(`⚠️ Lỗi claim "${item.name}": ${e.message}`, 'WARN');
          }
        }
      }

      this.broadcastSSE('quest_status', this.getQuestStatus());

      const allCompleted = this.questTask.activeQuests.every(q => q.completed);
      if (allCompleted) {
        clearInterval(this.questTask.timer);
        this.questTask.timer = null;
        this.questTask.status = 'completed';
        this.addLog(
          `🏆🎉 SIÊU TỐC HOÀN THÀNH! TẤT CẢ ${this.questTask.activeQuests.length} NHIỆM VỤ ĐÃ CÀY XONG VÀ NHẬN THƯỞNG ĐỒNG THỜI!`,
          'SUCCESS'
        );
        if (this.settings.enableGatewayPresence) gateway.clearPresence();
        this.broadcastSSE('quest_status', this.getQuestStatus());
      }
    }, intervalSec * 1000);
  }

  async _processParallelQuests(pendingQuests) {
    // Replaced by _runUnifiedParallelFarm
    return;
  }

  async _sendSingleQuestItemHeartbeat(item, isInitial = false, intervalSec = 15, isTerminal = false) {
    try {
      const durationMs = intervalSec * 1000;
      const gameObj = {
        id: item.gameId,
        name: item.gameName,
        executable: item.executable
      };

      if (this.user.token && this.user.analyticsToken) {
        const scienceEvents = discordClient.createPlaytimeHeartbeatEvent(
          gameObj,
          item.sessionId,
          item.sequence,
          isInitial,
          durationMs
        );
        await discordClient.sendScienceEvents(this.user.token, this.user.analyticsToken, scienceEvents);
      }

      if (this.user.token && item.id) {
        await discordClient.sendQuestHeartbeat(this.user.token, item.id, 'heartbeat', isTerminal);
      }

      item.sequence++;
    } catch (err) {
      // Non-fatal per-item error
    }
  }

  async startQuestFarm({ questId, questName, applicationId, gameName, targetSeconds = 900, intervalSec = 15, userToken }) {
    if (userToken) {
      this.user.token = String(userToken).trim().replace(/^['"]|['"]$/g, '').replace(/^(Authorization:|Bearer|Bot)\s+/i, '').trim();
    }
    if (!this.user.token) {
      throw new Error('Chưa đăng nhập Discord Token!');
    }

    if (!this.user.analyticsToken) {
      const uRes = await discordClient.getCurrentUser(this.user.token);
      if (uRes.success && uRes.data?.analytics_token) {
        this.user.analyticsToken = uRes.data.analytics_token;
      }
    }

    if (this.questTask.status === 'running') {
      this.stopQuestFarm();
      await new Promise(r => setTimeout(r, 400));
    }

    this.questTask.status = 'running';
    this.questTask.mode = 'single';
    this.questTask.shouldStop = false;
    this.questTask.queueIndex = 1;
    this.questTask.queueTotal = 1;

    // Run in background
    (async () => {
      await this._runSingleQuestFarm({
        questId,
        questName,
        applicationId,
        gameName,
        targetSeconds,
        intervalSec
      });

      if (this.questTask.shouldStop) {
        this.questTask.status = 'stopped';
      } else {
        this.questTask.status = 'completed';
      }

      if (this.settings.enableGatewayPresence) {
        gateway.clearPresence();
      }
      this.broadcastSSE('quest_status', this.getQuestStatus());
    })();

    return { success: true };
  }

  async _runSingleQuestFarm({ questId, questName, applicationId, gameName, targetSeconds = 900, intervalSec = 15 }) {
    return new Promise(async (resolve) => {
      // Auto enroll in quest first if needed
      this.addLog(`🎯 Ghi danh (Enroll) vào Quest "${questName || questId}"...`, 'QUEST');
      try {
        await discordClient.enrollQuest(this.user.token, questId);
      } catch (e) {
        // Continue even if already enrolled
      }

      let executable = 'game.exe';
      const matched = detectables.getGameById(applicationId);
      if (matched && matched.executable) {
        executable = matched.executable;
      }

      const sessionId = uuidv4();
      this.questTask.status = 'running';
      this.questTask.questId = questId;
      this.questTask.questName = questName || 'Discord Quest';
      this.questTask.gameId = String(applicationId);
      this.questTask.gameName = gameName || matched?.name || 'Quest Game';
      this.questTask.executable = executable;
      this.questTask.targetSeconds = targetSeconds;
      this.questTask.elapsedSeconds = 0;
      this.questTask.sessionId = sessionId;
      this.questTask.sequence = 1;

      this.addLog(
        `🚀 Đang cày: "${this.questTask.questName}" (Mục tiêu: ${targetSeconds}s / ${Math.round(targetSeconds / 60)} phút)`,
        'QUEST'
      );

      if (this.settings.enableGatewayPresence) {
        gateway.updatePresence(this.questTask.gameName, this.questTask.gameId);
      }

      const stepSec = Math.min(intervalSec, targetSeconds);
      await this._sendQuestHeartbeat(true, stepSec);
      this.broadcastSSE('quest_status', this.getQuestStatus());

      this._questResolve = resolve;

      this.questTask.timer = setInterval(async () => {
        if (this.questTask.shouldStop) {
          this._finishSingleQuest(false);
          return;
        }

        this.questTask.elapsedSeconds += stepSec;
        this.broadcastSSE('quest_status', this.getQuestStatus());

        if (this.questTask.elapsedSeconds >= this.questTask.targetSeconds) {
          this._finishSingleQuest(true);
        } else {
          await this._sendQuestHeartbeat(false, stepSec);
        }
      }, stepSec * 1000);
    });
  }

  async _finishSingleQuest(success = true) {
    if (this.questTask.timer) {
      clearInterval(this.questTask.timer);
      this.questTask.timer = null;
    }

    if (success) {
      this.questTask.elapsedSeconds = this.questTask.targetSeconds;
      this.broadcastSSE('quest_status', this.getQuestStatus());
      this.addLog(`🎉 Đã đạt mục tiêu thời gian cho Quest: "${this.questTask.questName}"!`, 'SUCCESS');

      // Auto-claim reward
      this.addLog(`🎁 Đang tự động nhận phần thưởng (Claim Reward)...`, 'QUEST');
      try {
        const claimRes = await discordClient.claimQuest(this.user.token, this.questTask.questId);
        if (claimRes.success) {
          this.addLog(`🏆 Nhận thưởng thành công cho "${this.questTask.questName}"! Đã nạp vào kho đồ Discord.`, 'SUCCESS');
        } else {
          this.addLog(`ℹ️ Kết quả nhận thưởng: ${claimRes.message || 'Kiểm tra hòm đồ / Discord Quests.'}`, 'INFO');
        }
      } catch (err) {
        this.addLog(`⚠️ Lỗi claim quest: ${err.message}`, 'WARN');
      }
    }

    if (this._questResolve) {
      const res = this._questResolve;
      this._questResolve = null;
      res(success);
    }
  }

  async _sendQuestHeartbeat(isInitial = false, intervalSec = 15) {
    try {
      const durationMs = intervalSec * 1000;
      const gameObj = {
        id: this.questTask.gameId,
        name: this.questTask.gameName,
        executable: this.questTask.executable
      };

      // 1. Send Science heartbeat with quest game ID
      if (this.user.token && this.user.analyticsToken) {
        const scienceEvents = discordClient.createPlaytimeHeartbeatEvent(
          gameObj,
          this.questTask.sessionId,
          this.questTask.sequence,
          isInitial,
          durationMs
        );
        await discordClient.sendScienceEvents(this.user.token, this.user.analyticsToken, scienceEvents);
      }

      // 2. Also send Discord Quest API heartbeat
      if (this.user.token && this.questTask.questId) {
        await discordClient.sendQuestHeartbeat(this.user.token, this.questTask.questId);
      }

      this.questTask.sequence++;
      const currentMin = Math.floor(this.questTask.elapsedSeconds / 60);
      const totalMin = Math.ceil(this.questTask.targetSeconds / 60);
      this.addLog(
        `🎯 [Quest Progress] Đã cày: ${this.questTask.elapsedSeconds}s / ${this.questTask.targetSeconds}s (~${currentMin}/${totalMin} phút) - "${this.questTask.questName}"`,
        'QUEST'
      );
    } catch (err) {
      this.addLog(`⚠️ Lỗi heartbeat quest: ${err.message}`, 'WARN');
    }
  }

  stopQuestFarm() {
    this.questTask.shouldStop = true;
    if (this.questTask.timer) {
      clearInterval(this.questTask.timer);
      this.questTask.timer = null;
    }
    if (this._questResolve) {
      const res = this._questResolve;
      this._questResolve = null;
      res(false);
    }
    this.questTask.status = 'stopped';
    this.addLog(`⏹ Đã dừng toàn bộ tiến trình cày Discord Quests.`, 'WARN');
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
