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
    this.lastSequence = null;
    this.isConnected = false;
    this.currentActivity = null;
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
    this.disconnect();

    try {
      this.log('Connecting to Discord Gateway (wss://gateway.discord.gg)...', 'GATEWAY');
      this.ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');

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
        this.log(`Gateway disconnected. Code: ${code} - Reason: ${reason || 'Normal'}`, 'GATEWAY');
      });

      this.ws.on('error', (err) => {
        this.log(`Gateway error: ${err.message}`, 'ERROR');
      });
    } catch (e) {
      this.log(`Failed to initiate Gateway connection: ${e.message}`, 'ERROR');
    }
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
        this.sendIdentify();
        break;
      }
      case 1: { // Heartbeat requested
        this.sendHeartbeat();
        break;
      }
      case 11: { // Heartbeat ACK
        break;
      }
      case 0: { // Dispatch
        if (t === 'READY') {
          this.isConnected = true;
          this.userId = d.user?.id;
          this.username = d.user?.username;
          this.log(`Connected & Authenticated to Gateway as @${this.username || 'Unknown'}!`, 'SUCCESS');
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

    const activity = {
      name: gameName,
      type: 0, // Playing
      application_id: gameId ? String(gameId) : undefined,
      timestamps: { start: Date.now() }
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

  disconnect() {
    this.clearHeartbeat();
    if (this.ws) {
      try {
        this.clearPresence();
        this.ws.terminate();
      } catch (e) {
        // ignore
      }
      this.ws = null;
    }
    this.isConnected = false;
  }
}

module.exports = new DiscordGatewayManager();
