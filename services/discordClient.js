const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const DISCORD_API_BASE = 'https://discord.com/api/v9';

// Default desktop client properties encoded as Base64 for X-Super-Properties
const DEFAULT_SUPER_PROPERTIES = {
  os: 'Windows',
  browser: 'Discord Client',
  release_channel: 'stable',
  client_version: '1.0.9168',
  os_version: '10.0.19045',
  os_arch: 'x64',
  app_arch: 'x64',
  system_locale: 'en-US',
  browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9168 Chrome/128.0.6613.186 Electron/32.2.2 Safari/537.36',
  browser_version: '32.2.2',
  client_build_number: 339246,
  native_build_number: null,
  client_event_source: null
};

const SUPER_PROPERTIES_B64 = Buffer.from(JSON.stringify(DEFAULT_SUPER_PROPERTIES)).toString('base64');

class DiscordClient {
  constructor() {
    this.superPropertiesB64 = SUPER_PROPERTIES_B64;
    this.userAgent = DEFAULT_SUPER_PROPERTIES.browser_user_agent;
  }

  getHeaders(userToken) {
    let cleanToken = (userToken || '').trim();
    cleanToken = cleanToken.replace(/^['"]|['"]$/g, '').replace(/^(Authorization:|Bearer|Bot)\s+/i, '').trim();
    return {
      'Authorization': cleanToken,
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent,
      'X-Super-Properties': this.superPropertiesB64,
      'X-Discord-Locale': 'en-US',
      'X-Discord-Timezone': 'Etc/UTC',
      'Accept': '*/*',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin'
    };
  }

  /**
   * Fetch current user profile and analytics_token
   */
  async getCurrentUser(userToken) {
    try {
      const response = await axios.get(`${DISCORD_API_BASE}/users/@me?with_analytics_token=true`, {
        headers: this.getHeaders(userToken),
        timeout: 10000
      });

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      const status = error.response ? error.response.status : null;
      const data = error.response ? error.response.data : null;
      let message = error.message;

      if (status === 401) {
        message = 'Invalid Discord Token or token has expired.';
      } else if (status === 429) {
        message = `Rate limited by Discord. Retry after ${data?.retry_after || 'a few'} seconds.`;
      } else if (data && data.message) {
        message = data.message;
      }

      return {
        success: false,
        status,
        message,
        data
      };
    }
  }

  /**
   * Send Science telemetry events
   */
  async sendScienceEvents(userToken, analyticsToken, events) {
    if (!analyticsToken) {
      throw new Error('Analytics token is missing. Please refresh your profile first.');
    }

    const payload = {
      token: analyticsToken,
      events: events
    };

    try {
      const response = await axios.post(`${DISCORD_API_BASE}/science`, payload, {
        headers: this.getHeaders(userToken),
        timeout: 12000
      });

      // Discord science returns 204 No Content on success
      return {
        success: true,
        status: response.status
      };
    } catch (error) {
      const status = error.response ? error.response.status : null;
      const retryAfter = error.response?.data?.retry_after;
      return {
        success: false,
        status,
        retryAfter,
        message: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Build Game Diversity Spoof Payload (Launch + Initial Heartbeat + Final Heartbeat)
   * Sends complete lifecycle with realistic 3-minute playtime duration and session closure
   */
  createGameDiversityEvents(game, sessionId = uuidv4()) {
    const now = Date.now();
    const gameId = String(game.id);
    const gameName = game.name;
    const gameExecutable = game.executable || 'game.exe';

    return [
      {
        type: 'launch_game',
        properties: {
          client_track_timestamp: now - 180000,
          client_send_timestamp: now,
          game_id: gameId,
          game_name: gameName,
          game_executable: gameExecutable,
          verified: true
        }
      },
      {
        type: 'running_game_heartbeat',
        properties: {
          client_track_timestamp: now - 90000,
          client_heartbeat_session_id: sessionId,
          event_sequence_number: 1,
          game_id: gameId,
          game_name: gameName,
          game_executable: gameExecutable,
          game_detection_enabled: true,
          initial_heartbeat: true,
          final_heartbeat: false,
          duration_tracked_ms: 90000,
          client_app_state: 'focused',
          client_send_timestamp: now
        }
      },
      {
        type: 'running_game_heartbeat',
        properties: {
          client_track_timestamp: now,
          client_heartbeat_session_id: sessionId,
          event_sequence_number: 2,
          game_id: gameId,
          game_name: gameName,
          game_executable: gameExecutable,
          game_detection_enabled: true,
          initial_heartbeat: false,
          final_heartbeat: true,
          duration_tracked_ms: 180000,
          client_app_state: 'focused',
          client_send_timestamp: now
        }
      }
    ];
  }

  /**
   * Build Playtime Continuous Heartbeat Event
   */
  createPlaytimeHeartbeatEvent(game, sessionId, sequenceNumber, isInitial = false, durationMs = 60000, isFinal = false) {
    const now = Date.now();
    const gameId = String(game.id);
    const gameName = game.name;
    const gameExecutable = game.executable || 'game.exe';

    const events = [];

    if (isInitial) {
      events.push({
        type: 'launch_game',
        properties: {
          client_track_timestamp: now - 500,
          client_send_timestamp: now,
          game_id: gameId,
          game_name: gameName,
          game_executable: gameExecutable,
          verified: true
        }
      });
    }

    events.push({
      type: 'running_game_heartbeat',
      properties: {
        client_track_timestamp: now,
        client_heartbeat_session_id: sessionId,
        event_sequence_number: sequenceNumber,
        game_id: gameId,
        game_name: gameName,
        game_executable: gameExecutable,
        game_detection_enabled: true,
        initial_heartbeat: isInitial,
        final_heartbeat: isFinal,
        duration_tracked_ms: durationMs,
        client_app_state: 'focused',
        client_send_timestamp: now
      }
    });

    return events;
  }

  getCleanBrowserHeaders(userToken) {
    let cleanToken = (userToken || '').trim().replace(/^['"]|['"]$/g, '').replace(/^(Authorization:|Bearer|Bot)\s+/i, '').trim();
    return {
      'Authorization': cleanToken,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8',
      'Content-Type': 'application/json'
    };
  }

  /**
   * Fetch Active Quests for the user
   */
  async getQuests(userToken) {
    try {
      const response = await axios.get(`${DISCORD_API_BASE}/quests/@me`, {
        headers: this.getCleanBrowserHeaders(userToken),
        timeout: 10000
      });

      return {
        success: true,
        quests: response.data?.quests || []
      };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || error.message,
        status: error.response?.status
      };
    }
  }

  /**
   * Enroll user into a Discord Quest
   */
  async enrollQuest(userToken, questId) {
    const headers = this.getCleanBrowserHeaders(userToken);
    const body = { location: 11, is_targeted: false, metadata_raw: null };
    try {
      let response;
      try {
        response = await axios.post(`${DISCORD_API_BASE}/quests/${questId}/enroll`, body, { headers, timeout: 10000 });
      } catch (e1) {
        response = await axios.post(`${DISCORD_API_BASE}/quests/${questId}/accept`, body, { headers, timeout: 10000 });
      }

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || error.message,
        status: error.response?.status
      };
    }
  }

  /**
   * Claim reward for a completed Discord Quest
   */
  async claimQuest(userToken, questId, platform = 'desktop') {
    try {
      const response = await axios.post(`${DISCORD_API_BASE}/quests/${questId}/claim`, {
        platform: platform
      }, {
        headers: this.getCleanBrowserHeaders(userToken),
        timeout: 10000
      });

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || error.message,
        status: error.response?.status
      };
    }
  }

  /**
   * Send heartbeat to Discord Quest endpoint
   */
  async sendQuestHeartbeat(userToken, questId, streamKey = 'heartbeat', terminal = false) {
    try {
      const response = await axios.post(`${DISCORD_API_BASE}/quests/${questId}/heartbeat`, {
        stream_key: streamKey,
        terminal: Boolean(terminal)
      }, {
        headers: this.getCleanBrowserHeaders(userToken),
        timeout: 10000
      });

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || error.message,
        status: error.response?.status
      };
    }
  }

  /**
   * Send video progress for Video-based Quests (e.g. trailer quests)
   */
  async sendQuestVideoProgress(userToken, questId, timestamp = 30) {
    try {
      const response = await axios.post(`${DISCORD_API_BASE}/quests/${questId}/video-progress`, {
        timestamp: parseFloat(timestamp)
      }, {
        headers: this.getCleanBrowserHeaders(userToken),
        timeout: 10000
      });

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || error.message,
        status: error.response?.status
      };
    }
  }

  // ==========================================
  // PROFILE & IDENTITY MANAGEMENT
  // ==========================================

  /**
   * Update Profile (Display Name / Global Name, Bio, Pronouns, Accent Color)
   */
  async updateProfile(userToken, { global_name, bio, pronouns, accent_color }) {
    const results = {};
    try {
      // 1. Update basic user info (global_name / Display Name)
      if (global_name !== undefined) {
        const resUser = await axios.patch(`${DISCORD_API_BASE}/users/@me`, {
          global_name: global_name ? global_name.trim() : null
        }, {
          headers: this.getHeaders(userToken),
          timeout: 10000
        });
        results.user = resUser.data;
      }

      // 2. Update extended profile info (Bio / About Me, Pronouns, Accent Color)
      const profilePayload = {};
      if (bio !== undefined) profilePayload.bio = bio;
      if (pronouns !== undefined) profilePayload.pronouns = pronouns;
      if (accent_color !== undefined) profilePayload.accent_color = accent_color;

      if (Object.keys(profilePayload).length > 0) {
        const resProfile = await axios.patch(`${DISCORD_API_BASE}/users/@me/profile`, profilePayload, {
          headers: this.getHeaders(userToken),
          timeout: 10000
        });
        results.profile = resProfile.data;
      }

      return { success: true, data: results };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || error.message,
        status: error.response?.status
      };
    }
  }

  /**
   * Join or Switch HypeSquad House
   * houseId: 1 = Bravery (Purple), 2 = Brilliance (Orange), 3 = Balance (Cyan), 0 = Leave
   */
  async setHypeSquad(userToken, houseId) {
    try {
      if (houseId === 0 || !houseId) {
        // Leave HypeSquad
        await axios.delete(`${DISCORD_API_BASE}/hypesquad/online`, {
          headers: this.getHeaders(userToken),
          timeout: 10000
        });
        return { success: true, houseId: 0, message: 'Đã rời khỏi HypeSquad' };
      } else {
        // Join/Switch HypeSquad House
        await axios.post(`${DISCORD_API_BASE}/hypesquad/online`, {
          house_id: parseInt(houseId)
        }, {
          headers: this.getHeaders(userToken),
          timeout: 10000
        });
        return { success: true, houseId: parseInt(houseId) };
      }
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || error.message,
        status: error.response?.status
      };
    }
  }

  // ==========================================
  // RELATIONSHIPS & FRIENDS MANAGEMENT
  // ==========================================

  /**
   * Get all relationships (Friends, Incoming, Outgoing, Blocked)
   */
  async getRelationships(userToken) {
    try {
      const response = await axios.get(`${DISCORD_API_BASE}/users/@me/relationships`, {
        headers: this.getHeaders(userToken),
        timeout: 10000
      });
      return {
        success: true,
        data: response.data || []
      };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || error.message,
        status: error.response?.status
      };
    }
  }

  /**
   * Remove friend, cancel request, or unblock user
   */
  async removeRelationship(userToken, targetUserId) {
    try {
      await axios.delete(`${DISCORD_API_BASE}/users/@me/relationships/${targetUserId}`, {
        headers: this.getHeaders(userToken),
        timeout: 10000
      });
      return { success: true, targetUserId };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || error.message,
        status: error.response?.status
      };
    }
  }

  // ==========================================
  // SERVERS & GUILDS MANAGEMENT
  // ==========================================

  /**
   * Get list of all joined guilds
   */
  async getGuilds(userToken) {
    try {
      const response = await axios.get(`${DISCORD_API_BASE}/users/@me/guilds`, {
        headers: this.getHeaders(userToken),
        timeout: 10000
      });
      return {
        success: true,
        data: response.data || []
      };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || error.message,
        status: error.response?.status
      };
    }
  }

  /**
   * Leave a server / guild
   */
  async leaveGuild(userToken, guildId) {
    try {
      await axios.delete(`${DISCORD_API_BASE}/users/@me/guilds/${guildId}`, {
        headers: this.getHeaders(userToken),
        timeout: 10000
      });
      return { success: true, guildId };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || error.message,
        status: error.response?.status
      };
    }
  }

  // ==========================================
  // CHAT & MESSAGING AUTOMATOR
  // ==========================================

  /**
   * Fetch messages from a channel (DM or Guild Channel)
   */
  async getMessages(userToken, channelId, before = null, limit = 100) {
    try {
      let url = `${DISCORD_API_BASE}/channels/${channelId}/messages?limit=${limit}`;
      if (before) {
        url += `&before=${before}`;
      }
      const response = await axios.get(url, {
        headers: this.getHeaders(userToken),
        timeout: 10000
      });
      return {
        success: true,
        data: response.data || []
      };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || error.message,
        status: error.response?.status
      };
    }
  }

  /**
   * Delete a specific message
   */
  async deleteMessage(userToken, channelId, messageId) {
    try {
      await axios.delete(`${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}`, {
        headers: this.getHeaders(userToken),
        timeout: 10000
      });
      return { success: true, messageId };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || error.message,
        status: error.response?.status
      };
    }
  }

  /**
   * Send a message to a channel / DM
   */
  async sendMessage(userToken, channelId, content) {
    try {
      const response = await axios.post(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
        content: content
      }, {
        headers: this.getHeaders(userToken),
        timeout: 10000
      });
      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || error.message,
        status: error.response?.status
      };
    }
  }

  // ==========================================
  // SECURITY & AUDIT
  // ==========================================

  /**
   * Get authorized OAuth2 applications / bots
   */
  async getOAuthTokens(userToken) {
    try {
      const response = await axios.get(`${DISCORD_API_BASE}/oauth2/tokens`, {
        headers: this.getHeaders(userToken),
        timeout: 10000
      });
      return {
        success: true,
        data: response.data || []
      };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || error.message,
        status: error.response?.status
      };
    }
  }

  /**
   * Revoke an authorized OAuth2 application
   */
  async revokeOAuthToken(userToken, tokenId) {
    try {
      await axios.delete(`${DISCORD_API_BASE}/oauth2/tokens/${tokenId}`, {
        headers: this.getHeaders(userToken),
        timeout: 10000
      });
      return { success: true, tokenId };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || error.message,
        status: error.response?.status
      };
    }
  }

  /**
   * Get active user login sessions
   */
  async getAuthSessions(userToken) {
    try {
      const response = await axios.get(`${DISCORD_API_BASE}/users/@me/auth-sessions`, {
        headers: this.getHeaders(userToken),
        timeout: 10000
      });
      return {
        success: true,
        data: response.data?.user_sessions || response.data || []
      };
    } catch (error) {
      // Fallback endpoint if auth-sessions not available
      try {
        const res2 = await axios.get(`${DISCORD_API_BASE}/users/@me/sessions`, {
          headers: this.getHeaders(userToken),
          timeout: 10000
        });
        return {
          success: true,
          data: res2.data || []
        };
      } catch (e2) {
        return {
          success: false,
          message: error.response?.data?.message || error.message,
          status: error.response?.status
        };
      }
    }
  }
}

module.exports = new DiscordClient();
