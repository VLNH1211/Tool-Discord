const express = require('express');
const cors = require('cors');
const path = require('path');
const detectables = require('./services/detectables');
const discordClient = require('./services/discordClient');
const taskManager = require('./services/taskManager');
const gateway = require('./services/gateway');
const accountVault = require('./services/accountVault');
const streamService = require('./services/streamService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- SSE ENDPOINT ---
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write(': connected\n\n');
  taskManager.addSSEClient(res);

  req.on('close', () => {
    taskManager.removeSSEClient(res);
  });
});

// --- STATUS & SETTINGS ---
streamService.onStatusChange = (status, log) => {
  taskManager.broadcastEvent('stream_update', status);
  if (log && log.message) {
    taskManager.addLog(log.message, (log.type || 'INFO').toUpperCase());
  }
};

app.get('/api/status', (req, res) => {
  res.json({
    user: taskManager.user.profile,
    hasToken: Boolean(taskManager.user.token),
    hasAnalyticsToken: Boolean(taskManager.user.analyticsToken),
    settings: taskManager.settings,
    diversity: taskManager.getDiversityStatus(),
    playtime: taskManager.getPlaytimeStatus(),
    quest: taskManager.getQuestStatus(),
    purge: taskManager.getPurgeStatus(),
    stream: streamService.getStatus(),
    autoResponder: gateway.getAutoResponderSettings(),
    accounts: accountVault.getAccounts(),
    totalGamesLoaded: detectables.getAllGames().length
  });
});

app.post('/api/settings', (req, res) => {
  taskManager.updateSettings(req.body);
  res.json({ success: true, settings: taskManager.settings });
});

// --- AUTHENTICATION & MULTI-ACCOUNT VAULT ---
app.post('/api/auth/login', async (req, res) => {
  const { token, label } = req.body;
  if (!token) {
    return res.status(400).json({ success: false, message: 'Vui lòng cung cấp Discord User Token.' });
  }

  // Sanitize token: remove quotes and potential Authorization / Bearer / Bot prefixes
  let cleanToken = String(token).trim();
  cleanToken = cleanToken.replace(/^['"]|['"]$/g, '').replace(/^(Authorization:|Bearer|Bot)\s+/i, '').trim();

  taskManager.addLog('Đang xác thực Discord Token và lấy Analytics Token...', 'INFO');
  const result = await discordClient.getCurrentUser(cleanToken);

  if (!result.success) {
    taskManager.addLog(`Đăng nhập thất bại: ${result.message}`, 'ERROR');
    return res.status(result.status || 400).json(result);
  }

  const profile = result.data;
  const analyticsToken = profile.analytics_token;

  if (!analyticsToken) {
    taskManager.addLog('Cảnh báo: Discord không trả về analytics_token cho tài khoản này.', 'WARN');
  } else {
    taskManager.addLog(`Xác thực thành công @${profile.username}! Analytics Token đã sẵn sàng.`, 'SUCCESS');
  }

  taskManager.setUser(cleanToken, analyticsToken, profile);
  const savedAccount = accountVault.addOrUpdateAccount(cleanToken, profile, label);

  res.json({
    success: true,
    profile,
    hasAnalyticsToken: Boolean(analyticsToken),
    account: savedAccount,
    accounts: accountVault.getAccounts()
  });
});

app.post('/api/auth/logout', (req, res) => {
  taskManager.setUser(null, null, null);
  gateway.disconnect();
  taskManager.addLog('Đã đăng xuất tài khoản hiện tại.', 'INFO');
  res.json({ success: true });
});

app.get('/api/accounts', (req, res) => {
  res.json({ success: true, accounts: accountVault.getAccounts() });
});

app.post('/api/accounts/add', async (req, res) => {
  try {
    const { token, label } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, message: 'Vui lòng cung cấp Discord User Token.' });
    }
    let cleanToken = String(token).trim().replace(/^['"]|['"]$/g, '').replace(/^(Authorization:|Bearer|Bot)\s+/i, '').trim();
    const result = await discordClient.getCurrentUser(cleanToken);
    if (!result.success) {
      return res.status(result.status || 400).json(result);
    }
    const profile = result.data;
    const savedAccount = accountVault.addOrUpdateAccount(cleanToken, profile, label || 'Tài khoản phụ', false);
    taskManager.addLog(`Đã thêm tài khoản phụ @${profile.username} vào Vault.`, 'SUCCESS');
    taskManager.broadcastEvent('accounts_update', accountVault.getAccounts());
    res.json({
      success: true,
      account: savedAccount,
      accounts: accountVault.getAccounts()
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/accounts/sync-all', async (req, res) => {
  try {
    const { accounts } = req.body;
    if (!Array.isArray(accounts)) {
      return res.status(400).json({ success: false, message: 'Danh sách tài khoản không hợp lệ.' });
    }
    for (const item of accounts) {
      if (!item.token) continue;
      const cleanToken = String(item.token).trim();
      const existing = accountVault.accounts.find(a => a.token === cleanToken || (item.userId && a.userId === item.userId));
      if (!existing) {
        let profile = item.profile || (item.userId ? { id: item.userId, username: item.username, global_name: item.global_name, avatar: item.avatar, email: item.email, phone: item.phone, verified: item.verified } : null);
        const check = await discordClient.getCurrentUser(cleanToken);
        if (check.success) {
          profile = check.data;
        }
        if (profile) {
          accountVault.addOrUpdateAccount(cleanToken, profile, item.label || profile.username, Boolean(item.isActive && !accountVault.getActiveAccount()));
        }
      }
    }
    taskManager.broadcastEvent('accounts_update', accountVault.getAccounts());
    res.json({ success: true, accounts: accountVault.getAccounts() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/accounts/switch', async (req, res) => {
  const { accountId } = req.body;
  const acc = accountVault.setActiveAccount(accountId);
  if (!acc) {
    return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });
  }

  taskManager.addLog(`Đang chuyển sang tài khoản @${acc.username}...`, 'INFO');
  const result = await discordClient.getCurrentUser(acc.token);
  if (!result.success) {
    return res.status(400).json({ success: false, message: 'Token của tài khoản này đã hết hạn.' });
  }

  const profile = result.data;
  taskManager.setUser(acc.token, profile.analytics_token, profile);
  taskManager.addLog(`Đã chuyển đổi sang tài khoản @${profile.username} thành công!`, 'SUCCESS');

  res.json({
    success: true,
    profile: { ...profile, token: acc.token },
    accounts: accountVault.getAccounts()
  });
});

app.delete('/api/accounts/:id', (req, res) => {
  accountVault.removeAccount(req.params.id);
  res.json({ success: true, accounts: accountVault.getAccounts() });
});

// --- PROFILE & IDENTITY MANAGEMENT ---
app.post('/api/profile/update', async (req, res) => {
  if (!taskManager.user.token) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập.' });
  }

  taskManager.addLog('Đang cập nhật hồ sơ cá nhân trên Discord...', 'INFO');
  const result = await discordClient.updateProfile(taskManager.user.token, req.body);
  if (result.success) {
    taskManager.addLog('✅ Cập nhật hồ sơ thành công!', 'SUCCESS');
  } else {
    taskManager.addLog(`❌ Cập nhật hồ sơ thất bại: ${result.message}`, 'ERROR');
  }
  res.json(result);
});

app.post('/api/profile/hypesquad', async (req, res) => {
  if (!taskManager.user.token) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập.' });
  }

  const { houseId } = req.body;
  const houseNames = { 0: 'Rời khỏi', 1: 'Bravery (Dũng Cảm - Tím)', 2: 'Brilliance (Sáng Chói - Cam)', 3: 'Balance (Cân Bằng - Xanh)' };
  taskManager.addLog(`Đang đổi nhà HypeSquad sang: ${houseNames[houseId] || houseId}...`, 'INFO');

  const result = await discordClient.setHypeSquad(taskManager.user.token, houseId);
  if (result.success) {
    taskManager.addLog(`✅ Đã cập nhật huy hiệu HypeSquad: ${houseNames[houseId]}!`, 'SUCCESS');
  } else {
    taskManager.addLog(`❌ Đổi HypeSquad thất bại: ${result.message}`, 'ERROR');
  }
  res.json(result);
});

// --- RICH PRESENCE STUDIO ---
app.post('/api/presence/spotify', (req, res) => {
  gateway.setSpotifyPresence(req.body);
  res.json({ success: true });
});

app.post('/api/presence/streaming', (req, res) => {
  gateway.setStreamingPresence(req.body);
  res.json({ success: true });
});

app.post('/api/presence/custom', (req, res) => {
  gateway.setCustomPresence(req.body);
  res.json({ success: true });
});

app.post('/api/presence/clear', (req, res) => {
  gateway.clearPresence();
  res.json({ success: true });
});

// --- GATEWAY VOICE PRESENCE (OPCODE 4 JOIN/LEAVE) ---
app.post('/api/gateway/voice/join', (req, res) => {
  try {
    const { guildId, channelId, selfMute, selfDeaf, selfVideo } = req.body;
    if (!channelId) {
      return res.status(400).json({ success: false, message: 'Thiếu channelId!' });
    }
    const result = gateway.joinVoiceChannel(guildId, channelId, selfMute, selfDeaf, selfVideo);
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/gateway/voice/leave', (req, res) => {
  try {
    const { guildId } = req.body;
    const result = gateway.leaveVoiceChannel(guildId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// --- AFK AUTO RESPONDER ---
app.get('/api/auto-responder', (req, res) => {
  res.json({ success: true, settings: gateway.getAutoResponderSettings() });
});

app.post('/api/auto-responder', (req, res) => {
  gateway.updateAutoResponderSettings(req.body);
  res.json({ success: true, settings: gateway.getAutoResponderSettings() });
});

// --- GHOST MESSAGE PURGER ---
app.post('/api/messages/purge-start', async (req, res) => {
  try {
    const result = await taskManager.startMessagePurge(req.body);
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/messages/purge-stop', (req, res) => {
  taskManager.stopMessagePurge();
  res.json({ success: true });
});

// --- HEADLESS STREAMER & SCREEN SHARE AFK ---
app.get('/api/stream/status', (req, res) => {
  res.json({ success: true, status: streamService.getStatus() });
});

app.post('/api/stream/start', async (req, res) => {
  try {
    let { streamerToken, viewerToken, guildId, channelId, resolution, fps, mode } = req.body;
    
    // If streamerToken not in body, fallback to taskManager
    if (!streamerToken) {
      streamerToken = taskManager.user.token;
    }

    // Auto-initialize server user if streamerToken was passed from client
    if (streamerToken && (!taskManager.user.token || taskManager.user.token !== streamerToken)) {
      try {
        const check = await discordClient.getCurrentUser(streamerToken);
        if (check.success) {
          taskManager.setUser(streamerToken, check.data.analytics_token, check.data);
          accountVault.addOrUpdateAccount(streamerToken, check.data, 'Tài khoản chính', true);
        }
      } catch (e) {
        console.warn('[Stream Start Auto-Login]:', e.message);
      }
    }

    if (!streamerToken) {
      return res.status(400).json({ 
        success: false, 
        message: 'Chưa có Token tài khoản chính (Streamer). Vui lòng đăng nhập lại!' 
      });
    }

    if (viewerToken) {
      const vaultAcc = accountVault.getAccount(viewerToken);
      if (vaultAcc && vaultAcc.token) {
        viewerToken = vaultAcc.token;
      }
    }

    const result = await streamService.startStream({
      streamerToken,
      viewerToken,
      guildId,
      channelId,
      resolution,
      fps,
      mode: mode || 'cloud'
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/stream/stop', (req, res) => {
  const result = streamService.stopStream();
  res.json(result);
});

// --- FRIENDS & RELATIONSHIPS ---
app.get('/api/friends', async (req, res) => {
  if (!taskManager.user.token) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập.' });
  }
  const result = await discordClient.getRelationships(taskManager.user.token);
  res.json(result);
});

app.post('/api/friends/remove-batch', async (req, res) => {
  try {
    const { userIds, delayMs } = req.body;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Danh sách người dùng không hợp lệ.' });
    }
    const result = await taskManager.batchRemoveRelationships(userIds, delayMs);
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// --- SERVERS & GUILDS ---
app.get('/api/servers', async (req, res) => {
  if (!taskManager.user.token) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập.' });
  }
  const result = await discordClient.getGuilds(taskManager.user.token);
  res.json(result);
});

app.post('/api/servers/leave-batch', async (req, res) => {
  try {
    const { guildIds, delayMs } = req.body;
    if (!Array.isArray(guildIds) || guildIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Danh sách Server không hợp lệ.' });
    }
    const result = await taskManager.batchLeaveGuilds(guildIds, delayMs);
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// --- SECURITY & DEVICE SESSIONS ---
app.get('/api/security/sessions', async (req, res) => {
  if (!taskManager.user.token) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập.' });
  }
  const result = await discordClient.getAuthSessions(taskManager.user.token);
  res.json(result);
});

app.get('/api/security/oauth', async (req, res) => {
  if (!taskManager.user.token) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập.' });
  }
  const result = await discordClient.getOAuthTokens(taskManager.user.token);
  res.json(result);
});

app.post('/api/security/revoke-oauth', async (req, res) => {
  if (!taskManager.user.token) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập.' });
  }
  const { tokenId } = req.body;
  const result = await discordClient.revokeOAuthToken(taskManager.user.token, tokenId);
  if (result.success) {
    taskManager.addLog(`🛡️ Đã hủy ủy quyền Bot/App OAuth ID: ${tokenId}`, 'SUCCESS');
  }
  res.json(result);
});

// --- DETECTABLES / GAMES ---
app.get('/api/games', (req, res) => {
  const { q, limit } = req.query;
  if (q) {
    const results = detectables.searchGames(q, limit ? parseInt(limit) : 40);
    return res.json({ success: true, games: results });
  }
  const presets = detectables.getPresets();
  res.json({ success: true, games: presets });
});

// --- DISCORD QUESTS ---
app.get('/api/quests', async (req, res) => {
  const token = req.headers.authorization || taskManager.user.token;
  if (!token) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập Discord Token.' });
  }
  const result = await discordClient.getQuests(token);
  res.json(result);
});

app.post('/api/quests/enroll', async (req, res) => {
  const { questId } = req.body;
  if (!taskManager.user.token) return res.status(401).json({ success: false, message: 'Chưa đăng nhập.' });
  const result = await discordClient.enrollQuest(taskManager.user.token, questId);
  res.json(result);
});

app.post('/api/quests/claim', async (req, res) => {
  const { questId } = req.body;
  if (!taskManager.user.token) return res.status(401).json({ success: false, message: 'Chưa đăng nhập.' });
  const result = await discordClient.claimQuest(taskManager.user.token, questId);
  res.json(result);
});

app.post('/api/quests/start-farm', async (req, res) => {
  try {
    const result = await taskManager.startQuestFarm(req.body);
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/quests/stop-farm', (req, res) => {
  taskManager.stopQuestFarm();
  res.json({ success: true });
});

// --- GAME DIVERSITY BOOSTER ---
app.post('/api/diversity/start', async (req, res) => {
  try {
    const { targetCount, delayMs, jitterMs } = req.body;
    const result = await taskManager.startDiversity({
      targetCount: parseInt(targetCount) || 100,
      delayMs: parseInt(delayMs) || 1200,
      jitterMs: parseInt(jitterMs) || 500
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/diversity/pause', (req, res) => {
  taskManager.pauseDiversity();
  res.json({ success: true });
});

app.post('/api/diversity/resume', (req, res) => {
  taskManager.resumeDiversity();
  res.json({ success: true });
});

app.post('/api/diversity/stop', (req, res) => {
  taskManager.stopDiversity();
  res.json({ success: true });
});

app.post('/api/diversity/turbo-inject', async (req, res) => {
  try {
    const { targetCount } = req.body;
    const result = await taskManager.turboInjectDiversity({
      targetCount: parseInt(targetCount) || 100
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// --- PLAYTIME HOURS BOOSTER ---
app.post('/api/playtime/start', async (req, res) => {
  try {
    const { gameId, gameName, executable, intervalSec, targetHours, speedMultiplier } = req.body;
    const result = await taskManager.startPlaytime({
      gameId,
      gameName,
      executable,
      intervalSec,
      targetHours,
      speedMultiplier
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/playtime/turbo-inject', async (req, res) => {
  try {
    const { gameId, gameName, executable, hoursToAdd } = req.body;
    const result = await taskManager.turboInjectPlaytime({
      gameId,
      gameName,
      executable,
      hoursToAdd
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/playtime/stop', (req, res) => {
  taskManager.stopPlaytime();
  res.json({ success: true });
});

// --- LOGS ---
app.post('/api/logs/clear', (req, res) => {
  taskManager.clearLogs();
  res.json({ success: true });
});

// Start initialization & server
async function start() {
  console.log('--- KHỞI ĐỘNG DISCORD ACCOUNT MANAGER & AUTOMATION SUITE ---');
  await detectables.init();

  // Auto-login active account if exists
  const activeAcc = accountVault.getActiveAccount();
  if (activeAcc && activeAcc.token) {
    try {
      console.log(`[Vault] Tự động nạp tài khoản: @${activeAcc.username}...`);
      const meRes = await discordClient.getCurrentUser(activeAcc.token);
      if (meRes.success) {
        taskManager.setUser(activeAcc.token, meRes.data.analytics_token, meRes.data);
        console.log(`[Vault] Đã nạp thành công tài khoản @${meRes.data.username}`);
      }
    } catch (e) {
      console.warn('[Vault] Auto-login error:', e.message);
    }
  }

  app.listen(PORT, () => {
    console.log(`\n================================================================`);
    console.log(`[DISCORD SUITE] Mission Control Dashboard: http://localhost:${PORT}`);
    console.log(`================================================================\n`);
  });
}

start();
