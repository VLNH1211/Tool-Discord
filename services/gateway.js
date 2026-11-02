const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const discordClient = require('./discordClient');

class DiscordGatewayManager {
  constructor() {
    this.ws = null;
    this.token = null;
    this.userId = null;
    this.username = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.shouldReconnect = true;
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.lastSequence = null;
    this.isConnected = false;
    this.currentActivity = null;
    this.gameStartTime = null;
    this.logger = null;

    // Auto-Responder state
    this.autoResponder = {
      enabled: false,
      message: 'Xin chào! Hiện tại mình đang AFK/bận và sẽ phản hồi bạn ngay khi online.',
      cooldownMinutes: 15,
      cooldowns: new Map() // userId -> timestamp
    };
  }

  setLogger(loggerFn) {
    this.logger = loggerFn;
  }

  log(msg, type = 'GATEWAY') {
    if (this.logger) {
      this.logger(msg, type);
    } else {
      console.log(`[${type}] ${msg}`);
    }
  }

  connect(userToken) {
    if (!userToken) return;
    this.token = userToken.trim().replace(/^"|"$/g, '');
    this.shouldReconnect = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch (e) {}
      this.ws = null;
    }

    try {
      const url = this.resumeGatewayUrl || 'wss://gateway.discord.gg/?v=9&encoding=json';
      this.log(`Connecting to Discord Gateway (${url.split('?')[0]})...`, 'GATEWAY');
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.log('WebSocket connection opened. Awaiting Discord HELLO...', 'GATEWAY');
      });

      this.ws.on('message', (data) => {
        try {
          const payload = JSON.parse(data.toString());
          this.handleMessage(payload);
        } catch (e) {
          // ignore parse errors
        }
      });

      this.ws.on('close', (code, reason) => {
        this.isConnected = false;
        this.clearHeartbeat();
        const reasonStr = reason ? reason.toString() : 'Normal';
        this.log(`Gateway disconnected. Code: ${code} - Reason: ${reasonStr}`, 'GATEWAY');
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        this.log(`Gateway error: ${err.message}`, 'ERROR');
        this.isConnected = false;
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });
    } catch (e) {
      this.log(`Failed to initiate Gateway connection: ${e.message}`, 'ERROR');
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  scheduleReconnect() {
    if (!this.shouldReconnect || !this.token) return;
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;
    const delay = Math.min(2000 * Math.pow(1.3, this.reconnectAttempts - 1), 15000);
    this.log(`Tự động kết nối lại Gateway sau ${(delay / 1000).toFixed(1)}s (Lần thử #${this.reconnectAttempts})...`, 'GATEWAY');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.token);
    }, delay);
  }

  handleMessage(payload) {
    const { op, d, s, t } = payload;
    if (s !== null && s !== undefined) {
      this.lastSequence = s;
    }

    switch (op) {
      case 10: { // HELLO
        const interval = d.heartbeat_interval;
        this.startHeartbeat(interval);
        if (this.sessionId && this.lastSequence !== null) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;
      }
      case 1: { // Heartbeat requested
        this.sendHeartbeat();
        break;
      }
      case 7: { // RECONNECT
        this.log('Discord Gateway yêu cầu RECONNECT (Opcode 7). Đang kết nối lại...', 'GATEWAY');
        if (this.ws) {
          try { this.ws.close(4000, 'Reconnect requested by Discord'); } catch (e) {}
        }
        break;
      }
      case 9: { // INVALID_SESSION
        const resumable = Boolean(d);
        this.log(`Discord Gateway báo INVALID_SESSION (Opcode 9, resumable: ${resumable}).`, 'GATEWAY');
        if (!resumable) {
          this.sessionId = null;
          this.lastSequence = null;
          this.resumeGatewayUrl = null;
        }
        setTimeout(() => {
          if (this.shouldReconnect && this.token) {
            this.sendIdentify();
          }
        }, 1500);
        break;
      }
      case 11: { // Heartbeat ACK
        break;
      }
      case 0: { // Dispatch
        if (t === 'READY') {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.userId = d.user?.id;
          this.username = d.user?.username;
          this.sessionId = d.session_id;
          this.resumeGatewayUrl = d.resume_gateway_url ? `${d.resume_gateway_url}?v=9&encoding=json` : null;
          this.log(`Connected & Authenticated to Gateway as @${this.username || 'Unknown'}!`, 'SUCCESS');
          if (this.currentActivity) {
            this.sendRawPresence(this.currentActivity);
          }
        } else if (t === 'RESUMED') {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.log('Discord Gateway session RESUMED thành công! Trạng thái được duy trì liên tục.', 'SUCCESS');
          if (this.currentActivity) {
            this.sendRawPresence(this.currentActivity);
          }
        } else if (t === 'MESSAGE_CREATE') {
          this.handleIncomingMessage(d);
        }
        break;
      }
    }
  }

  sendResume() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.log('Đang gửi Opcode 6 (RESUME) để khôi phục phiên kết nối...', 'GATEWAY');
    const resumePayload = {
      op: 6,
      d: {
        token: this.token,
        session_id: this.sessionId,
        seq: this.lastSequence
      }
    };
    this.ws.send(JSON.stringify(resumePayload));
  }

  sendIdentify() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const identifyPayload = {
      op: 2,
      d: {
        token: this.token,
        properties: {
          os: 'Windows',
          browser: 'Discord Client',
          device: 'desktop'
        },
        presence: {
          activities: this.currentActivity ? [this.currentActivity] : [],
          status: 'online',
          afk: false
        }
      }
    };
    this.ws.send(JSON.stringify(identifyPayload));
  }

  sendHeartbeat() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ op: 1, d: this.lastSequence }));
  }

  startHeartbeat(interval) {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, interval);
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // --- PRESENCE SETTERS ---

  sendRawPresence(activityObj) {
    this.currentActivity = activityObj;
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const payload = {
      op: 3,
      d: {
        since: null,
        activities: activityObj ? [activityObj] : [],
        status: 'online',
        afk: false
      }
    };

    this.ws.send(JSON.stringify(payload));
  }

  /**
   * Set Playing Game Presence
   */
  updatePresence(gameName, gameId = null) {
    if (!gameName) {
      this.clearPresence();
      return;
    }

    // Preserve start timestamp for the same game session so Discord timer counts continuously without resetting!
    if (!this.gameStartTime || this.currentGameName !== gameName) {
      this.gameStartTime = Date.now();
      this.currentGameName = gameName;
    }

    const activity = {
      name: gameName,
      type: 0, // Playing
      application_id: gameId ? String(gameId) : undefined,
      timestamps: { start: this.gameStartTime }
    };

    this.sendRawPresence(activity);
    this.log(`Trạng thái hồ sơ đã cập nhật: "Đang chơi ${gameName}"`, 'GATEWAY');
  }

  /**
   * Set Spotify Fake Listening Presence
   */
  setSpotifyPresence({ song = 'Starboy', artist = 'The Weeknd', album = 'Starboy', durationSec = 230 }) {
    const start = Date.now();
    const end = start + (parseInt(durationSec) || 230) * 1000;

    const activity = {
      name: 'Spotify',
      type: 2, // Listening
      details: song,
      state: artist,
      timestamps: { start, end },
      assets: {
        large_image: 'spotify:ab67616d0000b2734718e2b124f79258be7bc452',
        large_text: album || song
      },
      party: { id: `spotify:${uuidv4()}` },
      sync_id: uuidv4().replace(/-/g, '').slice(0, 22),
      flags: 48
    };

    this.sendRawPresence(activity);
    this.log(`Đã kích hoạt giả lập Spotify: "${song}" - ${artist}`, 'GATEWAY');
  }

  /**
   * Set Fake Streaming (Twitch/YouTube) Presence
   */
  setStreamingPresence({ title = 'Chilling & Coding Live', twitchUrl = 'https://twitch.tv/discord' }) {
    const activity = {
      name: title,
      type: 1, // Streaming (Purple status)
      url: twitchUrl,
      details: title,
      timestamps: { start: Date.now() }
    };

    this.sendRawPresence(activity);
    this.log(`Đã kích hoạt trạng thái Streaming (Tím): "${title}"`, 'GATEWAY');
  }

  /**
   * Set Custom Game Presence with Clickable Buttons
   */
  setCustomPresence({ gameName, details, state, button1Label, button1Url, button2Label, button2Url }) {
    const buttons = [];
    const buttonUrls = [];

    if (button1Label && button1Url) {
      buttons.push(button1Label);
      buttonUrls.push(button1Url);
    }
    if (button2Label && button2Url) {
      buttons.push(button2Label);
      buttonUrls.push(button2Url);
    }

    const activity = {
      name: gameName || 'Visual Studio Code',
      type: 0,
      details: details || 'Developing Advanced Tools',
      state: state || 'Pro Mode',
      timestamps: { start: Date.now() },
      buttons: buttons.length > 0 ? buttons : undefined,
      metadata: buttonUrls.length > 0 ? { button_urls: buttonUrls } : undefined
    };

    this.sendRawPresence(activity);
    this.log(`Đã kích hoạt Custom Rich Presence: "${gameName}" (${buttons.length} nút)`, 'GATEWAY');
  }

  clearPresence() {
    this.currentActivity = null;
    this.gameStartTime = null;
    this.currentGameName = null;
    this.sendRawPresence(null);
    this.log('Đã xóa bỏ trạng thái hiển thị trên hồ sơ.', 'GATEWAY');
  }

  // --- AUTO RESPONDER ---

  updateAutoResponderSettings({ enabled, message, cooldownMinutes }) {
    if (enabled !== undefined) this.autoResponder.enabled = Boolean(enabled);
    if (message !== undefined) this.autoResponder.message = message;
    if (cooldownMinutes !== undefined) this.autoResponder.cooldownMinutes = Math.max(1, parseInt(cooldownMinutes) || 15);

    this.log(
      `Cấu hình AFK Auto-Responder: ${this.autoResponder.enabled ? 'ĐÃ BẬT' : 'ĐÃ TẮT'} (Hồi chiêu: ${this.autoResponder.cooldownMinutes}m)`,
      'INFO'
    );
  }

  getAutoResponderSettings() {
    return {
      enabled: this.autoResponder.enabled,
      message: this.autoResponder.message,
      cooldownMinutes: this.autoResponder.cooldownMinutes
    };
  }

  async handleIncomingMessage(msg) {
    if (!this.autoResponder.enabled) return;
    if (!msg || !msg.author || msg.author.bot) return;

    // Check if message is from myself
    if (msg.author.id === this.userId) return;

    // Only auto-respond to Direct Messages (DM has no guild_id)
    if (msg.guild_id) return;

    const senderId = msg.author.id;
    const now = Date.now();
    const cooldownMs = this.autoResponder.cooldownMinutes * 60 * 1000;
    const lastSent = this.autoResponder.cooldowns.get(senderId) || 0;

    if (now - lastSent < cooldownMs) {
      // In cooldown, do not reply
      return;
    }

    // Set cooldown
    this.autoResponder.cooldowns.set(senderId, now);

    try {
      this.log(`📩 Nhận tin nhắn từ @${msg.author.username}. Đang tự động phản hồi...`, 'INFO');
      await discordClient.sendMessage(this.token, msg.channel_id, this.autoResponder.message);
      this.log(`✅ Đã gửi phản hồi tự động cho @${msg.author.username}: "${this.autoResponder.message}"`, 'SUCCESS');
    } catch (err) {
      this.log(`❌ Lỗi gửi tin nhắn tự động: ${err.message}`, 'ERROR');
    }
  }

  // --- GATEWAY VOICE PRESENCE (OPCODE 4) ---
  joinVoiceChannel(guildId, channelId, selfMute = false, selfDeaf = false, selfVideo = false) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Chưa kết nối Gateway Discord!');
    }
    const payload = {
      op: 4,
      d: {
        guild_id: guildId || null,
        channel_id: channelId,
        self_mute: Boolean(selfMute),
        self_deaf: Boolean(selfDeaf),
        self_video: Boolean(selfVideo)
      }
    };
    this.ws.send(JSON.stringify(payload));
    this.voiceState = { guildId, channelId, selfMute, selfDeaf, selfVideo };
    this.log(`✅ [Voice Gateway] Đã gửi lệnh vào phòng thoại [${channelId}] (Camera/Screen: ${selfVideo ? 'BẬT' : 'TẮT'})`, 'SUCCESS');
    return { success: true, voiceState: this.voiceState };
  }

  leaveVoiceChannel(guildId) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = {
      op: 4,
      d: {
        guild_id: guildId || null,
        channel_id: null,
        self_mute: false,
        self_deaf: false,
        self_video: false
      }
    };
    this.ws.send(JSON.stringify(payload));
    this.voiceState = null;
    this.log(`[Voice Gateway] Đã rời phòng thoại.`, 'INFO');
    return { success: true };
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHeartbeat();
    if (this.ws) {
      try {
        this.clearPresence();
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch (e) {
        // ignore
      }
      this.ws = null;
    }
    this.isConnected = false;
    this.sessionId = null;
    this.lastSequence = null;
  }
}

module.exports = new DiscordGatewayManager();
