const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { Client } = require('discord.js-selfbot-v13');
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
    this.loopCount = 0;

    this.state = {
      running: false,
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

  async startStream({ streamerToken, viewerToken, guildId, channelId, resolution = '720p', fps = 15 }) {
    if (this.state.running) {
      throw new Error('Tiến trình Stream đang chạy. Vui lòng dừng tiến trình hiện tại trước!');
    }
    if (!streamerToken) {
      throw new Error('Vui lòng cung cấp User Token của tài khoản Streamer (tài khoản chính)!');
    }
    if (!channelId) {
      throw new Error('Vui lòng nhập Voice Channel ID (ID Kênh thoại)!');
    }

    this.ensureSampleVideo();

    this.state = {
      running: true,
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
      lastError: null
    };

    this.broadcast(`Đang khởi động Headless Streamer cho kênh thoại [${channelId}]...`, 'info');

    try {
      // 1. Khởi tạo tài khoản Streamer chính
      this.streamerClient = new Client({ checkUpdate: false });
      this.streamClient = new DiscordStreamClient(this.streamerClient);
      this.streamClient.setResolution(resolution);

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
      this.broadcast(`[Streamer] Đã tìm thấy kênh thoại "${channel.name}" (${channel.guild ? channel.guild.name : 'DM'}). Đang kết nối Voice & Stream...`, 'info');

      // 3. Kết nối Voice Channel và tạo Stream
      this.voiceConnection = await this.streamClient.joinVoiceChannel(channel, {
        selfDeaf: false,
        selfMute: true,
        selfVideo: false
      });

      this.broadcast(`[Streamer] Đã vào kênh thoại. Đang phát tín hiệu Go Live (Screen Share)...`, 'info');

      this.streamConnection = await this.voiceConnection.createStream();
      this.state.streamerState = 'streaming';
      this.broadcast(`[Streamer] Khởi tạo luồng Screen Share thành công! Bắt đầu truyền dữ liệu video RTP...`, 'success');

      // 4. Bắt đầu phát video lặp
      this.playVideoLoop();

      // 5. Nếu có cung cấp token Viewer (Tài khoản khán giả phụ)
      if (viewerToken) {
        this.initViewer(viewerToken, channelId).catch(err => {
          console.error('[Viewer Error]:', err.message);
          this.state.viewerState = 'error';
          this.broadcast(`[Viewer Cảnh báo] Không thể kết nối tài khoản phụ làm người xem: ${err.message}. Bạn vẫn có thể vào phòng bằng nick phụ trên điện thoại/web để tính giờ!`, 'warning');
        });
      } else {
        this.broadcast(`[Gợi ý] Bạn chưa cung cấp Token tài khoản phụ (Viewer). Hãy mở 1 nick clone trên web/điện thoại vào kênh thoại "${channel.name}" để Discord bắt đầu tính giờ stream nhé!`, 'warning');
      }

      // 6. Bắt đầu bộ đếm thời gian
      this.timer = setInterval(() => {
        if (!this.state.running) return;
        this.state.elapsedSeconds = Math.floor((Date.now() - this.state.startedAt) / 1000);
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
          // Lặp lại tự động
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

  async initViewer(viewerToken, channelId) {
    this.broadcast(`[Viewer] Đang đăng nhập tài khoản phụ làm người xem...`, 'info');
    this.viewerClient = new Client({ checkUpdate: false });
    this.viewerStreamClient = new DiscordStreamClient(this.viewerClient);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Tài khoản Viewer đăng nhập quá thời gian!')), 20000);
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

    let viewerChannel = this.viewerClient.channels.cache.get(channelId);
    if (!viewerChannel) {
      viewerChannel = await this.viewerClient.channels.fetch(channelId).catch(() => null);
    }

    if (!viewerChannel || !viewerChannel.isVoice()) {
      throw new Error(`Tài khoản phụ chưa tham gia server hoặc không có quyền vào kênh thoại này!`);
    }

    this.viewerVoiceConnection = await this.viewerStreamClient.joinVoiceChannel(viewerChannel, {
      selfDeaf: true,
      selfMute: true,
      selfVideo: false
    });

    this.state.viewerState = 'connected';
    this.broadcast(`[Viewer] Tài khoản phụ @${this.viewerClient.user.username} đã vào kênh thoại làm khán giả! Điều kiện tính giờ stream đã thỏa mãn 100%!`, 'success');
  }

  stopStream() {
    this.broadcast('Đang dừng tiến trình Headless Streamer...', 'info');

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
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
        this.streamerClient.destroy();
      } catch (e) {}
      this.streamerClient = null;
    }

    if (this.viewerClient) {
      try {
        this.viewerClient.destroy();
      } catch (e) {}
      this.viewerClient = null;
    }

    this.streamClient = null;
    this.voiceConnection = null;
    this.streamConnection = null;
    this.viewerStreamClient = null;
    this.viewerVoiceConnection = null;

    this.state.running = false;
    this.state.streamerState = 'idle';
    this.state.viewerState = 'idle';

    this.broadcast('Đã dừng tiến trình Stream. Tài nguyên đã được giải phóng.', 'info');
    return { success: true };
  }
}

module.exports = new StreamService();
