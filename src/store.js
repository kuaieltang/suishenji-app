/**
 * 本地存储层：把"手机上的数据"放在浏览器里。
 *
 * 用 localStorage 而不是 IndexedDB：记录是纯文本、体积很小，
 * 而且草稿需要同步写入（每 500ms 一次），同步 API 更不容易出差错。
 * storage 可注入，便于在 Node 里测试。
 */

import {
  createRecord,
  daysToUpload,
  dateKey,
  foldText,
  mergeConfirmations,
} from './core.js';

export const PREFIX = 'suishenji.v1.';

export const KEYS = {
  records: 'records',
  sealed: 'sealed',
  draft: 'draft',
  confirmations: 'confirmations',
  settings: 'settings',
  pending: 'cache.pending',
  daily: 'cache.daily',
  status: 'status',
  device: 'device',
};

export const DEFAULT_SETTINGS = {
  provider: 'github',
  owner: '',
  repo: 'suishenji',
  branch: 'main',
  token: '',
  fontFamily: 'system',
  fontSize: 'normal',
};

export function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

export function createStorage(fallback) {
  try {
    if (globalThis.localStorage) {
      const probe = `${PREFIX}probe`;
      globalThis.localStorage.setItem(probe, '1');
      globalThis.localStorage.removeItem(probe);
      return globalThis.localStorage;
    }
  } catch {
    // 隐私模式等场景下不可用，退回内存存储
  }
  return fallback ?? memoryStorage();
}

export function createStore(storage = createStorage()) {
  const read = (key, fallback) => {
    try {
      const raw = storage.getItem(PREFIX + key);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  };
  const write = (key, value) => {
    try {
      storage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  };
  const remove = (key) => {
    try {
      storage.removeItem(PREFIX + key);
    } catch {
      /* 忽略 */
    }
  };

  const store = {
    raw: { read, write, remove },

    // ---------------------------------------------------------------- 记录
    records: () => read(KEYS.records, {}),
    saveRecords: (all) => write(KEYS.records, all),
    dayRecords: (date) => (read(KEYS.records, {})[date] ?? []).slice(),

    addRecord(text, at = new Date(), corrects = '') {
      const record = createRecord({ text, at, corrects });
      if (!record) return null;
      const all = read(KEYS.records, {});
      (all[record.date] ??= []).push(record);
      all[record.date].sort((left, right) => (left.time < right.time ? -1 : 1));
      write(KEYS.records, all);
      return record;
    },

    updateRecord(date, uuid, text) {
      const all = read(KEYS.records, {});
      const list = all[date] ?? [];
      const target = list.find((item) => item.uuid === uuid);
      if (!target) return false;
      const folded = foldText(text);
      if (!folded) return false;
      target.text = folded;
      write(KEYS.records, all);
      return true;
    },

    deleteRecord(date, uuid) {
      const all = read(KEYS.records, {});
      const list = all[date] ?? [];
      const next = list.filter((item) => item.uuid !== uuid);
      if (next.length === list.length) return false;
      if (next.length) all[date] = next;
      else delete all[date];
      write(KEYS.records, all);
      return true;
    },

    // ---------------------------------------------------------------- 封存
    sealed: () => read(KEYS.sealed, {}),
    isSealed: (date) => Boolean(read(KEYS.sealed, {})[date]),
    markSealed(date, info) {
      const sealed = read(KEYS.sealed, {});
      sealed[date] = { uploadedAt: new Date().toISOString(), ...info };
      write(KEYS.sealed, sealed);
    },
    unmarkSealed(date) {
      const sealed = read(KEYS.sealed, {});
      delete sealed[date];
      write(KEYS.sealed, sealed);
    },
    daysToUpload(today = dateKey()) {
      return daysToUpload({
        recordsByDate: read(KEYS.records, {}),
        sealed: read(KEYS.sealed, {}),
        today,
      });
    },

    // ---------------------------------------------------------------- 草稿
    draft: () => read(KEYS.draft, { text: '', updatedAt: '' }),
    saveDraft(text) {
      return write(KEYS.draft, { text, updatedAt: new Date().toISOString() });
    },
    clearDraft: () => write(KEYS.draft, { text: '', updatedAt: new Date().toISOString() }),

    // ---------------------------------------------------------------- 确认答复
    confirmations: () => read(KEYS.confirmations, []),
    addConfirmations(rows) {
      const merged = mergeConfirmations(rows, read(KEYS.confirmations, []));
      write(KEYS.confirmations, merged);
      return merged;
    },
    replaceConfirmations(rows) {
      write(KEYS.confirmations, rows);
    },

    // ---------------------------------------------------------------- 缓存
    pendingCache: () => read(KEYS.pending, {}),
    savePendingCache(payload) {
      return write(KEYS.pending, payload);
    },
    dailyCache: () => read(KEYS.daily, {}),
    saveDailyCache(date, markdown) {
      const cache = read(KEYS.daily, {});
      cache[date] = markdown;
      write(KEYS.daily, cache);
    },
    replaceDailyCache(cache) {
      return write(KEYS.daily, cache ?? {});
    },

    // ---------------------------------------------------------------- 设置与状态
    settings: () => ({ ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) }),
    saveSettings(patch) {
      const next = { ...store.settings(), ...patch };
      write(KEYS.settings, next);
      return next;
    },
    configured() {
      const settings = store.settings();
      return Boolean(settings.owner && settings.repo && settings.token);
    },
    status: () => read(KEYS.status, { lastSyncAt: '', lastError: '', uploaded: [] }),
    saveStatus(patch) {
      const next = { ...store.status(), ...patch };
      write(KEYS.status, next);
      return next;
    },
    device() {
      let label = read(KEYS.device, '');
      if (!label) {
        const ua = globalThis.navigator?.userAgent ?? '';
        label = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : 'Web';
        write(KEYS.device, label);
      }
      return label;
    },

    clearAll() {
      Object.values(KEYS).forEach((key) => remove(key));
    },

    memoryStorage,
  };

  return store;
}
