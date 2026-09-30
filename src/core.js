/**
 * 随身记 PWA —— 纯逻辑层。
 *
 * 这里不碰 DOM、不发网络请求、不读写存储，因此可以在 Node 里直接跑测试。
 * 数据格式的权威定义见仓库根目录 docs/contract.md。
 */

export const API_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const LINE_RE = /^-\s+(\d{2}:\d{2}:\d{2})\s+(.*)$/;

export function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本地时区的 YYYY-MM-DD。 */
export function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 本地时区的 HH:MM:SS。 */
export function timeKey(date = new Date()) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 带时区偏移的 ISO 时间戳，例如 2026-09-29T21:03:12+08:00。 */
export function isoWithOffset(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return (
    `${dateKey(date)}T${timeKey(date)}` +
    `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
  );
}

/** 把正文里的换行折成空格，保证仓库里永远"一行一条"。 */
export function foldText(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/[ \t\u3000]+/g, ' ')
    .trim();
}

export function newUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 生成一条记录。正文折叠后为空则返回 null（调用方据此跳过）。
 * corrects 可选，指向被更正记录的 uuid。
 */
export function createRecord({ text, at = new Date(), uuid, corrects = '' } = {}) {
  const folded = foldText(text);
  if (!folded) return null;
  return {
    uuid: uuid || newUuid(),
    date: dateKey(at),
    time: timeKey(at),
    createdAt: isoWithOffset(at),
    text: folded,
    corrects,
  };
}

export function sortRecords(records = []) {
  return [...records].sort((left, right) => {
    if (left.time !== right.time) return left.time < right.time ? -1 : 1;
    return left.uuid < right.uuid ? -1 : left.uuid > right.uuid ? 1 : 0;
  });
}

export function markdownFor(records = []) {
  return records.map((record) => `- ${record.time} ${record.text}\n`).join('');
}

export function metaJsonlFor(records = [], { device = '' } = {}) {
  return records
    .map((record) => {
      const row = {
        uuid: record.uuid,
        created_at: record.createdAt || '',
        device,
        chars: record.text.length,
        text: record.text,
      };
      if (record.corrects) row.corrects = record.corrects;
      return `${JSON.stringify(row)}\n`;
    })
    .join('');
}

export function recordsToFiles(records, options = {}) {
  const sorted = sortRecords(records);
  return {
    md: markdownFor(sorted),
    meta: metaJsonlFor(sorted, options),
    records: sorted,
  };
}

export function parseMarkdown(text) {
  const result = [];
  for (const raw of String(text ?? '').split('\n')) {
    const match = LINE_RE.exec(raw.trim());
    if (!match) continue;
    result.push({ time: match[1], text: match[2].trim() });
  }
  return result;
}

export function parseMetaJsonl(text) {
  const result = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object' || !row.uuid) continue;
    const createdAt = String(row.created_at ?? '');
    const time =
      /T(\d{2}:\d{2}:\d{2})/.exec(createdAt)?.[1] || String(row.time ?? '00:00:00');
    const body = typeof row.text === 'string' ? row.text : '';
    if (!body.trim()) continue;
    result.push({
      uuid: String(row.uuid),
      date: API_DATE_RE.test(createdAt.slice(0, 10)) ? createdAt.slice(0, 10) : '',
      time,
      createdAt,
      text: foldText(body),
      corrects: row.corrects ? String(row.corrects) : '',
    });
  }
  return result;
}

/**
 * 合并本地与远端记录：按 uuid 取并集，本地版本优先（本地可能改过正文）。
 * 仅用于同一天的原始记录。
 */
export function mergeRecords(local = [], remote = []) {
  const byId = new Map();
  for (const record of remote) {
    if (record?.uuid) byId.set(record.uuid, record);
  }
  for (const record of local) {
    if (record?.uuid) byId.set(record.uuid, record);
  }
  return sortRecords([...byId.values()]);
}

export function isDayEnded(date, today) {
  return Boolean(date) && Boolean(today) && date < today;
}

/**
 * 需要上传封存的日子：有记录、已经结束，且"还没封存"或"封存之后又新增了记录"。
 * 后者用于兜底"手动封存今天后继续记录"的场景，避免新内容永远留在本地。
 */
export function daysToUpload({ recordsByDate = {}, sealed = {}, today }) {
  return Object.keys(recordsByDate)
    .filter((date) => (recordsByDate[date] ?? []).length > 0)
    .filter((date) => isDayEnded(date, today))
    .filter((date) => {
      const info = sealed[date];
      if (!info) return true;
      return (recordsByDate[date] ?? []).length > Number(info.count ?? 0);
    })
    .sort();
}

export function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function decodeBase64Utf8(base64) {
  const binary = atob(String(base64 ?? '').replace(/\s+/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// --------------------------------------------------------------------- 待确认与答复

export function isResolved(item, confirmations = []) {
  for (const confirmation of confirmations) {
    if (!confirmation) continue;
    if (confirmation.kind === 'dismiss' && confirmation.pending_id === item.id) return true;
    if (
      confirmation.kind === 'amount' &&
      item.kind === 'amount' &&
      confirmation.source_ref &&
      confirmation.source_ref === item.source_ref
    ) {
      return true;
    }
    if (
      confirmation.kind === 'category' &&
      item.kind === 'category' &&
      confirmation.source_ref === item.source_ref
    ) {
      return true;
    }
    if (
      confirmation.kind === 'person' &&
      item.kind === 'person' &&
      confirmation.alias === item.alias
    ) {
      return true;
    }
  }
  return false;
}

/** 汇总多天的待确认项，并过滤掉本地已经答复过的。 */
export function pendingItems(cachePending = {}, confirmations = []) {
  const items = [];
  for (const [date, payload] of Object.entries(cachePending)) {
    for (const item of payload?.items ?? []) {
      if (isResolved(item, confirmations)) continue;
      items.push({ ...item, date: item.date || date });
    }
  }
  return items.sort((left, right) => {
    if (left.date !== right.date) return left.date < right.date ? -1 : 1;
    return String(left.id) < String(right.id) ? -1 : 1;
  });
}

export function makeConfirmation(kind, fields = {}, at = new Date()) {
  return { id: newUuid(), kind, confirmed_at: isoWithOffset(at), ...fields };
}

export function mergeConfirmations(local = [], remote = []) {
  const byId = new Map();
  for (const row of remote) if (row?.id) byId.set(row.id, row);
  for (const row of local) if (row?.id) byId.set(row.id, row);
  return [...byId.values()].sort((left, right) =>
    String(left.id) < String(right.id) ? -1 : 1
  );
}

export function groupByDate(rows = []) {
  const grouped = {};
  for (const row of rows) {
    const date = row.date || '';
    (grouped[date] ??= []).push(row);
  }
  return grouped;
}

export function confirmJsonlFor(rows = []) {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join('');
}

// -------------------------------------------------------------------------- 展示

export function formatStatus({ recordCount = 0, pendingCount = 0 } = {}) {
  return pendingCount > 0
    ? `今天 ${recordCount} 条 · 待确认 ${pendingCount}`
    : `今天 ${recordCount} 条`;
}

export function formatClock(isoString) {
  const match = /T(\d{2}):(\d{2})/.exec(String(isoString ?? ''));
  return match ? `${match[1]}:${match[2]}` : '';
}

export function relativeDayLabel(date, today) {
  if (date === today) return '今天';
  const yesterday = new Date(`${today}T12:00:00`);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = dateKey(yesterday);
  if (date === yesterdayKey) return '昨天';
  return date.slice(5);
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/#([^\s#]+)/g, '<span class="tag">#$1</span>')
    .replace(/^_(.+)_$/, '<em>$1</em>');
}

/** 只够渲染日报的最小 Markdown：标题、列表、引用行、行内代码。 */
export function renderMarkdown(markdown) {
  const withoutFrontMatter = String(markdown ?? '').replace(/^---\n[\s\S]*?\n---\n?/, '');
  const html = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  for (const raw of withoutFrontMatter.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 1, 5);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (/^[|>]/.test(line)) {
      closeList();
      html.push(`<p class="muted">${inline(line.replace(/^[|>]\s?/, ''))}</p>`);
      continue;
    }
    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return html.join('\n');
}

// ------------------------------------------------------------------ 显示设置

/** 字体候选：全部是设备本地字体，不下载、不联网。 */
export const FONT_FAMILIES = {
  system:
    'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  serif: '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK SC", monospace',
};

/** 字号档位：乘在基准字号（16px）与输入框字号（20px）上。 */
export const FONT_SIZES = {
  small: 0.92,
  normal: 1,
  large: 1.12,
  xlarge: 1.24,
};

export function fontStack(family) {
  return FONT_FAMILIES[family] ?? FONT_FAMILIES.system;
}

export function fontScale(size) {
  return FONT_SIZES[size] ?? 1;
}

/**
 * 是否该显示"点一下开始说话"的提示层。
 *
 * 注意：只看键盘有没有真的弹出来。Android Chrome 会出现"输入框已聚焦但键盘不弹"
 * 的情况，所以 focused 不能当作成功；只在触屏设备上提示，桌面浏览器不打扰。
 */
export function shouldShowFocusFallback({
  screen = '',
  keyboardOpen = false,
  sheetOpen = false,
  touch = false,
} = {}) {
  if (!touch) return false;
  if (screen !== 'input') return false;
  if (sheetOpen) return false;
  if (keyboardOpen) return false;
  return true;
}
