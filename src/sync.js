/**
 * 同步编排：把本地记录推到私有仓库，把待确认清单拉下来。
 *
 * 全部依赖注入（store / github / now），因此可以在 Node 里用假仓库跑端到端测试。
 */

import {
  DAILY_CACHE_DAYS,
  confirmJsonlFor,
  dateKey,
  groupByDate,
  isoWithOffset,
  mergeConfirmations,
  mergeRecords,
  parseMarkdown,
  parseMetaJsonl,
  pruneDailyCache,
  recordsToFiles,
} from './core.js';

const INBOX_DIR = 'journal/inbox';
const CONFIRM_DIR = 'journal/confirm';
const PENDING_DIR = 'derived/pending';
const DAILY_DIR = 'derived/daily';

const PENDING_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const MAX_PENDING_DAYS = 10;

function parseJsonl(text) {
  const rows = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') rows.push(row);
    } catch {
      /* 跳过坏行 */
    }
  }
  return rows;
}

export function createSync({ store, github, now = () => new Date() } = {}) {
  /** 上传并封存某一天。返回 {date, count, skipped} */
  async function uploadDay(date) {
    const local = store.dayRecords(date);
    if (!local.length) return { date, count: 0, skipped: true };
    const sealedInfo = store.sealed()[date];
    if (sealedInfo && local.length <= Number(sealedInfo.count ?? 0)) {
      return { date, count: local.length, skipped: true };
    }

    const mdPath = `${INBOX_DIR}/${date}.md`;
    const metaPath = `${INBOX_DIR}/${date}.meta.jsonl`;
    const remoteMd = await github.getFile(mdPath);
    const remoteMeta = await github.getFile(metaPath);

    const remoteRecords = parseMetaJsonl(remoteMeta.text);
    if (!remoteRecords.length && remoteMd.exists && parseMarkdown(remoteMd.text).length) {
      throw new Error(
        `${date}：远端已有 ${mdPath} 但缺少 meta 记录，为避免覆盖已停止上传，请先检查仓库`
      );
    }

    const merged = mergeRecords(local, remoteRecords);
    const files = recordsToFiles(merged, { device: store.device() });

    if (files.md !== remoteMd.text) {
      await github.putFile(mdPath, files.md, `随身记：上传 ${date} 记录`, remoteMd.sha);
    }
    if (files.meta !== remoteMeta.text) {
      await github.putFile(metaPath, files.meta, `随身记：上传 ${date} 元数据`, remoteMeta.sha);
    }

    store.saveRecords({ ...store.records(), [date]: files.records });
    store.markSealed(date, { count: files.records.length });
    return { date, count: files.records.length, skipped: false };
  }

  /** 上传所有"已结束且未封存"的日子。 */
  async function uploadPendingDays(today = dateKey(now())) {
    const results = [];
    for (const date of store.daysToUpload(today)) {
      results.push(await uploadDay(date));
    }
    return results.filter((item) => !item.skipped);
  }

  /** 上传确认答复（按记录所属日期分文件，幂等）。 */
  async function uploadConfirmations() {
    const rows = store.confirmations();
    if (!rows.length) return 0;
    const grouped = groupByDate(rows);
    let uploaded = 0;
    const mergedAll = [];

    for (const [date, dateRows] of Object.entries(grouped)) {
      if (!date) continue;
      const path = `${CONFIRM_DIR}/${date}.jsonl`;
      const remote = await github.getFile(path);
      const merged = mergeConfirmations(dateRows, parseJsonl(remote.text));
      mergedAll.push(...merged);
      const text = confirmJsonlFor(merged);
      if (text === remote.text) continue;
      await github.putFile(path, text, `随身记：确认 ${date}`, remote.sha);
      uploaded += 1;
    }

    if (mergedAll.length) store.replaceConfirmations(mergedAll);
    return uploaded;
  }

  /** 拉取待确认清单，缓存到本地。 */
  async function fetchPending() {
    const entries = await github.listDir(PENDING_DIR);
    const dates = entries
      .map((entry) => PENDING_FILE_RE.exec(entry.name)?.[1])
      .filter(Boolean)
      .sort()
      .slice(-MAX_PENDING_DAYS);

    const cache = {};
    for (const date of dates) {
      const file = await github.getFile(`${PENDING_DIR}/${date}.json`);
      if (!file.exists) continue;
      try {
        const payload = JSON.parse(file.text);
        if (payload && typeof payload === 'object') cache[date] = payload;
      } catch {
        /* 忽略坏文件 */
      }
    }
    store.savePendingCache(cache);
    return cache;
  }

  /** 拉取某天的日记（含账本摘要），缓存到本地。 */
  async function fetchDaily(date) {
    const file = await github.getFile(`${DAILY_DIR}/${date}.md`);
    if (!file.exists) return '';
    store.saveDailyCache(date, file.text);
    return file.text;
  }

  /**
   * 拉取最近 DAILY_CACHE_DAYS 天的日报到本地，供离线回看；
   * 单天失败只跳过，最后把窗口外的旧缓存裁掉。
   */
  async function fetchRecentDaily(today = dateKey(now())) {
    const cursor = new Date(`${today}T12:00:00`);
    for (let index = 0; index < DAILY_CACHE_DAYS; index += 1) {
      const date = dateKey(cursor);
      try {
        const file = await github.getFile(`${DAILY_DIR}/${date}.md`);
        if (file.exists && file.text) store.saveDailyCache(date, file.text);
      } catch {
        /* 单天读取失败不影响整次同步 */
      }
      cursor.setDate(cursor.getDate() - 1);
    }
    const pruned = pruneDailyCache(store.dailyCache(), today);
    store.replaceDailyCache(pruned);
    return Object.keys(pruned).length;
  }

  /** 打开 App 或回到前台时调用：上传已结束的日子与确认答复，再拉取待确认清单。 */
  async function syncNow({ today = dateKey(now()) } = {}) {
    if (!store.configured()) return { ok: false, reason: 'not-configured' };
    try {
      const uploaded = await uploadPendingDays(today);
      const confirmations = await uploadConfirmations();
      await fetchPending();
      await fetchRecentDaily(today);
      store.saveStatus({
        lastSyncAt: isoWithOffset(now()),
        lastError: '',
        uploaded,
      });
      return { ok: true, uploaded, confirmations };
    } catch (error) {
      const message = error?.message ?? String(error);
      store.saveStatus({ lastError: message, lastAttemptAt: isoWithOffset(now()) });
      return { ok: false, error: message };
    }
  }

  return {
    uploadDay,
    uploadPendingDays,
    uploadConfirmations,
    fetchPending,
    fetchDaily,
    fetchRecentDaily,
    syncNow,
  };
}
