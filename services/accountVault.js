const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');

class AccountVault {
  constructor() {
    this.accounts = [];
    this.activeAccountId = null;
    this.init();
  }

  init() {
    try {
      if (fs.existsSync(ACCOUNTS_FILE)) {
        const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
        this.accounts = JSON.parse(raw);
        if (this.accounts.length > 0) {
          const active = this.accounts.find(a => a.isActive);
          this.activeAccountId = active ? active.id : this.accounts[0].id;
        }
      } else {
        this.accounts = [];
        this.save();
      }
    } catch (e) {
      this.accounts = [];
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
      fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(this.accounts, null, 2), 'utf-8');
    } catch (e) {
      console.warn('Failed to save accounts vault:', e.message);
    }
  }

  getAccounts() {
    return this.accounts.map(acc => ({
      id: acc.id,
      label: acc.label || acc.username,
      username: acc.username,
      global_name: acc.global_name,
      avatar: acc.avatar,
      userId: acc.userId,
      isActive: acc.id === this.activeAccountId,
      addedAt: acc.addedAt
    }));
  }

  getAccountById(id) {
    return this.accounts.find(a => a.id === id);
  }

  getActiveAccount() {
    return this.accounts.find(a => a.id === this.activeAccountId);
  }

  addOrUpdateAccount(token, profile, label = 'Tài khoản chính') {
    const cleanToken = (token || '').trim().replace(/^['"]|['"]$/g, '').replace(/^(Authorization:|Bearer|Bot)\s+/i, '').trim();
    const existingIndex = this.accounts.findIndex(a => a.userId === profile.id || a.token === cleanToken);

    const accountObj = {
      id: existingIndex >= 0 ? this.accounts[existingIndex].id : uuidv4().slice(0, 8),
      token: cleanToken,
      userId: profile.id,
      username: profile.username,
      global_name: profile.global_name || profile.username,
      avatar: profile.avatar,
      label: label || profile.username,
      addedAt: new Date().toISOString(),
      isActive: true
    };

    // Mark others inactive
    this.accounts.forEach(a => { a.isActive = false; });

    if (existingIndex >= 0) {
      this.accounts[existingIndex] = accountObj;
    } else {
      this.accounts.push(accountObj);
    }

    this.activeAccountId = accountObj.id;
    this.save();
    return accountObj;
  }

  setActiveAccount(id) {
    const found = this.accounts.find(a => a.id === id);
    if (!found) return null;

    this.accounts.forEach(a => { a.isActive = (a.id === id); });
    this.activeAccountId = id;
    this.save();
    return found;
  }

  removeAccount(id) {
    this.accounts = this.accounts.filter(a => a.id !== id);
    if (this.activeAccountId === id) {
      this.activeAccountId = this.accounts.length > 0 ? this.accounts[0].id : null;
      if (this.activeAccountId) {
        const newActive = this.accounts.find(a => a.id === this.activeAccountId);
        if (newActive) newActive.isActive = true;
      }
    }
    this.save();
    return true;
  }
}

module.exports = new AccountVault();
