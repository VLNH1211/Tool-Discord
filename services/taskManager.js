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
      questId: null,
      questName: null,
      gameId: null,
      gameName: null,
      executable: null,
      targetSeconds: 900,
      elapsedSeconds: 0,
      sessionId: null,
      sequence: 0,
      timer: null
    };

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
      const heartbeatEvents = discordClient.createPlaytimeHeartbeatEvent(game, sessionId, seq++, false, durationMs);

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
    return {
      status: this.questTask.status,
      questId: this.questTask.questId,
      questName: this.questTask.questName,
      gameName: this.questTask.gameName,
      targetSeconds: this.questTask.targetSeconds,
      elapsedSeconds: this.questTask.elapsedSeconds
    };
  }

  async startQuestFarm({ questId, questName, applicationId, gameName, targetSeconds = 900, intervalSec = 30 }) {
    if (!this.user.token || !this.user.analyticsToken) {
      throw new Error('Chưa đăng nhập Discord Token hoặc thiếu Analytics Token!');
    }

    if (this.questTask.status === 'running') {
      throw new Error('Đang có nhiệm vụ Quest khác đang chạy!');
    }

    // Auto enroll in quest first if needed
    this.addLog(`🎯 Chuẩn bị tự động cày Quest "${questName || questId}"...`, 'QUEST');
    const enrollRes = await discordClient.enrollQuest(this.user.token, questId);
    if (enrollRes.success) {
      this.addLog(`✅ Đã ghi danh (Enrolled) vào Quest thành công!`, 'SUCCESS');
    }

    // Match or find detectable executable
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
      `🚀 Bắt đầu cày Quest: "${this.questTask.questName}" (Mục tiêu: ${targetSeconds}s / ${Math.round(targetSeconds / 60)} phút)`,
      'QUEST'
    );

    if (this.settings.enableGatewayPresence) {
      gateway.updatePresence(this.questTask.gameName, this.questTask.gameId);
    }

    // Send initial quest heartbeat
    await this._sendQuestHeartbeat(true, intervalSec);

    this.questTask.timer = setInterval(async () => {
      this.questTask.elapsedSeconds += intervalSec;

      if (this.questTask.elapsedSeconds >= this.questTask.targetSeconds) {
        await this._completeQuest();
      } else {
        await this._sendQuestHeartbeat(false, intervalSec);
        this.broadcastSSE('quest_status', this.getQuestStatus());
      }
    }, intervalSec * 1000);

    this.broadcastSSE('quest_status', this.getQuestStatus());
    return { success: true };
  }

  async _sendQuestHeartbeat(isInitial = false, intervalSec = 30) {
    try {
      const durationMs = intervalSec * 1000;
      const gameObj = {
        id: this.questTask.gameId,
        name: this.questTask.gameName,
        executable: this.questTask.executable
      };

      // 1. Send Science heartbeat with quest game ID
      const scienceEvents = discordClient.createPlaytimeHeartbeatEvent(
        gameObj,
        this.questTask.sessionId,
        this.questTask.sequence,
        isInitial,
        durationMs
      );
      await discordClient.sendScienceEvents(this.user.token, this.user.analyticsToken, scienceEvents);

      // 2. Also send Discord Quest API heartbeat
      await discordClient.sendQuestHeartbeat(this.user.token, this.questTask.questId);

      this.questTask.sequence++;
      const currentMin = Math.floor(this.questTask.elapsedSeconds / 60);
      const totalMin = Math.ceil(this.questTask.targetSeconds / 60);
      this.addLog(
        `🎯 [Quest Progress] Đã cày: ${this.questTask.elapsedSeconds}s / ${this.questTask.targetSeconds}s (~${currentMin}/${totalMin} phút)`,
        'QUEST'
      );
    } catch (err) {
      this.addLog(`⚠️ Lỗi heartbeat quest: ${err.message}`, 'WARN');
    }
  }

  async _completeQuest() {
    if (this.questTask.timer) {
      clearInterval(this.questTask.timer);
      this.questTask.timer = null;
    }

    this.questTask.status = 'completed';
    this.addLog(`🎉 Đã đạt mục tiêu thời gian cho Quest: "${this.questTask.questName}"!`, 'SUCCESS');

    // Auto-claim reward
    this.addLog(`🎁 Đang tự động nhận phần thưởng (Claim Reward)...`, 'QUEST');
    const claimRes = await discordClient.claimQuest(this.user.token, this.questTask.questId);
    if (claimRes.success) {
      this.addLog(`🏆 Nhận thưởng thành công! Kiểm tra hòm đồ / Discord Gift Inventory của bạn.`, 'SUCCESS');
    } else {
      this.addLog(`ℹ️ Kết quả nhận thưởng: ${claimRes.message || 'Có thể nhận trực tiếp trong app Discord.'}`, 'INFO');
    }

    if (this.settings.enableGatewayPresence) {
      gateway.clearPresence();
    }

    this.broadcastSSE('quest_status', this.getQuestStatus());
  }

  stopQuestFarm() {
    if (this.questTask.status !== 'running') return;
    if (this.questTask.timer) {
      clearInterval(this.questTask.timer);
      this.questTask.timer = null;
    }
    this.questTask.status = 'stopped';
    this.addLog(`⏹ Đã dừng tiến trình cày Quest.`, 'WARN');
    this.broadcastSSE('quest_status', this.getQuestStatus());
    if (this.settings.enableGatewayPresence) {
      gateway.clearPresence();
    }
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
