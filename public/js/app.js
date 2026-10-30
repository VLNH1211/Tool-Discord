// Discord Mission Control Suite v3.0 - Frontend Application Logic

class App {
  constructor() {
    this.user = null;
    this.token = localStorage.getItem('discord_user_token') || null;
    this.accounts = [];
    this.autoScroll = true;
    this.activeLogFilter = 'ALL';
    this.diversityTarget = 100;
    this.selectedPlaytimeGame = {
      id: '730',
      name: 'Counter-Strike 2',
      executable: 'cs2.exe'
    };
    this.friendsList = [];
    this.currentFriendFilter = '1'; // 1: Friends, 4: Outgoing, 3: Incoming, 2: Blocked
    this.serversList = [];
    this.logs = [];
    this.eventSource = null;
    this.searchTimeout = null;

    this.init();
  }

  async init() {
    this.setupEventListeners();
    this.initSSE();
    this.loadPresets();
    await this.syncAccountsWithServer();

    if (this.token) {
      await this.login(this.token, false);
    } else {
      this.fetchInitialStatus();
    }
  }

  // --- SSE CONNECTION ---
  initSSE() {
    if (this.eventSource) {
      this.eventSource.close();
    }

    const badge = document.getElementById('sseStatusBadge');
    const badgeText = document.getElementById('sseStatusText');

    this.eventSource = new EventSource('/api/events');

    this.eventSource.onopen = () => {
      badge.className = 'hidden sm:flex items-center space-x-2 text-xs bg-[#1e1f22] px-3 py-1.5 rounded-full border border-[#3f4147]';
      badgeText.className = 'text-emerald-400 font-mono';
      badgeText.textContent = 'Đã kết nối SSE';
    };

    this.eventSource.onerror = () => {
      badgeText.className = 'text-rose-400 font-mono';
      badgeText.textContent = 'Mất kết nối - Đang kết nối lại...';
    };

    this.eventSource.addEventListener('init', (e) => {
      const data = JSON.parse(e.data);
      if (data.user) this.renderUserProfile(data.user);
      if (data.diversity) this.updateDiversityUI(data.diversity);
      if (data.playtime) this.updatePlaytimeUI(data.playtime);
      if (data.quest) this.updateQuestRunningUI(data.quest);
      if (data.purge) this.updatePurgeUI(data.purge);
      if (data.stream) this.updateStreamUI(data.stream);
      if (data.autoResponder) this.updateAutoResponderUI(data.autoResponder);
      if (data.accounts) {
        const perm = this.getPermanentAccounts();
        const serverList = data.accounts || [];
        const missingOnServer = perm.filter(pa => pa.token && !serverList.some(sa => sa.userId === pa.userId));
        if (missingOnServer.length > 0) {
          this.syncAccountsWithServer();
        } else {
          this.accounts = serverList;
          this.renderAccountsVault();
        }
      }
      if (data.logs) {
        data.logs.forEach(log => this.appendLog(log, false));
        this.scrollToBottom();
      }
    });

    this.eventSource.addEventListener('log', (e) => {
      const log = JSON.parse(e.data);
      this.appendLog(log, true);
    });

    this.eventSource.addEventListener('logs_cleared', () => {
      document.getElementById('terminalOutput').innerHTML = '';
      this.logs = [];
      this.updateLogCount();
    });

    this.eventSource.addEventListener('diversity_status', (e) => {
      this.updateDiversityUI(JSON.parse(e.data));
    });

    this.eventSource.addEventListener('playtime_status', (e) => {
      this.updatePlaytimeUI(JSON.parse(e.data));
    });

    this.eventSource.addEventListener('quest_status', (e) => {
      this.updateQuestRunningUI(JSON.parse(e.data));
    });

    this.eventSource.addEventListener('purge_status', (e) => {
      this.updatePurgeUI(JSON.parse(e.data));
    });

    this.eventSource.addEventListener('stream_update', (e) => {
      this.updateStreamUI(JSON.parse(e.data));
    });

    this.eventSource.addEventListener('accounts_update', (e) => {
      this.accounts = JSON.parse(e.data);
      this.renderAccountsVault();
    });

    this.eventSource.addEventListener('user_update', (e) => {
      const data = JSON.parse(e.data);
      this.renderUserProfile(data.user);
    });
  }

  async fetchInitialStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      if (data.user) this.renderUserProfile(data.user);
      if (data.diversity) this.updateDiversityUI(data.diversity);
      if (data.playtime) this.updatePlaytimeUI(data.playtime);
      if (data.quest) this.updateQuestRunningUI(data.quest);
      if (data.purge) this.updatePurgeUI(data.purge);
      if (data.stream) this.updateStreamUI(data.stream);
      if (data.autoResponder) this.updateAutoResponderUI(data.autoResponder);
      if (data.accounts) {
        const perm = this.getPermanentAccounts();
        const serverList = data.accounts || [];
        const missingOnServer = perm.filter(pa => pa.token && !serverList.some(sa => sa.userId === pa.userId));
        if (missingOnServer.length > 0) {
          this.syncAccountsWithServer();
        } else {
          this.accounts = serverList;
          this.renderAccountsVault();
        }
      }
    } catch (e) {
      console.warn('Status fetch error:', e);
    }
  }

  // --- AUTHENTICATION & MULTI-ACCOUNT ---
  async login(token, showToast = true, label = '') {
    const alertBox = document.getElementById('tokenModalAlert');
    const btnSubmit = document.getElementById('btnSubmitToken');
    let cleanToken = (token || '').trim().replace(/^['"]|['"]$/g, '').replace(/^(Authorization:|Bearer|Bot)\s+/i, '').trim();

    if (!cleanToken) {
      if (alertBox) {
        alertBox.className = 'text-xs p-3 rounded-xl border font-mono bg-rose-500/10 border-rose-500/30 text-rose-300 block mb-2';
        alertBox.textContent = 'Vui lòng dán chuỗi User Token hợp lệ.';
      } else {
        alert('Vui lòng dán chuỗi User Token hợp lệ.');
      }
      return;
    }

    if (btnSubmit) {
      btnSubmit.disabled = true;
      btnSubmit.innerHTML = `<span class="inline-block animate-spin mr-1">↻</span> Đang xác thực...`;
    }

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cleanToken, label: label || 'Tài khoản chính' })
      });
      const data = await res.json();

      if (data.success) {
        this.user = data.profile;
        this.token = cleanToken;
        localStorage.setItem('discord_user_token', cleanToken);
        this.savePermanentAccount({
          userId: data.profile.id,
          username: data.profile.username,
          global_name: data.profile.global_name,
          avatar: data.profile.avatar,
          token: cleanToken,
          label: label || data.account?.label || 'Tài khoản chính',
          isActive: true
        });
        this.renderUserProfile(data.profile);
        if (data.accounts) {
          this.accounts = data.accounts;
          this.renderAccountsVault();
        }

        if (alertBox) {
          alertBox.className = 'text-xs p-3 rounded-xl border font-mono bg-emerald-500/10 border-emerald-500/30 text-emerald-300 block mb-2';
          alertBox.textContent = `✅ Xác thực thành công: @${data.profile.username}!`;
        }

        this.setStoredToken(cleanToken, cleanToken);
        this.setStoredToken(data.profile.id, cleanToken);
        this.setStoredToken(data.profile.username, cleanToken);
        if (data.account?.id) this.setStoredToken(data.account.id, cleanToken);

        setTimeout(() => {
          this.closeTokenModal();
          this.loadQuests();
        }, 500);
      } else {
        const errorMsg = data.message || 'Token không hợp lệ hoặc đã hết hạn (Mã 401).';
        if (alertBox) {
          alertBox.className = 'text-xs p-3 rounded-xl border font-mono bg-rose-500/10 border-rose-500/30 text-rose-300 block mb-2';
          alertBox.textContent = `❌ Đăng nhập thất bại: ${errorMsg}`;
        } else {
          alert(`Đăng nhập thất bại: ${errorMsg}`);
        }
      }
    } catch (err) {
      if (alertBox) {
        alertBox.className = 'text-xs p-3 rounded-xl border font-mono bg-rose-500/10 border-rose-500/30 text-rose-300 block mb-2';
        alertBox.textContent = `❌ Lỗi kết nối local: ${err.message}`;
      }
    } finally {
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.innerHTML = `<span>Xác thực & Thêm vào Vault</span>`;
      }
    }
  }

  async logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    this.user = null;
    this.token = null;
    localStorage.removeItem('discord_user_token');
    this.renderUserProfile(null);
  }

  async switchAccount(accountId) {
    try {
      const res = await fetch('/api/accounts/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId })
      });
      const data = await res.json();
      if (data.success) {
        this.user = data.profile;
        this.token = data.profile.token || this.token;
        this.renderUserProfile(data.profile);
        if (data.accounts) {
          this.accounts = data.accounts;
          this.renderAccountsVault();
        }
        alert(`Đã chuyển sang tài khoản @${data.profile.username}!`);
      } else {
        alert(data.message);
      }
    } catch (e) {
      alert(`Lỗi chuyển tài khoản: ${e.message}`);
    }
  }

  async deleteAccountFromVault(accountId) {
    if (!confirm('Bạn có chắc muốn xóa tài khoản này khỏi Vault?')) return;
    const res = await fetch(`/api/accounts/${accountId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      this.accounts = data.accounts;
      this.renderAccountsVault();
    }
  }

  renderUserProfile(profile) {
    const area = document.getElementById('userProfileArea');
    if (!profile) {
      area.innerHTML = `
        <button id="btnLoginModal" onclick="window.discordApp?.openTokenModal()" class="flex items-center space-x-2 bg-[#5865f2] hover:bg-[#4752c4] text-white px-4 py-2 rounded-lg font-bold text-xs sm:text-sm transition-all shadow-md hover:shadow-indigo-500/25 cursor-pointer">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path></svg>
          <span>Nhập User Token</span>
        </button>`;
      return;
    }

    const avatarUrl = profile.avatar
      ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=64`
      : 'https://cdn.discordapp.com/embed/avatars/0.png';

    const displayName = profile.global_name || profile.username;

    area.innerHTML = `
      <div class="flex items-center space-x-3 bg-[#1e1f22] pl-2 pr-3 py-1 rounded-xl border border-[#383a40]">
        <img src="${avatarUrl}" alt="Avatar" class="w-8 h-8 rounded-full border border-[#5865f2]/50 object-cover">
        <div class="flex flex-col">
          <div class="flex items-center space-x-1.5">
            <span class="text-xs font-bold text-white max-w-[120px] truncate">${this.escapeHtml(displayName)}</span>
            <span class="text-[10px] text-[#949ba4] font-mono">@${this.escapeHtml(profile.username)}</span>
          </div>
          <div class="flex items-center space-x-1.5 text-[10px]">
            <span class="text-emerald-400 font-mono">Analytics: OK</span>
          </div>
        </div>
        <button id="btnLogout" title="Đăng xuất" class="ml-2 text-[#949ba4] hover:text-red-400 p-1 rounded transition-colors cursor-pointer">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path></svg>
        </button>
      </div>`;

    document.getElementById('btnLogout')?.addEventListener('click', () => this.logout());

    const streamerLabel = document.getElementById('streamerActiveUserLabel');
    if (streamerLabel) {
      streamerLabel.textContent = `@${profile.username} (${profile.id})`;
    }
  }

  getStoredTokens() {
    try {
      return JSON.parse(localStorage.getItem('discord_tokens_vault') || '{}');
    } catch (e) {
      return {};
    }
  }

  setStoredToken(identifier, token) {
    if (!identifier || !token) return;
    try {
      const tokens = this.getStoredTokens();
      tokens[String(identifier)] = String(token).trim();
      localStorage.setItem('discord_tokens_vault', JSON.stringify(tokens));
    } catch (e) {}
  }

  getPermanentAccounts() {
    try {
      const raw = localStorage.getItem('discord_permanent_vault');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {}

    let legacy = [];
    try {
      const stored = localStorage.getItem('discord_vault_accounts');
      if (stored) legacy = JSON.parse(stored);
    } catch (e) {}

    const tokens = this.getStoredTokens();
    const migrated = (legacy || []).map(acc => ({
      ...acc,
      token: acc.token || tokens[acc.id] || tokens[acc.userId] || tokens[acc.username] || (acc.isActive ? this.token : null)
    })).filter(acc => acc.token);

    if (migrated.length > 0) {
      try {
        localStorage.setItem('discord_permanent_vault', JSON.stringify(migrated));
      } catch (e) {}
      return migrated;
    }
    return [];
  }

  savePermanentAccount(accountObj) {
    if (!accountObj || !accountObj.token) return;
    try {
      const accounts = this.getPermanentAccounts();
      const cleanToken = String(accountObj.token).trim();
      const idx = accounts.findIndex(a => (accountObj.userId && a.userId === accountObj.userId) || (accountObj.id && a.id === accountObj.id) || a.token === cleanToken);
      if (idx >= 0) {
        accounts[idx] = { ...accounts[idx], ...accountObj, token: cleanToken };
      } else {
        accounts.push({ ...accountObj, token: cleanToken });
      }
      localStorage.setItem('discord_permanent_vault', JSON.stringify(accounts));
      if (accountObj.userId) this.setStoredToken(accountObj.userId, cleanToken);
      if (accountObj.id) this.setStoredToken(accountObj.id, cleanToken);
    } catch (e) {}
  }

  async syncAccountsWithServer() {
    try {
      const permAccounts = this.getPermanentAccounts();

      // 1. Fetch current server accounts
      const res = await fetch('/api/accounts');
      const data = await res.json();
      let serverAccounts = data.accounts || [];

      // 2. Identify missing accounts on server that we have locally with tokens
      const missingOnServer = permAccounts.filter(pa => 
        pa.token && !serverAccounts.some(sa => sa.userId === pa.userId)
      );

      if (missingOnServer.length > 0) {
        const syncRes = await fetch('/api/accounts/sync-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accounts: missingOnServer })
        });
        const syncData = await syncRes.json();
        if (syncData.success && syncData.accounts) {
          serverAccounts = syncData.accounts;
        }
      }

      this.accounts = serverAccounts;
      this.saveAccountsToStorage();
      this.renderAccountsVault();
    } catch (e) {
      console.warn('Sync accounts error:', e);
    }
  }

  saveAccountsToStorage() {
    try {
      const perm = this.getPermanentAccounts();
      const merged = (this.accounts || []).map(acc => {
        const found = perm.find(p => p.userId === acc.userId || p.id === acc.id);
        return {
          ...acc,
          token: found?.token || (acc.isActive ? this.token : null)
        };
      });
      localStorage.setItem('discord_permanent_vault', JSON.stringify(merged));
      localStorage.setItem('discord_vault_accounts', JSON.stringify(this.accounts));
    } catch (e) {}
  }

  renderAccountsVault() {
    this.saveAccountsToStorage();
    this.renderNavbarAccountSwitcher();
    this.renderAccountCards();

    // Populate Stream viewer dropdown
    const viewerSelect = document.getElementById('streamViewerAccountSelect');
    if (viewerSelect) {
      const curVal = viewerSelect.value;
      viewerSelect.innerHTML = '<option value="">-- Chọn từ Két tài khoản hoặc tự vào phòng --</option>';
      (this.accounts || []).forEach(acc => {
        const opt = document.createElement('option');
        opt.value = acc.id;
        opt.textContent = `${acc.label || acc.username} (@${acc.username}) ${acc.isActive ? '[👑 Chính]' : '[👤 Phụ]'}`;
        viewerSelect.appendChild(opt);
      });
      if (curVal) viewerSelect.value = curVal;
    }

    // Populate Playtime account dropdown
    const playtimeSelect = document.getElementById('playtimeAccountSelect');
    if (playtimeSelect) {
      const curVal = playtimeSelect.value;
      playtimeSelect.innerHTML = '';
      (this.accounts || []).forEach(acc => {
        const opt = document.createElement('option');
        opt.value = acc.id;
        opt.textContent = `${acc.label || acc.username} (@${acc.username}) ${acc.isActive ? '[👑 Đang chọn]' : ''}`;
        if (acc.isActive) opt.selected = true;
        playtimeSelect.appendChild(opt);
      });
      if (curVal) playtimeSelect.value = curVal;
    }

    // Update active labels
    const activeAcc = this.accounts.find(a => a.isActive);
    if (activeAcc) {
      const playtimeUserLabel = document.getElementById('playtimeActiveUserLabel');
      if (playtimeUserLabel) {
        playtimeUserLabel.textContent = `@${activeAcc.username} (${activeAcc.userId})`;
      }
      const streamerLabel = document.getElementById('streamerActiveUserLabel');
      if (streamerLabel) {
        streamerLabel.textContent = `@${activeAcc.username} (${activeAcc.userId})`;
      }
    }
  }

  renderNavbarAccountSwitcher() {
    const nav = document.getElementById('navAccountSwitcher');
    if (!nav) return;

    if (!this.accounts || this.accounts.length === 0) {
      nav.innerHTML = `
        <span class="text-[11px] text-[#949ba4] px-2 py-0.5 font-mono">0 tài khoản</span>
      `;
      return;
    }

    nav.innerHTML = `
      <div class="flex items-center space-x-1.5">
        ${this.accounts.map(acc => {
          const avatarUrl = acc.avatar
            ? `https://cdn.discordapp.com/avatars/${acc.userId}/${acc.avatar}.png?size=32`
            : 'https://cdn.discordapp.com/embed/avatars/0.png';
          return `
            <button class="nav-account-btn flex items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              acc.isActive 
                ? 'bg-[#5865f2] text-white shadow-sm ring-1 ring-indigo-300/40' 
                : 'bg-[#2b2d31] hover:bg-[#383a40] text-[#949ba4] hover:text-white'
            }" data-id="${acc.id}" title="Chuyển sang @${this.escapeHtml(acc.username)}">
              <img src="${avatarUrl}" class="w-4 h-4 rounded-full object-cover">
              <span class="max-w-[70px] truncate">${this.escapeHtml(acc.username)}</span>
              ${acc.isActive ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>' : ''}
            </button>
          `;
        }).join('')}
        <button onclick="window.discordApp?.openTokenModal()" class="text-xs px-2 py-1 text-[#949ba4] hover:text-white hover:bg-[#2b2d31] rounded-lg transition-all" title="Thêm tài khoản khác">+</button>
      </div>
    `;

    nav.querySelectorAll('.nav-account-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const currentActive = this.accounts.find(a => a.isActive);
        if (currentActive && currentActive.id === id) return;
        this.switchAccount(id);
      });
    });
  }

  renderAccountCards() {
    const container = document.getElementById('vaultAccountsCards');
    if (!container) return;

    if (!this.accounts || this.accounts.length === 0) {
      container.innerHTML = `
        <div class="col-span-full bg-[#242629] p-8 rounded-2xl border border-dashed border-[#3f4147] text-center space-y-3">
          <div class="w-12 h-12 mx-auto rounded-full bg-[#1e1f22] flex items-center justify-center text-[#949ba4]">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>
          </div>
          <h4 class="text-sm font-bold text-white">Chưa có tài khoản nào được kết nối</h4>
          <p class="text-xs text-[#949ba4] max-w-sm mx-auto">Thêm tài khoản chính và tài khoản phụ để bắt đầu điều khiển và cày 5.000 giờ tự động.</p>
          <button onclick="window.discordApp?.openTokenModal()" class="bg-[#5865f2] hover:bg-[#4752c4] text-white text-xs px-4 py-2 rounded-xl font-bold shadow-md transition-all">
            + Thêm Tài Khoản Đầu Tiên
          </button>
        </div>
      `;
      return;
    }

    container.innerHTML = this.accounts.map(acc => {
      const avatarUrl = acc.avatar
        ? `https://cdn.discordapp.com/avatars/${acc.userId}/${acc.avatar}.png?size=128`
        : 'https://cdn.discordapp.com/embed/avatars/0.png';

      const isVerified = acc.verified !== false;
      const emailDisplay = acc.email || 'Chưa cung cấp';
      const phoneDisplay = acc.phone || 'Chưa liên kết SĐT';

      return `
        <div class="bg-[#242629] rounded-2xl border ${acc.isActive ? 'border-[#5865f2] shadow-xl shadow-indigo-500/10' : 'border-[#383a40]'} overflow-hidden flex flex-col justify-between transition-all hover:border-[#5865f2]/60">
          <!-- Banner Header -->
          <div class="h-20 bg-gradient-to-r ${acc.isActive ? 'from-indigo-600 via-indigo-500 to-purple-600' : 'from-[#2c2d31] via-[#35373d] to-[#40434a]'} px-4 py-3 flex items-start justify-between relative">
            <span class="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full shadow-sm flex items-center space-x-1 ${acc.isActive ? 'bg-emerald-500 text-white font-mono' : 'bg-black/50 text-indigo-200 font-mono'}">
              <span>${acc.isActive ? '👑 TÀI KHOẢN CHÍNH' : '👤 TÀI KHOẢN PHỤ (CLONE)'}</span>
            </span>
            <button class="btn-del-account bg-black/40 hover:bg-rose-600/80 text-gray-300 hover:text-white p-1.5 rounded-lg transition-colors cursor-pointer" data-id="${acc.id}" title="Xóa tài khoản khỏi danh sách">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </button>
          </div>

          <!-- Profile Body -->
          <div class="px-5 pb-5 pt-0 space-y-4">
            <!-- Avatar & ID Badge Row -->
            <div class="flex items-end justify-between -mt-9">
              <div class="relative">
                <img src="${avatarUrl}" class="w-16 h-16 rounded-2xl border-4 border-[#242629] object-cover shadow-xl bg-[#1e1f22]">
                <span class="absolute bottom-1 right-1 w-3.5 h-3.5 rounded-full border-2 border-[#242629] ${acc.isActive ? 'bg-emerald-500 animate-pulse' : 'bg-gray-500'}"></span>
              </div>
              <div class="bg-[#1e1f22] border border-[#3f4147] px-3 py-1.5 rounded-xl text-right shadow-sm mb-0.5">
                <span class="text-[9px] text-[#949ba4] font-mono block uppercase tracking-wider">Discord ID</span>
                <span class="text-xs font-mono text-white font-bold tracking-tight">${acc.userId || 'N/A'}</span>
              </div>
            </div>

            <!-- Identity info -->
            <div>
              <h3 class="text-lg font-black text-white truncate">${this.escapeHtml(acc.global_name || acc.username)}</h3>
              <div class="text-xs text-indigo-400 font-mono font-bold">@${this.escapeHtml(acc.username)}</div>
            </div>

            <!-- Email, Verified & Phone Block -->
            <div class="space-y-2 text-xs pt-2 border-t border-[#383a40]">
              <div class="flex items-center justify-between">
                <span class="text-[#949ba4]">Hộp thư Email:</span>
                <span class="font-mono text-white text-xs truncate max-w-[210px]" title="${this.escapeHtml(emailDisplay)}">${this.escapeHtml(emailDisplay)}</span>
              </div>
              
              <div>
                ${isVerified 
                  ? `<div class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-3 py-1.5 rounded-xl flex items-center space-x-1.5 font-medium text-xs">
                      <svg class="w-4 h-4 shrink-0 text-emerald-400" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>
                      <span>Email đã xác thực (Sẵn sàng 100%)</span>
                    </div>` 
                  : `<div class="bg-amber-500/10 text-amber-300 border border-amber-500/30 px-3 py-1.5 rounded-xl flex items-start space-x-1.5 text-xs">
                      <svg class="w-4 h-4 shrink-0 mt-0.5 text-amber-400" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"></path></svg>
                      <span>Vui lòng vào Gmail bấm xác thực để mở WebSocket Gateway!</span>
                    </div>`
                }
              </div>

              <div class="flex items-center justify-between text-xs pt-0.5">
                <span class="text-[#949ba4]">Số điện thoại:</span>
                <span class="font-mono text-gray-300">${this.escapeHtml(phoneDisplay)}</span>
              </div>
            </div>

            <!-- Card Actions -->
            <div class="pt-3 border-t border-[#383a40] space-y-2">
              ${!acc.isActive ? `
                <button class="btn-card-switch w-full bg-[#5865f2] hover:bg-[#4752c4] text-white py-2.5 rounded-xl text-xs font-bold transition-all shadow-md flex items-center justify-center space-x-1.5 cursor-pointer" data-id="${acc.id}">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                  <span>Kích hoạt làm Tài khoản chính</span>
                </button>
              ` : `
                <div class="w-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 py-2 rounded-xl text-xs font-bold text-center font-mono flex items-center justify-center space-x-1.5">
                  <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                  <span>✓ ĐANG ĐIỀU KHIỂN CHÍNH</span>
                </div>
              `}
              
              <div class="grid grid-cols-2 gap-2 text-xs">
                <button class="btn-card-farm bg-[#1e1f22] hover:bg-[#383a40] text-indigo-300 hover:text-white py-2 px-2.5 rounded-xl border border-[#3f4147] transition-all font-semibold flex items-center justify-center space-x-1 cursor-pointer" data-id="${acc.id}">
                  <span>⏳ Cày 5000h</span>
                </button>
                <button class="btn-card-viewer bg-[#1e1f22] hover:bg-[#383a40] text-emerald-300 hover:text-white py-2 px-2.5 rounded-xl border border-[#3f4147] transition-all font-semibold flex items-center justify-center space-x-1 cursor-pointer" data-id="${acc.id}">
                  <span>📺 Khán giả Stream</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Attach card event listeners
    container.querySelectorAll('.btn-card-switch').forEach(btn => {
      btn.addEventListener('click', () => this.switchAccount(btn.dataset.id));
    });

    container.querySelectorAll('.btn-del-account').forEach(btn => {
      btn.addEventListener('click', () => this.deleteAccountFromVault(btn.dataset.id));
    });

    container.querySelectorAll('.btn-card-farm').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const acc = this.accounts.find(a => a.id === id);
        if (!acc) return;
        if (!acc.isActive) {
          await this.switchAccount(id);
        }
        // Jump to subtab playtime
        document.querySelector('[data-tab="tab-badges"]')?.click();
        document.querySelector('[data-subtab="sub-playtime"]')?.click();
      });
    });

    container.querySelectorAll('.btn-card-viewer').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const viewerSelect = document.getElementById('streamViewerAccountSelect');
        if (viewerSelect) {
          viewerSelect.value = id;
        }
        // Jump to subtab stream
        document.querySelector('[data-tab="tab-badges"]')?.click();
        document.querySelector('[data-subtab="sub-stream"]')?.click();
        this.showToast('Đã chọn tài khoản này làm Khán giả (Viewer) cho Stream!', 'success');
      });
    });
  }

  // --- RICH PRESENCE STUDIO ---
  async setSpotifyPresence() {
    const song = document.getElementById('spotifySong').value.trim() || 'Starboy';
    const artist = document.getElementById('spotifyArtist').value.trim() || 'The Weeknd';
    const album = document.getElementById('spotifyAlbum').value.trim() || 'Starboy';
    const durationSec = parseInt(document.getElementById('spotifyDuration').value) || 230;

    await fetch('/api/presence/spotify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ song, artist, album, durationSec })
    });
    alert(`Đã kích hoạt giả lập Spotify: "${song}" - ${artist}`);
  }

  async clearPresence() {
    await fetch('/api/presence/clear', { method: 'POST' });
    alert('Đã xóa bỏ trạng thái hiển thị trên hồ sơ!');
  }

  async setStreamingPresence() {
    const title = document.getElementById('streamTitle').value.trim() || 'Live Coding';
    const twitchUrl = document.getElementById('streamUrl').value.trim() || 'https://twitch.tv/discord';

    await fetch('/api/presence/streaming', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, twitchUrl })
    });
    alert(`Đã bật trạng thái Streaming (Tím): "${title}"`);
  }

  async setCustomGamePresence() {
    const gameName = document.getElementById('customPresName').value.trim() || 'Visual Studio Code';
    const details = document.getElementById('customPresDetails').value.trim();
    const button1Label = document.getElementById('customPresBtn1Label').value.trim();
    const button1Url = document.getElementById('customPresBtn1Url').value.trim();
    const button2Label = document.getElementById('customPresBtn2Label').value.trim();
    const button2Url = document.getElementById('customPresBtn2Url').value.trim();

    await fetch('/api/presence/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameName,
        details,
        state: 'Pro Mode',
        button1Label,
        button1Url,
        button2Label,
        button2Url
      })
    });
    alert(`Đã kích hoạt Custom Presence: "${gameName}"`);
  }

  async setHypeSquadHouse(houseId) {
    if (!this.token) {
      this.openTokenModal();
      return;
    }
    const res = await fetch('/api/profile/hypesquad', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ houseId })
    });
    const data = await res.json();
    if (data.success) {
      alert('Đã cập nhật nhà HypeSquad thành công! Làm mới Discord để xem huy hiệu mới.');
    } else {
      alert(`Lỗi đổi HypeSquad: ${data.message}`);
    }
  }

  async saveProfileInfo() {
    if (!this.token) {
      this.openTokenModal();
      return;
    }
    const global_name = document.getElementById('profileGlobalName').value.trim();
    const bio = document.getElementById('profileBio').value.trim();

    const payload = {};
    if (global_name) payload.global_name = global_name;
    if (bio) payload.bio = bio;

    const res = await fetch('/api/profile/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      alert('Đã cập nhật hồ sơ cá nhân thành công!');
    } else {
      alert(`Lỗi cập nhật hồ sơ: ${data.message}`);
    }
  }

  // --- GHOST MESSAGE PURGER ---
  async startMessagePurge() {
    if (!this.token) {
      this.openTokenModal();
      return;
    }
    const channelId = document.getElementById('purgeChannelId').value.trim();
    const delayMs = parseInt(document.getElementById('purgeDelayMs').value) || 1200;

    if (!channelId) {
      alert('Vui lòng nhập Channel ID hoặc DM ID cần xóa tin nhắn!');
      return;
    }

    const res = await fetch('/api/messages/purge-start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, delayMs })
    });
    const data = await res.json();
    if (!data.success) alert(data.message);
  }

  async stopMessagePurge() {
    await fetch('/api/messages/purge-stop', { method: 'POST' });
  }

  updatePurgeUI(status) {
    const isRunning = status.status === 'running';
    document.getElementById('btnStartPurge').disabled = isRunning;
    document.getElementById('btnStopPurge').disabled = !isRunning;
    document.getElementById('purgeScannedCount').textContent = status.totalScanned || 0;
    document.getElementById('purgeDeletedCount').textContent = status.totalDeleted || 0;
  }

  // --- AFK AUTO RESPONDER ---
  async saveAutoResponderSettings() {
    const enabled = document.getElementById('autoResponderToggle').checked;
    const message = document.getElementById('autoResponderMessage').value.trim();
    const cooldownMinutes = parseInt(document.getElementById('autoResponderCooldown').value) || 15;

    await fetch('/api/auto-responder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, message, cooldownMinutes })
    });
    alert('Đã lưu cấu hình AFK Auto-Responder!');
  }

  updateAutoResponderUI(settings) {
    if (settings.enabled !== undefined) {
      document.getElementById('autoResponderToggle').checked = Boolean(settings.enabled);
    }
    if (settings.message) {
      document.getElementById('autoResponderMessage').value = settings.message;
    }
    if (settings.cooldownMinutes) {
      document.getElementById('autoResponderCooldown').value = settings.cooldownMinutes;
    }
  }

  // --- FRIENDS MANAGER ---
  async loadFriends() {
    if (!this.token) return;
    const tbody = document.getElementById('friendsTableBody');
    tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-[#949ba4]"><div class="inline-block animate-spin h-5 w-5 border-b-2 border-indigo-400"></div> Đang quét danh sách bạn bè...</td></tr>`;

    try {
      const res = await fetch('/api/friends');
      const data = await res.json();
      this.friendsList = data.data || [];
      this.renderFriendsTable();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-rose-400">Lỗi: ${e.message}</td></tr>`;
    }
  }

  renderFriendsTable() {
    const tbody = document.getElementById('friendsTableBody');
    const filtered = this.friendsList.filter(f => String(f.type) === String(this.currentFriendFilter));

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-[#949ba4]">Không có mục nào trong danh mục này.</td></tr>`;
      return;
    }

    const typeNames = {
      '1': '<span class="text-emerald-400 font-bold">Bạn Bè</span>',
      '2': '<span class="text-rose-400 font-bold">Đã Chặn</span>',
      '3': '<span class="text-amber-400 font-bold">Lời Mời Đến</span>',
      '4': '<span class="text-blue-400 font-bold">Lời Mời Đã Gửi</span>'
    };

    tbody.innerHTML = filtered.map(f => {
      const u = f.user || {};
      const avatarUrl = u.avatar
        ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=32`
        : 'https://cdn.discordapp.com/embed/avatars/0.png';

      return `
        <tr class="hover:bg-white/[0.02]">
          <td class="p-3"><input type="checkbox" class="friend-checkbox" value="${u.id}"></td>
          <td class="p-3 flex items-center space-x-2.5">
            <img src="${avatarUrl}" class="w-6 h-6 rounded-full object-cover">
            <div>
              <span class="font-bold text-white">${this.escapeHtml(u.global_name || u.username)}</span>
              <span class="text-[#949ba4] text-[10px] block">@${this.escapeHtml(u.username)}</span>
            </div>
          </td>
          <td class="p-3 font-mono text-[#949ba4]">${u.id}</td>
          <td class="p-3 font-mono text-[11px]">${typeNames[String(f.type)] || f.type}</td>
        </tr>
      `;
    }).join('');
  }

  async batchUnfriend() {
    const checked = Array.from(document.querySelectorAll('.friend-checkbox:checked')).map(cb => cb.value);
    if (checked.length === 0) {
      alert('Vui lòng chọn ít nhất một người dùng từ bảng!');
      return;
    }
    if (!confirm(`Bạn có chắc muốn gỡ / hủy kết bạn với ${checked.length} người này?`)) return;

    const res = await fetch('/api/friends/remove-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIds: checked })
    });
    const data = await res.json();
    if (data.success) {
      alert(`Đã hoàn tất gỡ ${data.count} người dùng!`);
      this.loadFriends();
    }
  }

  // --- SERVERS MANAGER ---
  async loadServers() {
    if (!this.token) return;
    const tbody = document.getElementById('serversTableBody');
    tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-[#949ba4]"><div class="inline-block animate-spin h-5 w-5 border-b-2 border-indigo-400"></div> Đang quét các Server đã tham gia...</td></tr>`;

    try {
      const res = await fetch('/api/servers');
      const data = await res.json();
      this.serversList = data.data || [];
      this.renderServersTable();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-rose-400">Lỗi: ${e.message}</td></tr>`;
    }
  }

  renderServersTable() {
    const tbody = document.getElementById('serversTableBody');
    if (!this.serversList || this.serversList.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-[#949ba4]">Không tìm thấy Server nào.</td></tr>`;
      return;
    }

    tbody.innerHTML = this.serversList.map(s => {
      const iconUrl = s.icon
        ? `https://cdn.discordapp.com/icons/${s.id}/${s.icon}.png?size=32`
        : 'https://cdn.discordapp.com/embed/avatars/0.png';

      return `
        <tr class="hover:bg-white/[0.02]">
          <td class="p-3"><input type="checkbox" class="server-checkbox" value="${s.id}"></td>
          <td class="p-3 flex items-center space-x-2.5">
            <img src="${iconUrl}" class="w-6 h-6 rounded-lg object-cover">
            <span class="font-bold text-white">${this.escapeHtml(s.name)}</span>
          </td>
          <td class="p-3 font-mono text-[#949ba4]">${s.id}</td>
          <td class="p-3 font-mono text-[11px]">${s.owner ? '<span class="text-amber-400 font-bold">Owner 👑</span>' : '<span class="text-gray-400">Thành viên</span>'}</td>
        </tr>
      `;
    }).join('');
  }

  async batchLeaveServers() {
    const checked = Array.from(document.querySelectorAll('.server-checkbox:checked')).map(cb => cb.value);
    if (checked.length === 0) {
      alert('Vui lòng chọn ít nhất một Server từ bảng!');
      return;
    }
    if (!confirm(`Bạn có chắc muốn RỜI HÀNG LOẠT ${checked.length} server này?`)) return;

    const res = await fetch('/api/servers/leave-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guildIds: checked })
    });
    const data = await res.json();
    if (data.success) {
      alert(`Đã hoàn tất rời ${data.count} server!`);
      this.loadServers();
    }
  }

  // --- SECURITY & SESSIONS ---
  async loadSessions() {
    const container = document.getElementById('activeSessionsList');
    container.innerHTML = `<div class="col-span-full text-center py-6 text-xs text-[#949ba4]">Đang quét các phiên đăng nhập...</div>`;

    const res = await fetch('/api/security/sessions');
    const data = await res.json();
    const sessions = data.data || [];

    if (sessions.length === 0) {
      container.innerHTML = `<div class="col-span-full text-center py-6 text-xs text-[#949ba4]">Không tìm thấy phiên đăng nhập mở rộng.</div>`;
      return;
    }

    container.innerHTML = sessions.map(s => `
      <div class="bg-[#1e1f22] p-3 rounded-xl border border-[#383a40] space-y-1 text-xs font-mono">
        <div class="flex items-center justify-between">
          <span class="font-bold text-white">${this.escapeHtml(s.client_info?.os || 'Desktop')}</span>
          <span class="text-[10px] text-emerald-400 font-bold">${s.current_session ? 'Hiện tại' : ''}</span>
        </div>
        <div class="text-[11px] text-[#949ba4]">Client: ${this.escapeHtml(s.client_info?.client || 'Discord Client')}</div>
        <div class="text-[10px] text-gray-500">Hoạt động: ${s.approx_last_used_time ? new Date(s.approx_last_used_time).toLocaleString('vi-VN') : 'Gần đây'}</div>
      </div>
    `).join('');
  }

  async loadOAuth() {
    const container = document.getElementById('oauthTokensList');
    container.innerHTML = `<div class="text-center py-6 text-xs text-[#949ba4]">Đang quét các ứng dụng OAuth2...</div>`;

    const res = await fetch('/api/security/oauth');
    const data = await res.json();
    const tokens = data.data || [];

    if (tokens.length === 0) {
      container.innerHTML = `<div class="text-center py-6 text-xs text-[#949ba4]">Không có ứng dụng nào được cấp quyền ủy quyền.</div>`;
      return;
    }

    container.innerHTML = tokens.map(t => {
      const app = t.application || {};
      const iconUrl = app.icon
        ? `https://cdn.discordapp.com/app-icons/${app.id}/${app.icon}.png?size=32`
        : 'https://cdn.discordapp.com/embed/avatars/0.png';

      return `
        <div class="flex items-center justify-between bg-[#1e1f22] p-2.5 rounded-xl border border-[#383a40]">
          <div class="flex items-center space-x-2.5">
            <img src="${iconUrl}" class="w-7 h-7 rounded-lg object-cover">
            <div>
              <span class="text-xs font-bold text-white">${this.escapeHtml(app.name || 'Bot')}</span>
              <span class="text-[10px] text-[#949ba4] block">Scopes: ${(t.scopes || []).join(', ')}</span>
            </div>
          </div>
          <button class="btn-revoke-oauth bg-rose-600/20 hover:bg-rose-600 text-rose-300 hover:text-white px-2 py-1 rounded text-xs font-bold transition-all" data-id="${t.id}">
            Hủy Quyền
          </button>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-revoke-oauth').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Bạn có chắc muốn hủy quyền ứng dụng này?')) return;
        const res2 = await fetch('/api/security/revoke-oauth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokenId: btn.dataset.id })
        });
        const data2 = await res2.json();
        if (data2.success) {
          alert('Đã hủy quyền ứng dụng thành công!');
          this.loadOAuth();
        }
      });
    });
  }

  // --- BADGES: GAME DIVERSITY ---
  async startDiversity() {
    if (!this.token) {
      this.openTokenModal();
      return;
    }
    const res = await fetch('/api/diversity/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetCount: this.diversityTarget })
    });
    const data = await res.json();
    if (!data.success) alert(data.message);
  }

  async pauseDiversity() { await fetch('/api/diversity/pause', { method: 'POST' }); }
  async resumeDiversity() { await fetch('/api/diversity/resume', { method: 'POST' }); }
  async stopDiversity() { await fetch('/api/diversity/stop', { method: 'POST' }); }

  updateDiversityUI(status) {
    const isRunning = status.status === 'running';
    const isPaused = status.status === 'paused';
    const btnStart = document.getElementById('btnStartDiversity');
    const btnPause = document.getElementById('btnPauseDiversity');
    const btnStop = document.getElementById('btnStopDiversity');
    const badge = document.getElementById('diversityStateBadge');

    btnStart.disabled = isRunning || isPaused;
    btnPause.disabled = !isRunning && !isPaused;
    btnStop.disabled = !isRunning && !isPaused;

    if (isPaused) {
      btnPause.textContent = 'Tiếp tục';
      btnPause.onclick = () => this.resumeDiversity();
      badge.textContent = 'Tạm dừng';
      badge.className = 'text-xs font-mono px-2.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-300 border border-yellow-500/30';
    } else if (isRunning) {
      btnPause.textContent = 'Tạm dừng';
      btnPause.onclick = () => this.pauseDiversity();
      badge.textContent = 'Đang chạy (Live)';
      badge.className = 'text-xs font-mono px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 pulse-indicator';
    } else if (status.status === 'completed') {
      badge.textContent = 'Hoàn thành!';
      badge.className = 'text-xs font-mono px-2.5 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30';
    } else {
      badge.textContent = 'Sẵn sàng';
      badge.className = 'text-xs font-mono px-2.5 py-0.5 rounded-full bg-gray-500/20 text-gray-300 border border-gray-500/30';
    }

    const pct = status.target > 0 ? Math.round((status.current / status.target) * 100) : 0;
    document.getElementById('diversityProgressBar').style.width = `${pct}%`;
    document.getElementById('diversityProgressText').textContent = `${status.current} / ${status.target} Games (${pct}%)`;
  }

  // --- BADGES: PLAYTIME ---
  loadPresets() {
    const presets = [
      { id: '730', name: 'Counter-Strike 2', executable: 'cs2.exe' },
      { id: '700136079562375258', name: 'VALORANT', executable: 'VALORANT-Win64-Shipping.exe' },
      { id: '424424351650070529', name: 'Grand Theft Auto V', executable: 'gta5.exe' },
      { id: '356860074901241856', name: 'League of Legends', executable: 'League of Legends.exe' },
      { id: '356875221078245376', name: 'Minecraft', executable: 'javaw.exe' },
      { id: '564177579848564757', name: 'Cyberpunk 2077', executable: 'Cyberpunk2077.exe' }
    ];

    const container = document.getElementById('playtimePresetContainer');
    container.innerHTML = presets.map((p, idx) => `
      <button class="playtime-preset-chip text-xs px-3 py-1.5 rounded-lg border border-[#3f4147] transition-all ${idx === 0 ? 'bg-[#5865f2] text-white font-bold' : 'bg-[#1e1f22] text-[#dbdee1] hover:bg-[#383a40]'}"
        data-id="${p.id}" data-name="${p.name}" data-exe="${p.executable}">
        ${p.name}
      </button>
    `).join('');

    container.querySelectorAll('.playtime-preset-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.playtime-preset-chip').forEach(b => {
          b.className = 'playtime-preset-chip text-xs px-3 py-1.5 rounded-lg border border-[#3f4147] transition-all bg-[#1e1f22] text-[#dbdee1] hover:bg-[#383a40]';
        });
        btn.className = 'playtime-preset-chip text-xs px-3 py-1.5 rounded-lg border border-[#3f4147] transition-all bg-[#5865f2] text-white font-bold';

        this.selectedPlaytimeGame = { id: btn.dataset.id, name: btn.dataset.name, executable: btn.dataset.exe };
        document.getElementById('playtimeSelectedGameTitle').textContent = this.selectedPlaytimeGame.name;
        document.getElementById('playtimeSelectedGameDetails').textContent = `ID: ${this.selectedPlaytimeGame.id} | ${this.selectedPlaytimeGame.executable}`;
      });
    });
  }

  async startPlaytime() {
    if (!this.token) { this.openTokenModal(); return; }
    const intervalSec = parseInt(document.getElementById('playtimeIntervalSelect')?.value) || 30;
    const speedMultiplier = parseInt(document.getElementById('playtimeSpeedMultiplier')?.value) || 1;
    const targetHours = this.targetPlaytimeHours || 5000;

    const res = await fetch('/api/playtime/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameId: this.selectedPlaytimeGame.id,
        gameName: this.selectedPlaytimeGame.name,
        executable: this.selectedPlaytimeGame.executable,
        intervalSec,
        speedMultiplier,
        targetHours
      })
    });
    const data = await res.json();
    if (!data.success) {
      alert(data.message);
    } else {
      const turboNote = speedMultiplier > 1 ? ` (⚡ Turbo ${speedMultiplier}x)` : '';
      this.showToast(`Bắt đầu cày ${targetHours}h game "${this.selectedPlaytimeGame.name}"${turboNote}!`, 'success');
    }
  }

  async turboInject(hours) {
    if (!this.token) { this.openTokenModal(); return; }
    const targetHours = parseInt(hours);
    if (!targetHours || targetHours <= 0) {
      this.showToast('Vui lòng nhập số giờ hợp lệ (> 0)!', 'error');
      return;
    }

    const badge = document.getElementById('turboInjectStatusBadge');
    if (badge) {
      badge.className = 'text-xs font-mono px-3 py-1 rounded-xl bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center space-x-1.5 animate-pulse';
      badge.innerHTML = `<span class="inline-block animate-spin mr-1">↻</span><span>Đang bơm +${targetHours.toLocaleString()}h...</span>`;
    }

    this.showToast(`⚡ Đang gửi gói tin bơm siêu tốc +${targetHours.toLocaleString()} giờ lên Discord...`, 'info');

    try {
      const res = await fetch('/api/playtime/turbo-inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gameId: this.selectedPlaytimeGame.id,
          gameName: this.selectedPlaytimeGame.name,
          executable: this.selectedPlaytimeGame.executable,
          hoursToAdd: targetHours
        })
      });
      const data = await res.json();
      if (!data.success) {
        this.showToast(data.message || 'Lỗi bơm giờ.', 'error');
      } else {
        this.showToast(`👑 Bơm thành công +${data.addedHours.toLocaleString()} giờ! Tổng tích lũy: ${data.totalAccumulatedHours}h. Hãy mở Discord kiểm tra huy hiệu!`, 'success');
      }
    } catch (e) {
      this.showToast(`Lỗi: ${e.message}`, 'error');
    } finally {
      if (badge) {
        badge.className = 'text-xs font-mono px-3 py-1 rounded-xl bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 flex items-center space-x-1.5';
        badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400"></span><span>Đã hoàn tất</span>`;
        setTimeout(() => {
          badge.className = 'text-xs font-mono px-3 py-1 rounded-xl bg-amber-500/10 text-amber-300 border border-amber-500/30 flex items-center space-x-1.5';
          badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span><span>Sẵn sàng bơm</span>`;
        }, 3000);
      }
    }
  }

  async turboInjectDiversity(count) {
    if (!this.token) { this.openTokenModal(); return; }
    const targetCount = parseInt(count);
    if (!targetCount || targetCount <= 0) {
      this.showToast('Vui lòng chọn hoặc nhập số games hợp lệ (> 0)!', 'error');
      return;
    }

    const badge = document.getElementById('turboDiversityStatusBadge');
    if (badge) {
      badge.className = 'text-xs font-mono px-3 py-1 rounded-xl bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 flex items-center space-x-1.5 animate-pulse';
      badge.innerHTML = `<span class="inline-block animate-spin mr-1">↻</span><span>Đang nạp +${targetCount.toLocaleString()} games...</span>`;
    }

    this.showToast(`🎮 Đang kích hoạt gói bơm siêu tốc +${targetCount.toLocaleString()} games lên Discord...`, 'info');

    try {
      const res = await fetch('/api/diversity/turbo-inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetCount })
      });
      const data = await res.json();
      if (!data.success) {
        this.showToast(data.message || 'Lỗi bơm game đa dạng.', 'error');
      } else {
        this.showToast(`👑 Đã bắt đầu nạp +${data.target.toLocaleString()} games! Tiến trình sẽ cập nhật trực tiếp trên thanh trạng thái.`, 'success');
      }
    } catch (e) {
      this.showToast(`Lỗi: ${e.message}`, 'error');
    } finally {
      if (badge) {
        setTimeout(() => {
          badge.className = 'text-xs font-mono px-3 py-1 rounded-xl bg-indigo-500/10 text-indigo-300 border border-indigo-500/30 flex items-center space-x-1.5';
          badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"></span><span>Sẵn sàng nạp</span>`;
        }, 5000);
      }
    }
  }

  async stopPlaytime() { await fetch('/api/playtime/stop', { method: 'POST' }); }

  updatePlaytimeUI(status) {
    if (!status) return;
    const isRunning = status.status === 'running';
    const btnStart = document.getElementById('btnStartPlaytime');
    const btnStop = document.getElementById('btnStopPlaytime');
    if (btnStart) btnStart.disabled = isRunning;
    if (btnStop) btnStop.disabled = !isRunning;

    const sessionSec = status.elapsedSeconds || 0;
    const hrs = String(Math.floor(sessionSec / 3600)).padStart(2, '0');
    const mins = String(Math.floor((sessionSec % 3600) / 60)).padStart(2, '0');
    const secs = String(sessionSec % 60).padStart(2, '0');
    const timerEl = document.getElementById('playtimeBigTimer');
    if (timerEl) timerEl.textContent = `${hrs}:${mins}:${secs}`;

    const totalAccumulatedSec = status.accumulatedSeconds || sessionSec;
    const totalHours = (totalAccumulatedSec / 3600).toFixed(2);
    const targetHours = status.targetHours || this.targetPlaytimeHours || 5000;
    const percent = Math.min(100, (totalHours / targetHours) * 100).toFixed(2);

    const totalHoursEl = document.getElementById('playtimeTotalHoursDisplay');
    if (totalHoursEl) totalHoursEl.textContent = `${totalHours}h`;

    const accTextEl = document.getElementById('playtimeAccumulatedText');
    if (accTextEl) accTextEl.textContent = `${totalHours} / ${targetHours.toLocaleString()} Giờ (${percent}%)`;

    const barEl = document.getElementById('playtimeProgressBar');
    if (barEl) barEl.style.width = `${percent}%`;

    const heartbeatEl = document.getElementById('playtimeHeartbeatCounter');
    if (heartbeatEl) heartbeatEl.textContent = status.totalHeartbeats || 0;

    const badge = document.getElementById('playtimeStateBadge');
    if (badge) {
      if (isRunning) {
        badge.className = 'text-xs font-mono px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold';
        badge.textContent = 'Đang cày (Active)';
      } else {
        badge.className = 'text-xs font-mono px-2.5 py-0.5 rounded-full bg-gray-500/20 text-gray-300 border border-gray-500/30';
        badge.textContent = 'Sẵn sàng';
      }
    }

    const cloudBadge = document.getElementById('playtimeCloudBadge');
    if (cloudBadge) {
      if (isRunning) {
        cloudBadge.className = 'text-[11px] font-mono px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center space-x-1.5 font-bold';
        cloudBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span><span>Cloud 24/7 Running</span>';
      } else {
        cloudBadge.className = 'text-[11px] font-mono px-2.5 py-0.5 rounded-full bg-gray-500/10 text-gray-400 border border-gray-500/20 flex items-center space-x-1';
        cloudBadge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-gray-500"></span><span>Cloud 24/7 Standby</span>';
      }
    }
  }

  // --- HEADLESS STREAMER & SCREEN SHARE AFK ---
  async startStream() {
    const channelId = document.getElementById('streamChannelId')?.value.trim();
    if (!channelId) {
      this.showToast('Vui lòng nhập Voice Channel ID (ID Kênh thoại)!', 'error');
      document.getElementById('streamChannelId')?.focus();
      return;
    }

    const streamerToken = this.token || localStorage.getItem('discord_user_token');
    if (!streamerToken) {
      this.showToast('Chưa có User Token tài khoản chính. Vui lòng đăng nhập trước!', 'error');
      this.openTokenModal();
      return;
    }

    const viewerSelect = document.getElementById('streamViewerAccountSelect')?.value;
    const viewerCustom = document.getElementById('streamViewerTokenCustom')?.value.trim();
    
    // Resolve viewer token from client tokens vault or direct token
    const tokens = this.getStoredTokens();
    let viewerToken = viewerCustom || null;
    if (!viewerToken && viewerSelect) {
      const selectedAcc = (this.accounts || []).find(a => a.id === viewerSelect || a.userId === viewerSelect);
      viewerToken = selectedAcc?.token 
        || (selectedAcc ? tokens[selectedAcc.id] || tokens[selectedAcc.userId] || tokens[selectedAcc.username] : null) 
        || tokens[viewerSelect] 
        || (viewerSelect.includes('.') ? viewerSelect : null);
    }

    const resolution = document.getElementById('streamResolution')?.value || '720p';
    const mode = document.getElementById('streamConnectionMode')?.value || 'cloud';

    const btnStart = document.getElementById('btnStartStream');
    if (btnStart) {
      btnStart.disabled = true;
      btnStart.innerHTML = '<span>Đang kết nối...</span>';
    }

    try {
      const res = await fetch('/api/stream/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          streamerToken,
          viewerToken,
          channelId,
          resolution,
          fps: 15,
          mode
        })
      });
      const data = await res.json();
      if (!data.success) {
        this.showToast(data.message || 'Lỗi khi bắt đầu Stream.', 'error');
        if (btnStart) {
          btnStart.disabled = false;
          btnStart.innerHTML = '<span>Bắt đầu Treo Stream 24/7 (Headless)</span>';
        }
      } else {
        this.showToast('Đã khởi chạy tiến trình Headless Streamer!', 'success');
        this.updateStreamUI(data.status);
      }
    } catch (e) {
      this.showToast(`Lỗi kết nối: ${e.message}`, 'error');
      if (btnStart) {
        btnStart.disabled = false;
        btnStart.innerHTML = '<span>Bắt đầu Treo Stream 24/7 (Headless)</span>';
      }
    }
  }

  async stopStream() {
    const btnStop = document.getElementById('btnStopStream');
    if (btnStop) btnStop.disabled = true;
    try {
      const res = await fetch('/api/stream/stop', { method: 'POST' });
      const data = await res.json();
      this.showToast('Đã gửi lệnh dừng Stream.', 'info');
      this.updateStreamUI(data.status || { running: false });
    } catch (e) {
      this.showToast(`Lỗi: ${e.message}`, 'error');
    }
  }

  updateStreamUI(status) {
    if (!status) return;

    const btnStart = document.getElementById('btnStartStream');
    const btnStop = document.getElementById('btnStopStream');
    const badge = document.getElementById('streamStateBadge');
    const timer = document.getElementById('streamTimer');
    const loopInfo = document.getElementById('streamLoopInfo');
    const streamerIndicator = document.getElementById('streamerStatusIndicator');
    const viewerIndicator = document.getElementById('viewerStatusIndicator');
    const channelNameEl = document.getElementById('streamChannelName');

    if (status.running) {
      if (btnStart) {
        btnStart.disabled = true;
        btnStart.className = 'flex-1 bg-[#313338] text-gray-400 py-2.5 rounded-lg font-bold text-xs cursor-not-allowed';
        btnStart.innerHTML = '<span>● Đang Stream 24/7</span>';
      }
      if (btnStop) {
        btnStop.disabled = false;
        btnStop.className = 'bg-[#da373c] hover:bg-[#c02e33] text-white px-5 py-2.5 rounded-lg font-bold text-xs shadow-md transition-all cursor-pointer';
      }
      if (badge) {
        badge.className = 'text-xs font-mono px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
        badge.textContent = 'Đang phát Go Live';
      }
    } else {
      if (btnStart) {
        btnStart.disabled = false;
        btnStart.className = 'flex-1 bg-[#5865f2] hover:bg-[#4752c4] text-white py-2.5 rounded-lg font-bold text-xs shadow-md transition-all flex items-center justify-center space-x-2 cursor-pointer';
        btnStart.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><span>Bắt đầu Treo Stream 24/7 (Headless)</span>';
      }
      if (btnStop) {
        btnStop.disabled = true;
        btnStop.className = 'disabled:opacity-40 disabled:cursor-not-allowed bg-[#da373c] text-white px-5 py-2.5 rounded-lg font-bold text-xs';
      }
      if (badge) {
        badge.className = 'text-xs font-mono px-3 py-1 rounded-full bg-gray-500/20 text-gray-300 border border-gray-500/30';
        badge.textContent = 'Sẵn sàng';
      }
    }

    if (timer) {
      const totalSec = status.elapsedSeconds || 0;
      const hrs = String(Math.floor(totalSec / 3600)).padStart(2, '0');
      const mins = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
      const secs = String(totalSec % 60).padStart(2, '0');
      timer.textContent = `${hrs}:${mins}:${secs}`;
    }

    if (loopInfo) {
      loopInfo.textContent = `Gói RTP Video: ${status.loopCount || 0} loops`;
    }

    if (streamerIndicator) {
      if (status.streamerState === 'streaming') {
        streamerIndicator.className = 'font-semibold text-emerald-400 font-mono';
        streamerIndicator.textContent = '● Đang Stream Go Live';
      } else if (status.streamerState === 'connected') {
        streamerIndicator.className = 'font-semibold text-blue-400 font-mono';
        streamerIndicator.textContent = 'Đã vào phòng';
      } else if (status.streamerState === 'logging_in') {
        streamerIndicator.className = 'font-semibold text-amber-400 font-mono';
        streamerIndicator.textContent = 'Đang đăng nhập...';
      } else if (status.streamerState === 'error') {
        streamerIndicator.className = 'font-semibold text-rose-400 font-mono';
        streamerIndicator.textContent = 'Lỗi kết nối';
      } else {
        streamerIndicator.className = 'font-semibold text-gray-400 font-mono';
        streamerIndicator.textContent = 'Chưa kết nối';
      }
    }

    if (viewerIndicator) {
      if (status.viewerState === 'connected') {
        viewerIndicator.className = 'font-semibold text-emerald-400 font-mono';
        viewerIndicator.textContent = '● Đã vào làm khán giả';
      } else if (status.viewerState === 'logging_in') {
        viewerIndicator.className = 'font-semibold text-amber-400 font-mono';
        viewerIndicator.textContent = 'Đang kết nối...';
      } else if (status.viewerState === 'disabled') {
        viewerIndicator.className = 'font-semibold text-amber-300 font-mono';
        viewerIndicator.textContent = 'Chờ vào thủ công';
      } else if (status.viewerState === 'error') {
        viewerIndicator.className = 'font-semibold text-rose-400 font-mono';
        viewerIndicator.textContent = 'Lỗi kết nối nick phụ';
      } else {
        viewerIndicator.className = 'font-semibold text-gray-400 font-mono';
        viewerIndicator.textContent = 'Chưa vào phòng';
      }
    }

    if (channelNameEl && (status.channelName || status.channelId)) {
      channelNameEl.textContent = status.channelName ? `#${status.channelName}` : status.channelId;
    }
  }

  // --- BADGES: QUESTS ---
  async loadQuests() {
    const grid = document.getElementById('questsGrid');
    if (!grid) return;
    grid.innerHTML = `<div class="col-span-full text-center py-8 text-[#949ba4]"><div class="inline-block animate-spin h-6 w-6 border-b-2 border-amber-400 mb-2"></div><p>Đang quét Discord Quests từ máy chủ...</p></div>`;

    try {
      const headers = {};
      if (this.token) headers['Authorization'] = this.token;

      const res = await fetch('/api/quests', { headers });
      const data = await res.json();

      if (!data.success) {
        grid.innerHTML = `<div class="col-span-full text-center py-8 text-rose-400">❌ ${this.escapeHtml(data.message || 'Lỗi tải danh sách Quests.')}</div>`;
        return;
      }

      const quests = data.quests || [];
      if (quests.length === 0) {
        grid.innerHTML = `<div class="col-span-full text-center py-8 text-[#949ba4]">Hiện không có Quest nào khả dụng hoặc bạn đã hoàn thành hết!</div>`;
        return;
      }

      grid.innerHTML = quests.map(q => {
        const questName = q.config?.messages?.quest_name || q.config?.messages?.game_title || 'Discord Quest';
        const gameTitle = q.config?.messages?.game_title || q.config?.application?.name || 'Game';
        const appId = q.config?.application?.id || '';
        const taskObj = q.config?.task_config_v2?.tasks?.PLAY_ON_DESKTOP || q.config?.task_config?.tasks?.PLAY_ON_DESKTOP || Object.values(q.config?.task_config_v2?.tasks || q.config?.task_config?.tasks || {})[0];
        const targetSeconds = taskObj?.target || 900;
        const targetMins = Math.round(targetSeconds / 60);
        const isCompleted = Boolean(q.user_status?.completed_at);
        const isClaimed = Boolean(q.user_status?.claimed_at);

        let actionButton = '';
        if (isClaimed) {
          actionButton = `<button disabled class="w-full bg-[#1e1f22] text-[#949ba4] py-2 rounded-xl text-xs font-semibold border border-[#3f4147] cursor-not-allowed">✅ Đã nhận thưởng</button>`;
        } else if (isCompleted) {
          actionButton = `<button class="btn-claim-quest w-full bg-emerald-500 hover:bg-emerald-600 text-black py-2 rounded-xl text-xs font-bold transition-all shadow-md cursor-pointer" data-id="${q.id}">🎁 Bấm Nhận Thưởng Ngay</button>`;
        } else {
          actionButton = `<button class="btn-farm-quest w-full bg-amber-500 hover:bg-amber-600 text-black py-2 rounded-xl text-xs font-bold transition-all shadow-md cursor-pointer flex items-center justify-center space-x-1.5"
            data-id="${q.id}" data-name="${this.escapeHtml(questName)}" data-appid="${appId}" data-gamename="${this.escapeHtml(gameTitle)}" data-target="${targetSeconds}">
            <span>⚡ Tự Động Cày (${targetMins} phút)</span>
          </button>`;
        }

        return `
          <div class="bg-[#242629] rounded-2xl border border-[#383a40] hover:border-amber-500/40 p-5 flex flex-col justify-between space-y-4 shadow-lg transition-all group">
            <div>
              <div class="flex items-center justify-between text-[11px] mb-1">
                <span class="text-amber-400 font-mono font-bold">AppID: ${appId || 'Web'}</span>
                ${isCompleted ? '<span class="text-emerald-400 font-semibold">Hoàn thành 100%</span>' : '<span class="text-[#949ba4]">Chưa hoàn thành</span>'}
              </div>
              <h3 class="text-base font-bold text-white group-hover:text-amber-300 transition-colors">${this.escapeHtml(questName)}</h3>
              <p class="text-xs text-[#949ba4] mt-1">Trò chơi: <strong class="text-indigo-300">${this.escapeHtml(gameTitle)}</strong></p>
            </div>
            ${actionButton}
          </div>
        `;
      }).join('');

      // Wire Farm buttons
      grid.querySelectorAll('.btn-farm-quest').forEach(btn => {
        btn.addEventListener('click', async () => {
          this.showToast(`🚀 Bắt đầu cày Quest: "${btn.dataset.name}"...`, 'info');
          btn.disabled = true;
          btn.innerHTML = `<span class="inline-block animate-spin mr-1">↻</span><span>Đang chạy...</span>`;
          const res = await fetch('/api/quests/start-farm', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': this.token || ''
            },
            body: JSON.stringify({
              questId: btn.dataset.id,
              questName: btn.dataset.name,
              applicationId: btn.dataset.appid,
              gameName: btn.dataset.gamename,
              targetSeconds: parseInt(btn.dataset.target) || 900
            })
          });
          const result = await res.json();
          if (!result.success) {
            this.showToast(result.message || 'Lỗi cày quest', 'error');
            btn.disabled = false;
            btn.textContent = '⚡ Tự Động Cày';
          }
        });
      });

      // Wire Claim buttons
      grid.querySelectorAll('.btn-claim-quest').forEach(btn => {
        btn.addEventListener('click', async () => {
          this.showToast('🎁 Đang nhận phần thưởng Quest...', 'info');
          const res = await fetch('/api/quests/claim', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': this.token || ''
            },
            body: JSON.stringify({ questId: btn.dataset.id })
          });
          const result = await res.json();
          if (result.success) {
            this.showToast('🎉 Nhận thưởng thành công!', 'success');
            this.loadQuests();
          } else {
            this.showToast(`Lỗi nhận thưởng: ${result.message}`, 'error');
          }
        });
      });
    } catch (e) {
      grid.innerHTML = `<div class="col-span-full text-center py-6 text-rose-400">Lỗi tải Quests: ${e.message}</div>`;
    }
  }

  updateQuestRunningUI(status) {
    if (!status) return;

    const btnAuto = document.getElementById('btnAutoFarmAllQuests');
    const btnStop = document.getElementById('btnStopQuestFarm');
    const banner = document.getElementById('questQueueBanner');
    const titleEl = document.getElementById('questQueueCurrentTitle');
    const countBadge = document.getElementById('questQueueCountBadge');
    const timeProgress = document.getElementById('questQueueTimeProgress');
    const progressBar = document.getElementById('questQueueProgressBar');

    const isRunning = status.status === 'running';

    if (btnAuto) {
      if (isRunning) {
        btnAuto.disabled = true;
        btnAuto.classList.add('opacity-50', 'cursor-not-allowed');
        btnAuto.innerHTML = `
          <span class="inline-block animate-spin mr-1.5">↻</span>
          <span>Đang Cày Tự Động...</span>
        `;
      } else {
        btnAuto.disabled = false;
        btnAuto.classList.remove('opacity-50', 'cursor-not-allowed');
        btnAuto.innerHTML = `<span>⚡ Cày Tự Động Tất Cả Quests</span>`;
      }
    }

    if (btnStop) {
      btnStop.disabled = !isRunning;
      if (isRunning) {
        btnStop.classList.remove('disabled:opacity-40', 'disabled:cursor-not-allowed');
      } else {
        btnStop.classList.add('disabled:opacity-40', 'disabled:cursor-not-allowed');
      }
    }

    if (banner) {
      if (isRunning) {
        banner.classList.remove('hidden');
        if (titleEl) {
          titleEl.textContent = status.questName ? `Đang cày: ${status.questName}` : 'Đang cày nhiệm vụ...';
        }
        if (countBadge) {
          if (status.mode === 'all' && status.queueTotal > 0) {
            countBadge.classList.remove('hidden');
            countBadge.textContent = `Nhiệm vụ ${status.queueIndex || 1} / ${status.queueTotal}`;
          } else {
            countBadge.classList.add('hidden');
          }
        }
        if (timeProgress) {
          const currentM = Math.floor((status.elapsedSeconds || 0) / 60);
          const totalM = Math.ceil((status.targetSeconds || 900) / 60);
          timeProgress.textContent = `Tiến độ: ${status.elapsedSeconds || 0}s / ${status.targetSeconds || 900}s (~${currentM}/${totalM} phút) - Game: ${status.gameName || 'Discord'}`;
        }
        if (progressBar) {
          progressBar.style.width = `${status.percentage || 0}%`;
        }
      } else if (status.status === 'completed') {
        banner.classList.remove('hidden');
        if (titleEl) titleEl.textContent = '🎉 Đã hoàn thành nhiệm vụ & tự động nhận thưởng!';
        if (countBadge && status.queueTotal > 0) {
          countBadge.textContent = `${status.queueTotal} / ${status.queueTotal} Quests`;
        }
        if (timeProgress) timeProgress.textContent = 'Toàn bộ phần thưởng đã được nhận thành công!';
        if (progressBar) progressBar.style.width = '100%';
        setTimeout(() => this.loadQuests(), 3000);
      } else if (status.status === 'stopped') {
        if (titleEl) titleEl.textContent = '⏹ Đã dừng tiến trình cày Quests';
        if (timeProgress) timeProgress.textContent = 'Bấm "⚡ Cày Tự Động Tất Cả Quests" để tiếp tục.';
      } else {
        banner.classList.add('hidden');
      }
    }

    // Update individual buttons in grid
    const grid = document.getElementById('questsGrid');
    if (grid) {
      grid.querySelectorAll('.btn-farm-quest').forEach(btn => {
        if (isRunning) {
          if (btn.dataset.id === status.questId) {
            btn.disabled = true;
            btn.className = 'btn-farm-quest w-full bg-amber-600 text-black py-2 rounded-xl text-xs font-bold transition-all shadow-md cursor-wait flex items-center justify-center space-x-1.5';
            btn.innerHTML = `<span class="inline-block animate-spin mr-1">↻</span><span>Đang cày (${status.percentage || 0}%)</span>`;
          } else {
            btn.disabled = true;
            btn.classList.add('opacity-40', 'cursor-not-allowed');
          }
        } else {
          btn.disabled = false;
          btn.classList.remove('opacity-40', 'cursor-not-allowed');
          const targetMins = Math.round((parseInt(btn.dataset.target) || 900) / 60);
          btn.className = 'btn-farm-quest w-full bg-amber-500 hover:bg-amber-600 text-black py-2 rounded-xl text-xs font-bold transition-all shadow-md cursor-pointer flex items-center justify-center space-x-1.5';
          btn.innerHTML = `<span>⚡ Tự Động Cày (${targetMins} phút)</span>`;
        }
      });
    }
  }

  async startAutoFarmAllQuests() {
    if (!this.token) {
      this.openTokenModal();
      return;
    }

    const btnAuto = document.getElementById('btnAutoFarmAllQuests');
    if (btnAuto) {
      btnAuto.disabled = true;
      btnAuto.classList.add('opacity-50', 'cursor-not-allowed');
      btnAuto.innerHTML = `<span class="inline-block animate-spin mr-1.5">↻</span><span>Đang khởi động...</span>`;
    }

    this.showToast('🚀 Đang quét & khởi động chuỗi cày tự động tất cả Discord Quests...', 'info');
    try {
      const res = await fetch('/api/quests/start-farm-all', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.token
        }
      });
      const data = await res.json();
      if (!data.success) {
        this.showToast(data.message || 'Lỗi bắt đầu cày Quests', 'error');
        if (btnAuto) {
          btnAuto.disabled = false;
          btnAuto.classList.remove('opacity-50', 'cursor-not-allowed');
          btnAuto.innerHTML = `<span>⚡ Cày Tự Động Tất Cả Quests</span>`;
        }
      } else {
        this.showToast(data.message || `Đang chạy hàng đợi ${data.total || ''} nhiệm vụ!`, 'success');
      }
    } catch (e) {
      this.showToast(`Lỗi: ${e.message}`, 'error');
      if (btnAuto) {
        btnAuto.disabled = false;
        btnAuto.classList.remove('opacity-50', 'cursor-not-allowed');
        btnAuto.innerHTML = `<span>⚡ Cày Tự Động Tất Cả Quests</span>`;
      }
    }
  }

  async stopQuestFarm() {
    this.showToast('⏹ Đang dừng tiến trình cày Quests...', 'warn');
    try {
      const res = await fetch('/api/quests/stop-farm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.token || ''
        }
      });
      const data = await res.json();
      if (data.success) {
        this.showToast('Đã dừng tiến trình cày Quests!', 'info');
      }
    } catch (e) {
      this.showToast(`Lỗi: ${e.message}`, 'error');
    }
  }

  // --- TERMINAL & LOGS ---
  appendLog(log, live = true) {
    this.logs.push(log);
    this.updateLogCount();

    const container = document.getElementById('terminalOutput');
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML = `
      <span class="text-[#949ba4] font-mono text-[11px] select-none">[${log.time}]</span>
      <span class="log-badge badge-${log.level}">${log.level}</span>
      <span class="flex-1 font-mono text-xs text-[#dbdee1]">${this.escapeHtml(log.message)}</span>
    `;

    container.appendChild(div);
    if (live && this.autoScroll) this.scrollToBottom();
  }

  updateLogCount() {
    document.getElementById('logCounterBadge').textContent = `${this.logs.length} events`;
  }

  scrollToBottom() {
    const el = document.getElementById('terminalOutput');
    el.scrollTop = el.scrollHeight;
  }

  clearLogs() {
    fetch('/api/logs/clear', { method: 'POST' });
  }

  // --- TOKEN MODAL ---
  openTokenModal() {
    const modal = document.getElementById('tokenModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    const alertBox = document.getElementById('tokenModalAlert');
    if (alertBox) alertBox.classList.add('hidden');
    const input = document.getElementById('inputUserToken');
    if (input) {
      input.value = this.token || '';
      setTimeout(() => input.focus(), 60);
    }
  }

  closeTokenModal() {
    const modal = document.getElementById('tokenModal');
    if (!modal) return;
    modal.classList.add('hidden');
  }

  // --- EVENT LISTENERS ---
  setupEventListeners() {
    // Global Event Delegation for Login Modal
    document.addEventListener('click', (e) => {
      if (e.target.closest('#btnLoginModal') || e.target.closest('.btn-open-login')) {
        e.preventDefault();
        this.openTokenModal();
      }
      if (e.target.id === 'tokenModal') this.closeTokenModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeTokenModal();
    });

    const tokenInput = document.getElementById('inputUserToken');
    if (tokenInput) {
      tokenInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          document.getElementById('btnSubmitToken')?.click();
        }
      });
    }

    // Top Tabs Navigation
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.dataset.tab;
        document.querySelectorAll('.tab-btn').forEach(b => {
          b.className = 'tab-btn px-4 py-2.5 font-bold text-xs sm:text-sm rounded-t-lg transition-all flex items-center space-x-2 text-[#949ba4] hover:text-white hover:bg-[#2e3035] whitespace-nowrap';
        });
        btn.className = 'tab-btn active px-4 py-2.5 font-bold text-xs sm:text-sm rounded-t-lg transition-all flex items-center space-x-2 text-white bg-[#2b2d31] border-t-2 border-[#5865f2] whitespace-nowrap';

        document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
        document.getElementById(targetTab)?.classList.remove('hidden');

        // Tab-specific loaders
        if (targetTab === 'tab-badges') this.loadQuests();
        if (targetTab === 'tab-friends') this.loadFriends();
        if (targetTab === 'tab-servers') this.loadServers();
        if (targetTab === 'tab-security') {
          this.renderAccountsVault();
          this.loadSessions();
          this.loadOAuth();
        }
      });
    });

    // Subtabs for Badges
    document.querySelectorAll('.subtab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.subtab;
        document.querySelectorAll('.subtab-btn').forEach(b => {
          b.className = 'subtab-btn px-3.5 py-1.5 rounded-lg bg-[#1e1f22] text-[#949ba4] hover:text-white text-xs font-bold transition-all';
        });
        btn.className = 'subtab-btn active px-3.5 py-1.5 rounded-lg bg-[#5865f2] text-white text-xs font-bold transition-all';

        document.querySelectorAll('.subtab-content').forEach(c => c.classList.add('hidden'));
        document.getElementById(target)?.classList.remove('hidden');
      });
    });

    // Diversity Controls
    document.querySelectorAll('.diversity-target-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.diversity-target-btn').forEach(b => {
          b.className = 'diversity-target-btn bg-[#232428] hover:bg-[#383a40] text-xs px-3 py-1.5 rounded-lg border border-[#3f4147] transition-all font-mono';
        });
        btn.className = 'diversity-target-btn bg-[#5865f2] text-white text-xs px-3 py-1.5 rounded-lg border border-indigo-400 font-bold font-mono';
        this.diversityTarget = parseInt(btn.dataset.target) || 100;
        document.getElementById('btnStartDiversity').innerHTML = `<span>Bắt đầu Boost (${this.diversityTarget} Games)</span>`;
      });
    });

    document.getElementById('btnStartDiversity').addEventListener('click', () => this.startDiversity());
    document.getElementById('btnStopDiversity').addEventListener('click', () => this.stopDiversity());

    // Playtime Target Hours Buttons
    document.querySelectorAll('.playtime-target-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.playtime-target-btn').forEach(b => {
          b.className = 'playtime-target-btn bg-[#232428] hover:bg-[#383a40] text-xs px-2.5 py-1.5 rounded-lg border border-[#3f4147] transition-all font-mono';
        });
        btn.className = 'playtime-target-btn bg-[#5865f2] text-white text-xs px-3 py-1.5 rounded-lg border border-indigo-400 font-bold font-mono';
        this.targetPlaytimeHours = parseInt(btn.dataset.hours) || 5000;
        this.updatePlaytimeUI({ status: 'idle' });
      });
    });

    document.getElementById('playtimeAccountSelect')?.addEventListener('change', (e) => {
      if (e.target.value) {
        this.switchAccount(e.target.value);
      }
    });

    // Playtime Controls
    document.getElementById('btnStartPlaytime').addEventListener('click', () => this.startPlaytime());
    document.getElementById('btnStopPlaytime').addEventListener('click', () => this.stopPlaytime());

    // Turbo Instant Injection Controls
    document.querySelectorAll('.btn-turbo-quick').forEach(btn => {
      btn.addEventListener('click', () => {
        const hours = parseInt(btn.dataset.hours);
        if (hours) this.turboInject(hours);
      });
    });

    document.getElementById('btnExecuteCustomTurbo')?.addEventListener('click', () => {
      const input = document.getElementById('inputCustomTurboHours');
      const hours = parseInt(input?.value);
      if (hours && hours > 0) {
        this.turboInject(hours);
      } else {
        this.showToast('Vui lòng nhập số giờ muốn bơm!', 'error');
        input?.focus();
      }
    });

    // Turbo Diversity Controls
    document.querySelectorAll('.btn-turbo-diversity-quick').forEach(btn => {
      btn.addEventListener('click', () => {
        const count = parseInt(btn.dataset.count);
        if (count) this.turboInjectDiversity(count);
      });
    });

    document.getElementById('btnTurboDiversityCustom')?.addEventListener('click', () => {
      const input = document.getElementById('turboDiversityCustomInput');
      const count = parseInt(input?.value);
      if (count && count > 0) {
        this.turboInjectDiversity(count);
      } else {
        this.showToast('Vui lòng nhập số games muốn bơm!', 'error');
        input?.focus();
      }
    });

    // Headless Stream Controls
    document.getElementById('btnStartStream')?.addEventListener('click', () => this.startStream());
    document.getElementById('btnStopStream')?.addEventListener('click', () => this.stopStream());

    // Quests Controls
    document.getElementById('btnRefreshQuests')?.addEventListener('click', () => this.loadQuests());
    document.getElementById('btnAutoFarmAllQuests')?.addEventListener('click', () => this.startAutoFarmAllQuests());
    document.getElementById('btnStopQuestFarm')?.addEventListener('click', () => this.stopQuestFarm());

    // Presence Studio Controls
    document.getElementById('btnSetSpotify').addEventListener('click', () => this.setSpotifyPresence());
    document.getElementById('btnClearSpotify').addEventListener('click', () => this.clearPresence());
    document.getElementById('btnSetStreaming').addEventListener('click', () => this.setStreamingPresence());
    document.getElementById('btnClearStreaming').addEventListener('click', () => this.clearPresence());
    document.getElementById('btnSetCustomPresence').addEventListener('click', () => this.setCustomGamePresence());

    document.querySelectorAll('.btn-hypesquad').forEach(btn => {
      btn.addEventListener('click', () => this.setHypeSquadHouse(parseInt(btn.dataset.house)));
    });
    document.getElementById('btnSaveProfile').addEventListener('click', () => this.saveProfileInfo());

    // Message Purger Controls
    document.getElementById('btnStartPurge').addEventListener('click', () => this.startMessagePurge());
    document.getElementById('btnStopPurge').addEventListener('click', () => this.stopMessagePurge());

    // Auto Responder Controls
    document.getElementById('btnSaveAutoResponder').addEventListener('click', () => this.saveAutoResponderSettings());

    // Friends Manager Controls
    document.getElementById('btnRefreshFriends').addEventListener('click', () => this.loadFriends());
    document.getElementById('btnBatchUnfriend').addEventListener('click', () => this.batchUnfriend());
    document.querySelectorAll('.friend-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.friend-filter-btn').forEach(b => {
          b.className = 'friend-filter-btn px-3 py-1 rounded text-[#949ba4] hover:text-white';
        });
        btn.className = 'friend-filter-btn active px-3 py-1 rounded bg-[#5865f2] text-white font-bold';
        this.currentFriendFilter = btn.dataset.filter;
        this.renderFriendsTable();
      });
    });
    document.getElementById('selectAllFriends').addEventListener('change', (e) => {
      document.querySelectorAll('.friend-checkbox').forEach(cb => { cb.checked = e.target.checked; });
    });

    // Server Manager Controls
    document.getElementById('btnRefreshServers').addEventListener('click', () => this.loadServers());
    document.getElementById('btnBatchLeaveServers').addEventListener('click', () => this.batchLeaveServers());
    document.getElementById('selectAllServers').addEventListener('change', (e) => {
      document.querySelectorAll('.server-checkbox').forEach(cb => { cb.checked = e.target.checked; });
    });

    // Security Controls
    document.getElementById('btnRefreshSessions').addEventListener('click', () => this.loadSessions());
    document.getElementById('btnRefreshOAuth').addEventListener('click', () => this.loadOAuth());

    // Terminal Controls
    document.getElementById('btnClearLogs').addEventListener('click', () => this.clearLogs());
    const btnAutoScroll = document.getElementById('btnAutoScroll');
    btnAutoScroll.addEventListener('click', () => {
      this.autoScroll = !this.autoScroll;
      btnAutoScroll.textContent = `Auto-scroll: ${this.autoScroll ? 'ON' : 'OFF'}`;
      btnAutoScroll.className = this.autoScroll
        ? 'bg-[#2b2d31] hover:bg-[#383a40] text-emerald-400 px-2.5 py-1 rounded-lg border border-[#3f4147] font-mono'
        : 'bg-[#2b2d31] hover:bg-[#383a40] text-[#949ba4] px-2.5 py-1 rounded-lg border border-[#3f4147] font-mono';
    });

    // Token Modal Controls
    document.getElementById('btnCloseTokenModal').addEventListener('click', () => this.closeTokenModal());
    document.getElementById('btnCancelTokenModal').addEventListener('click', () => this.closeTokenModal());
    document.getElementById('btnSubmitToken').addEventListener('click', () => {
      const val = document.getElementById('inputUserToken').value.trim();
      const label = document.getElementById('inputAccountLabel').value.trim();
      this.login(val, true, label);
    });

    const btnToggleVis = document.getElementById('btnToggleTokenVisibility');
    btnToggleVis.addEventListener('click', () => {
      const input = document.getElementById('inputUserToken');
      if (input.type === 'password') {
        input.type = 'text';
        btnToggleVis.textContent = 'Ẩn';
      } else {
        input.type = 'password';
        btnToggleVis.textContent = 'Hiện';
      }
    });
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// Instantiate on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.discordApp = new App();
});
