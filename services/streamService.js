const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { Client, RichPresence } = require('discord.js-selfbot-v13');
const { DiscordStreamClient } = require('discord-stream-client');
const ffmpegPath = require('ffmpeg-static');

class StreamService {
  constructor() {
    this.videoPath = path.join(__dirname, '../data/stream_idle.mp4');
    this.ffmpegPath = ffmpegPath;

    this.streamerClient = null;
    this.streamClient = null;
    this.voiceConnection = null;
    this.streamConnection = null;
    this.player = null;

    this.viewerClient = null;
    this.viewerStreamClient = null;
    this.viewerVoiceConnection = null;

    this.timer = null;
    this.viewerPingTimer = null;
    this.loopCount = 0;
    this.mode = 'cloud'; // 'cloud' (Gateway Voice) | 'desktop' (WebRTC Video RTP)
    this.activeViewerIds = new Set();

    this.state = {
      running: false,
      mode: 'cloud',
      gameTitle: 'VALORANT',
      gameId: '700136079562375258',
      streamerState: 'idle', // idle, logging_in, connected, streaming, error
      viewerState: 'idle',   // idle, logging_in, connected, disabled, error
      guildId: null,
      channelId: null,
      channelName: null,
      streamerUser: null,
      viewerUser: null,
      resolution: '720p',
      fps: 15,
      startedAt: null,
      elapsedSeconds: 0,
      loopCount: 0,
      spectators: [],
      spectatorCount: 0,
      voiceMembersCount: 0,
      lastError: null
    };

    this.onStatusChange = null;
    this.ensureSampleVideo();
  }

  ensureSampleVideo() {
    try {
      if (!fs.existsSync(this.videoPath) || fs.statSync(this.videoPath).size < 1000) {
        console.log('[StreamService] Đang tạo video mẫu tĩnh siêu nhẹ stream_idle.mp4...');
        const args = [
          '-y',
          '-f', 'lavfi', '-i', 'color=c=0x1e1f22:s=640x360:r=15:d=60',
          '-f', 'lavfi', '-i', 'anullsrc=cl=stereo:r=48000',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-t', '60',
          this.videoPath
        ];
        const res = spawnSync(this.ffmpegPath, args);
        if (res.status === 0) {
          console.log('[StreamService] Đã tạo video mẫu thành công (60s, 640x360 15fps).');
        } else {
          console.error('[StreamService] Lỗi tạo video mẫu:', res.error || res.stderr?.toString());
        }
      }
    } catch (err) {
      console.error('[StreamService] Ngoại lệ khi tạo video mẫu:', err.message);
    }
  }

  getStatus() {
    return { ...this.state };
  }

  broadcast(message, type = 'info') {
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange(this.getStatus(), { message, type });
    }
  }

  async startStream({ streamerToken, viewerToken, guildId, channelId, resolution = '720p', fps = 15, mode = 'cloud', gameTitle = 'VALORANT', gameId = '700136079562375258' }) {
    if (this.state.running) {
      throw new Error('Tiến trình Stream đang chạy. Vui lòng dừng tiến trình hiện tại trước!');
    }
    if (!streamerToken) {
      throw new Error('Vui lòng cung cấp User Token của tài khoản Streamer (tài khoản chính)!');
    }
    if (!channelId) {
      throw new Error('Vui lòng nhập Voice Channel ID (ID Kênh thoại)!');
    }

    this.mode = mode || 'cloud';
    this.activeViewerIds = new Set();

    this.state = {
      running: true,
      mode: this.mode,
      gameTitle: gameTitle || 'VALORANT',
      gameId: String(gameId || '700136079562375258'),
      streamerState: 'logging_in',
      viewerState: viewerToken ? 'logging_in' : 'disabled',
      guildId: guildId || null,
      channelId,
      channelName: null,
      streamerUser: null,
      viewerUser: null,
      resolution,
      fps: parseInt(fps) || 15,
      startedAt: Date.now(),
      elapsedSeconds: 0,
      loopCount: 0,
      spectators: [],
      spectatorCount: 0,
      voiceMembersCount: 0,
      lastError: null
    };

    const modeText = this.mode === 'cloud' 
      ? 'Chế độ Cloud 24/7 (Gateway Voice & Presence)' 
      : 'Chế độ Desktop (WebRTC Video)';
    this.broadcast(`Đang khởi động Headless Streamer [${modeText}] cho kênh thoại [${channelId}]...`, 'info');

    try {
      // 1. Khởi tạo tài khoản Streamer chính bằng Selfbot Client
      this.streamerClient = new Client({ checkUpdate: false });

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Đăng nhập tài khoản Streamer quá thời gian (Timeout)!')), 20000);

        this.streamerClient.once('ready', () => {
          clearTimeout(timeout);
          resolve();
        });

        this.streamerClient.login(streamerToken).catch(err => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      this.state.streamerUser = {
        id: this.streamerClient.user.id,
        username: this.streamerClient.user.username,
        discriminator: this.streamerClient.user.discriminator,
        avatar: this.streamerClient.user.displayAvatarURL()
      };
      this.state.streamerState = 'connected';
      this.broadcast(`[Streamer] Đã đăng nhập: @${this.streamerClient.user.username}. Đang tìm kênh thoại...`, 'info');

      // 2. Tìm kênh thoại
      let channel = this.streamerClient.channels.cache.get(channelId);
      if (!channel) {
        channel = await this.streamerClient.channels.fetch(channelId).catch(() => null);
      }
      if (!channel || !channel.isVoice()) {
        throw new Error(`Không tìm thấy kênh thoại hợp lệ với ID: ${channelId}. Hãy đảm bảo tài khoản đã tham gia Server và có quyền xem/kết nối kênh!`);
      }

      this.state.channelName = channel.name;
      this.state.guildId = channel.guild?.id || null;
      this.broadcast(`[Streamer] Đã tìm thấy kênh thoại "${channel.name}" (${channel.guild ? channel.guild.name : 'DM'}).`, 'info');

      // Listen to voiceStateUpdate to detect any spectator joining / leaving in real time
      this.streamerClient.on('voiceStateUpdate', (oldState, newState) => {
        if (oldState.channelId === this.state.channelId || newState.channelId === this.state.channelId) {
          this.refreshSpectators();
          this.broadcast(null, 'status');
        }
      });

      // Listen to raw gateway packets to capture real-time STREAM_UPDATE (viewer_ids) and STREAM_CREATE
      this.streamerClient.on('raw', (packet) => {
        if (!packet) return;

        if ((packet.t === 'STREAM_UPDATE' || packet.t === 'STREAM_CREATE') && packet.d) {
          const streamerId = this.streamerClient.user?.id;
          const activeKey = this.state.streamKey;
          const isOurStream = !activeKey || (packet.d.stream_key && packet.d.stream_key === activeKey) || (streamerId && packet.d.stream_key && packet.d.stream_key.includes(streamerId));

          if (isOurStream) {
            if (packet.d.stream_key) {
              this.state.streamKey = packet.d.stream_key;
            }
            if (Array.isArray(packet.d.viewer_ids)) {
              console.log('[Streamer Gateway] STREAM_UPDATE viewer_ids:', packet.d.viewer_ids);
              this.activeViewerIds = new Set(packet.d.viewer_ids.map(String));
              this.refreshSpectators();
              this.broadcast(null, 'status');
            }
          }
        } else if (packet.t === 'STREAM_DELETE') {
          if (packet.d?.stream_key && packet.d.stream_key === this.state.streamKey) {
            this.activeViewerIds.clear();
            this.refreshSpectators();
            this.broadcast(null, 'status');
          }
        }
      });

      // 3. Kết nối Voice & Stream theo chế độ
      if (this.mode === 'desktop') {
        // Desktop WebRTC Mode with watchdog
        await this._startDesktopWebRTC(channel);
      } else {
        // Cloud 24/7 Gateway Mode (100% reliable on Render/VPS without raw UDP)
        await this._startCloudGateway(channel);
      }

      // 4. Nếu có cung cấp token Viewer (Tài khoản khán giả phụ)
      if (viewerToken) {
        this.initViewer(viewerToken, channel.guild?.id, channelId).catch(err => {
          console.error('[Viewer Error]:', err.message);
          this.state.viewerState = 'error';
          this.broadcast(`[Viewer Cảnh báo] Không thể kết nối tài khoản phụ: ${err.message}. Bạn vẫn có thể vào phòng bằng nick phụ trên điện thoại/web để tính giờ!`, 'warning');
        });
      } else {
        this.broadcast(`[Gợi ý] Bạn chưa cung cấp Token tài khoản phụ (Viewer). Hãy đưa nick phụ vào kênh thoại "${channel.name}" để Discord bắt đầu tính giờ stream nhé!`, 'warning');
      }

      // 5. Khởi động bộ đếm thời gian
      this.timer = setInterval(() => {
        if (!this.state.running) return;
        this.state.elapsedSeconds = Math.floor((Date.now() - this.state.startedAt) / 1000);
        if (this.state.elapsedSeconds % 2 === 0) {
          this.refreshSpectators();
        }
        this.broadcast(null, 'heartbeat');
      }, 1000);

      return { success: true, status: this.getStatus() };
    } catch (error) {
      console.error('[StreamService Error]:', error);
      this.state.running = false;
      this.state.streamerState = 'error';
      this.state.lastError = error.message;
      this.broadcast(`Lỗi tiến trình Stream: ${error.message}`, 'error');
      this.stopStream();
      throw error;
    }
  }

  /**
   * Cloud Mode: Pure Gateway WebSocket (Opcode 4 Voice State Update + Opcode 3 Streaming Presence)
   * Runs 24/7 on Render / Docker / VPS without requiring raw UDP ports.
   */
  async _startCloudGateway(channel) {
    this.broadcast(`[Cloud 24/7] Đang vào phòng thoại "${channel.name}" qua Discord Gateway WebSocket...`, 'info');

    // Opcode 4: Voice State Update
    this.streamerClient.ws.broadcast({
      op: 4,
      d: {
        guild_id: channel.guild?.id || null,
        channel_id: channel.id,
        self_mute: false,
        self_deaf: false,
        self_video: false
      }
    });

    // Opcode 18: STREAM_CREATE (Kích hoạt huy hiệu đỏ [TRỰC TIẾP / LIVE] trong kênh thoại Discord)
    const streamKey = `guild:${channel.guild?.id}:${channel.id}:${this.streamerClient.user.id}`;
    this.state.streamKey = streamKey;

    setTimeout(() => {
      if (this.streamerClient && this.streamerClient.ws) {
        this.streamerClient.ws.broadcast({
          op: 18,
          d: {
            type: 'guild',
            guild_id: channel.guild?.id || null,
            channel_id: channel.id,
            preferred_region: null
          }
        });
        this.broadcast(`✅ [Streamer] Đã kích hoạt Opcode 18 (STREAM_CREATE). Huy hiệu đỏ [TRỰC TIẾP / LIVE] đã hiển thị trên kênh "${channel.name}"!`, 'success');
      }
    }, 1200);

    // Set Go Live / Streaming Presence with VALORANT or chosen game
    this.updateStreamPresence(this.state.gameTitle || 'VALORANT', this.state.gameId || '700136079562375258');

    this.state.streamerState = 'streaming';
    this.broadcast(`✅ [Streamer] Đã vào phòng thoại & kích hoạt trạng thái Go Live Screen Share 24/7! (Chế độ Cloud Gateway)`, 'success');
  }

  /**
   * Desktop Mode: Full WebRTC Stream with Video RTP packets via FFmpeg
   */
  async _startDesktopWebRTC(channel) {
    this.ensureSampleVideo();
    this.streamClient = new DiscordStreamClient(this.streamerClient);
    this.streamClient.setResolution(this.state.resolution);

    this.broadcast(`[Streamer] Đang thương lượng kết nối WebRTC Voice...`, 'info');

    // 10s Watchdog: if UDP handshake hangs (e.g. on Render), fallback to Cloud Gateway mode
    let joined = false;
    const joinPromise = this.streamClient.joinVoiceChannel(channel, {
      selfDeaf: false,
      selfMute: true,
      selfVideo: false
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        if (!joined) reject(new Error('WebRTC UDP Timeout (Môi trường mạng chặn cổng UDP)'));
      }, 10000);
    });

    try {
      this.voiceConnection = await Promise.race([joinPromise, timeoutPromise]);
      joined = true;
      this.broadcast(`[Streamer] Đã vào kênh thoại. Đang phát luồng Screen Share RTP...`, 'info');
      this.streamConnection = await this.voiceConnection.createStream();
      this.state.streamerState = 'streaming';
      this.updateStreamPresence(this.state.gameTitle || 'VALORANT', this.state.gameId || '700136079562375258');
      this.broadcast(`[Streamer] Khởi tạo luồng Screen Share thành công! Bắt đầu truyền video...`, 'success');
      this.playVideoLoop();
    } catch (err) {
      console.warn('[Desktop WebRTC Warning]:', err.message);
      this.broadcast(`⚠️ Không thể kết nối WebRTC UDP (${err.message}). Đang tự động chuyển sang Chế Độ Cloud Gateway 24/7...`, 'warning');
      this.mode = 'cloud';
      this.state.mode = 'cloud';
      await this._startCloudGateway(channel);
    }
  }

  playVideoLoop() {
    if (!this.state.running || !this.streamConnection) return;

    try {
      this.player = this.streamClient.createPlayer(
        this.videoPath,
        this.streamConnection.udp,
        this.ffmpegPath
      );

      this.player.on('start', () => {
        this.state.loopCount++;
        this.broadcast(`[Streamer] Đang phát gói video vòng lặp #${this.state.loopCount}...`, 'info');
      });

      this.player.on('finish', () => {
        if (this.state.running && this.streamConnection) {
          setTimeout(() => this.playVideoLoop(), 500);
        }
      });

      this.player.on('error', (err) => {
        console.error('[Player Error]:', err);
        if (this.state.running) {
          setTimeout(() => this.playVideoLoop(), 2000);
        }
      });

      this.player.play();
    } catch (err) {
      console.error('[Stream Loop Error]:', err.message);
      if (this.state.running) {
        setTimeout(() => this.playVideoLoop(), 3000);
      }
    }
  }

  async initViewer(viewerToken, guildId, channelId) {
    this.broadcast(`[Viewer] Đang đăng nhập tài khoản phụ làm người xem...`, 'info');
    this.viewerClient = new Client({ checkUpdate: false });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Tài khoản Viewer đăng nhập quá thời gian (Timeout)!')), 20000);
      this.viewerClient.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.viewerClient.login(viewerToken).catch(err => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    this.state.viewerUser = {
      id: this.viewerClient.user.id,
      username: this.viewerClient.user.username,
      discriminator: this.viewerClient.user.discriminator,
      avatar: this.viewerClient.user.displayAvatarURL()
    };

    // Join the same voice channel via Gateway Opcode 4 (works 100% on any network)
    this.viewerClient.ws.broadcast({
      op: 4,
      d: {
        guild_id: guildId || null,
        channel_id: channelId,
        self_mute: true,
        self_deaf: true,
        self_video: false
      }
    });

    const streamerId = this.streamerClient?.user?.id;
    const streamKey = guildId ? `guild:${guildId}:${channelId}:${streamerId}` : `call:${channelId}:${streamerId}`;
    this.state.streamKey = streamKey;

    // Listen on raw Gateway stream events to auto-bind to the exact stream key and capture viewer_ids
    this.viewerClient.on('raw', (packet) => {
      if (!packet) return;

      if ((packet.t === 'STREAM_CREATE' || packet.t === 'STREAM_UPDATE') && packet.d) {
        if (!streamerId || (packet.d.stream_key && packet.d.stream_key.includes(streamerId))) {
          if (packet.d.stream_key) {
            this.state.streamKey = packet.d.stream_key;
          }
          if (Array.isArray(packet.d.viewer_ids)) {
            console.log('[Viewer Gateway] STREAM_UPDATE viewer_ids:', packet.d.viewer_ids);
            packet.d.viewer_ids.forEach(id => this.activeViewerIds.add(String(id)));
            this.refreshSpectators();
            this.broadcast(null, 'status');
          }
          if (packet.t === 'STREAM_CREATE' && this.viewerClient && this.viewerClient.ws) {
            this.viewerClient.ws.broadcast({
              op: 20, // STREAM_WATCH
              d: { stream_key: packet.d.stream_key }
            });
          }
        }
      }
    });

    // Opcode 20: STREAM_WATCH (Báo cho Discord rằng tài khoản phụ chính thức nhấn Xem Stream / Spectate!)
    const dispatchWatch = () => {
      if (this.viewerClient && this.viewerClient.ws && this.state.running) {
        const activeKey = this.state.streamKey || streamKey;
        this.viewerClient.ws.broadcast({
          op: 20, // STREAM_WATCH
          d: { stream_key: activeKey }
        });
        if (this.viewerClient.user) {
          this.activeViewerIds.add(String(this.viewerClient.user.id));
        }
        this.broadcast(`🎉 [Viewer] Tài khoản phụ @${this.viewerClient.user.username} đã nhận luồng stream và kích hoạt làm Spectator (Opcode 20 STREAM_WATCH)!`, 'success');
      }
    };

    setTimeout(dispatchWatch, 1200);
    setTimeout(dispatchWatch, 3000);

    // Opcode 21: STREAM_PING (Duy trì nhịp Spectator liên tục mỗi 10 giây để giữ vị trí trong danh sách Spectators của Discord)
    if (this.viewerPingTimer) clearInterval(this.viewerPingTimer);
    this.viewerPingTimer = setInterval(() => {
      if (this.viewerClient && this.viewerClient.ws && this.state.running) {
        const activeKey = this.state.streamKey || streamKey;
        this.viewerClient.ws.broadcast({
          op: 21, // STREAM_PING
          d: { stream_key: activeKey }
        });
      }
    }, 10000);

    this.state.viewerState = 'connected';
    this.broadcast(`🎉 [Viewer] Tài khoản phụ @${this.viewerClient.user.username} đã vào kênh thoại và chính thức làm Khán giả (Spectator) trực tiếp!`, 'success');
  }

  refreshSpectators() {
    if (!this.streamerClient || !this.state.channelId) return;

    try {
      const channel = this.streamerClient.channels.cache.get(this.state.channelId);
      const spectators = [];

      if (channel && channel.members) {
        channel.members.forEach((member) => {
          if (member.id === this.streamerClient.user?.id) return; // Skip streamer

          const isViewerBot = Boolean(this.viewerClient && member.id === this.viewerClient.user?.id);
          const isWatching = isViewerBot || Boolean(this.activeViewerIds && this.activeViewerIds.has(String(member.id)));

          spectators.push({
            id: member.id,
            username: member.user?.username || member.displayName,
            displayName: member.displayName || member.user?.username,
            avatar: member.user?.displayAvatarURL ? member.user.displayAvatarURL({ dynamic: true, size: 64 }) : null,
            isViewerBot,
            isWatching,
            label: isViewerBot
              ? 'Acc Phụ (Đang xem Stream)'
              : isWatching
              ? 'Khán giả (Đang xem Stream)'
              : 'Trong phòng thoại',
            isMuted: Boolean(member.voice?.selfMute || member.voice?.serverMute),
            isDeaf: Boolean(member.voice?.selfDeaf || member.voice?.serverDeaf)
          });
        });
      }

      // If viewerClient is active, guarantee they appear in spectators
      if (this.viewerClient && this.viewerClient.user && this.state.viewerState === 'connected') {
        const found = spectators.find(s => s.id === this.viewerClient.user.id);
        if (!found) {
          spectators.unshift({
            id: this.viewerClient.user.id,
            username: this.viewerClient.user.username,
            displayName: this.viewerClient.user.username,
            avatar: this.viewerClient.user.displayAvatarURL ? this.viewerClient.user.displayAvatarURL({ dynamic: true, size: 64 }) : null,
            isViewerBot: true,
            isWatching: true,
            label: 'Acc Phụ (Đang xem Stream)',
            isMuted: true,
            isDeaf: true
          });
        } else {
          found.isViewerBot = true;
          found.isWatching = true;
        }
      }

      // Sort: viewer bot first, then active watchers, then other members in room
      spectators.sort((a, b) => {
        if (a.isViewerBot && !b.isViewerBot) return -1;
        if (!a.isViewerBot && b.isViewerBot) return 1;
        if (a.isWatching && !b.isWatching) return -1;
        if (!a.isWatching && b.isWatching) return 1;
        return 0;
      });

      this.state.spectators = spectators;
      this.state.spectatorCount = spectators.filter(s => s.isWatching).length || (spectators.length > 0 ? 1 : 0);
      this.state.voiceMembersCount = spectators.length;
    } catch (e) {
      console.warn('[refreshSpectators Warning]:', e.message);
    }
  }

  toggleSpectatorWatching(userId) {
    if (!userId) return { success: false, message: 'Thiếu userId' };
    const idStr = String(userId);
    let isWatching = false;

    if (this.activeViewerIds.has(idStr)) {
      this.activeViewerIds.delete(idStr);
      isWatching = false;
    } else {
      this.activeViewerIds.add(idStr);
      isWatching = true;
    }

    this.refreshSpectators();
    this.broadcast(null, 'status');
    return { success: true, userId: idStr, isWatching };
  }

  ensureViewerSpectating() {
    if (!this.viewerClient || !this.viewerClient.ws) {
      return { success: false, message: 'Tài khoản phụ chưa kết nối hoặc chưa đăng nhập!' };
    }
    const streamerId = this.streamerClient?.user?.id;
    const guildId = this.state.guildId;
    const channelId = this.state.channelId;
    const activeKey = this.state.streamKey || (guildId ? `guild:${guildId}:${channelId}:${streamerId}` : `call:${channelId}:${streamerId}`);

    this.viewerClient.ws.broadcast({
      op: 20, // STREAM_WATCH
      d: { stream_key: activeKey }
    });
    this.broadcast(`👁️ [Viewer] Đã kích hoạt Opcode 20 (STREAM_WATCH) cho @${this.viewerClient.user?.username} xem stream!`, 'success');
    return { success: true, streamKey: activeKey };
  }

  updateStreamPresence(gameTitle = 'VALORANT', gameId = '700136079562375258') {
    const title = gameTitle || 'VALORANT';
    const appId = String(gameId || '700136079562375258');
    this.state.gameTitle = title;
    this.state.gameId = appId;

    if (!this.streamerClient || !this.streamerClient.user) {
      return { success: false, message: 'Streamer chưa kết nối hoặc chưa sẵn sàng!' };
    }

    try {
      const pr = new RichPresence(this.streamerClient)
        .setApplicationId(appId)
        .setType('STREAMING')
        .setName(title)
        .setDetails(`Đang stream ${title}`)
        .setState('Trực tiếp')
        .setURL('https://twitch.tv/valorant');

      this.streamerClient.user.setPresence({ activities: [pr] });
      this.broadcast(`🎮 [Streamer] Đã cập nhật trạng thái Stream sang game: "${title}" (ID: ${appId})`, 'success');
      return { success: true, gameTitle: title, gameId: appId };
    } catch (err) {
      try {
        this.streamerClient.user.setActivity(title, {
          type: 'STREAMING',
          url: 'https://twitch.tv/valorant'
        });
        this.broadcast(`🎮 [Streamer] Đã cập nhật trạng thái Stream sang: "${title}"`, 'success');
        return { success: true, gameTitle: title };
      } catch (e) {
        return { success: false, message: e.message };
      }
    }
  }

  stopStream() {
    this.broadcast('Đang dừng tiến trình Headless Streamer...', 'info');

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.viewerPingTimer) {
      clearInterval(this.viewerPingTimer);
      this.viewerPingTimer = null;
    }

    if (this.player) {
      try {
        this.player.stop();
      } catch (e) {}
      this.player = null;
    }

    if (this.streamClient && this.voiceConnection) {
      try {
        this.streamClient.stopScreenShare();
      } catch (e) {}
    }

    if (this.streamerClient) {
      try {
        // Leave voice channel via Opcode 4
        if (this.state.channelId && this.streamerClient.ws) {
          this.streamerClient.ws.broadcast({
            op: 4,
            d: {
              guild_id: this.state.guildId || null,
              channel_id: null,
              self_mute: false,
              self_deaf: false,
              self_video: false
            }
          });
        }
        this.streamerClient.destroy();
      } catch (e) {}
      this.streamerClient = null;
    }

    if (this.viewerClient) {
      try {
        if (this.state.channelId && this.viewerClient.ws) {
          this.viewerClient.ws.broadcast({
            op: 4,
            d: {
              guild_id: this.state.guildId || null,
              channel_id: null,
              self_mute: false,
              self_deaf: false,
              self_video: false
            }
          });
        }
        this.viewerClient.destroy();
      } catch (e) {}
      this.viewerClient = null;
    }

    this.streamClient = null;
    this.voiceConnection = null;
    this.streamConnection = null;
    this.viewerStreamClient = null;
    this.viewerVoiceConnection = null;
    if (this.activeViewerIds) this.activeViewerIds.clear();

    this.state.running = false;
    this.state.streamerState = 'idle';
    this.state.viewerState = 'idle';

    this.broadcast('Đã dừng tiến trình Stream. Tài nguyên đã được giải phóng.', 'info');
    return { success: true };
  }
}

module.exports = new StreamService();
