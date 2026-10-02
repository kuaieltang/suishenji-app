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

/** 界面上的时间一律只到分钟：`09:12:45` → `09:12`。 */
export function shortTime(time) {
  const match = /^(\d{2}:\d{2})(?::\d{2})?$/.exec(String(time ?? '').trim());
  return match ? match[1] : String(time ?? '');
}

/** `2026-09-30T09:41:21+08:00` → `2026-09-30 09:41` */
export function shortDateTime(isoString) {
  const text = String(isoString ?? '');
  const date = /(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? '';
  const time = formatClock(text);
  return [date, time].filter(Boolean).join(' ');
}

/**
 * 日报里的「原始记录」一行形如 `- 00:10:48 正文`，显示时把秒去掉；
 * 只动行首的这个时间，正文里其他时间样文本保持原样。
 */
export function stripDailySeconds(markdown) {
  return String(markdown ?? '').replace(/^(- )(\d{2}:\d{2}):\d{2} /gm, '$1$2 ');
}

/** 把日报拆成「整理主体」与「原始记录」两段，后者单独成节显示。 */
export function splitDailySections(markdown) {
  const text = String(markdown ?? '');
  const match = /^#{1,6}\s*原始记录\s*$/m.exec(text);
  if (!match) return { main: text.trim(), raw: '' };
  return {
    main: text.slice(0, match.index).trim(),
    raw: text.slice(match.index + match[0].length).trim(),
  };
}

/**
 * 把日报按 `## ` 小节切开，返回 [{ title, body }] 与单独的原始记录段。
 * 顺序保持文件里的原样（关系 / 健康 / 成长 / 杂记 / 财务摘要 / 备注）。
 */
export function parseDailySections(markdown) {
  const sections = [];
  let current = null;
  let rawLines = [];
  let inRaw = false;

  for (const line of String(markdown ?? '').split('\n')) {
    const heading = /^##\s+(.*)$/.exec(line.trim());
    if (heading) {
      const title = heading[1].trim();
      if (title === '原始记录') {
        inRaw = true;
        current = null;
        continue;
      }
      inRaw = false;
      current = { title, lines: [] };
      sections.push(current);
      continue;
    }
    if (inRaw) rawLines.push(line);
    else if (current) current.lines.push(line);
  }

  return {
    sections: sections.map((section) => ({
      title: section.title,
      body: section.lines.join('\n').trim(),
    })),
    raw: rawLines.join('\n').trim(),
  };
}

/** 从字体 CSS 里取出去重后的分片地址（保持出现顺序，忽略空值）。 */
export function parseFontSliceUrls(cssText) {
  const urls = [];
  const seen = new Set();
  const pattern = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  let match = pattern.exec(String(cssText ?? ''));
  while (match) {
    const value = match[1].trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      urls.push(value);
    }
    match = pattern.exec(String(cssText ?? ''));
  }
  return urls;
}

// ------------------------------------------------------------------ 用量展示

/** 大数字用「万 / 亿」更好读。 */
export function formatTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '0';
  if (number >= 100_000_000) return `${(number / 100_000_000).toFixed(2)} 亿`;
  if (number >= 10_000) return `${(number / 10_000).toFixed(1)} 万`;
  return Math.round(number).toLocaleString('zh-CN');
}

/**
 * 把电脑端生成的用量快照（derived/usage/latest.json）整理成界面要用的字段。
 * 数据缺失时返回 null，由界面显示空态。
 */
export function formatUsageSummary(payload) {
  if (!payload || typeof payload !== 'object' || !payload.totals) return null;
  const cost = payload.cost || {};
  const cny = Number(cost.cny) || 0;
  const tokens = Number(payload.totals.total_tokens) || 0;
  const toRow = (row, label) => ({
    label,
    tokens: Number(row?.total_tokens ?? row?.usage?.total_tokens ?? 0) || 0,
    tokensLabel: formatTokens(row?.total_tokens ?? row?.usage?.total_tokens ?? 0),
    cny: Number(row?.cny) || 0,
    cnyLabel: `¥${(Number(row?.cny) || 0).toFixed(2)}`,
  });

  const usd = Number(cost.usd) || 0;
  return {
    month: String(payload.month || ''),
    generatedAt: String(payload.generated_at || ''),
    updatedLabel: String(payload.generated_at || '').replace('T', ' ').slice(0, 16),
    tokens,
    tokensLabel: formatTokens(tokens),
    usd,
    cny,
    cnyLabel: `≈ ¥${cny.toFixed(2)}`,
    inputLabel: formatTokens(payload.totals.input_tokens),
    cachedLabel: formatTokens(payload.totals.cached_input_tokens),
    outputLabel: formatTokens(payload.totals.output_tokens),
    reasoningLabel: formatTokens(payload.totals.reasoning_output_tokens),
    rateNote: String(cost.note || '按 DeepSeek 官方费率估算，以平台账单为准'),
    sources: (payload.by_source || []).map((row) => toRow(row, String(row.source || '其他'))),
    models: (payload.by_model || []).map((row) => toRow(row, String(row.model || '其他'))),
  };
}

export function relativeDayLabel(date, today) {
  if (date === today) return '今天';
  const yesterday = new Date(`${today}T12:00:00`);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = dateKey(yesterday);
  if (date === yesterdayKey) return '昨天';
  return date.slice(5);
}

// ------------------------------------------------------------------ 日期展示与本地缓存窗口

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 2026-09-30 → 周三 */
export function weekdayLabel(date) {
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return '';
  return WEEKDAYS[parsed.getDay()] ?? '';
}

/** 完整日期：2026-09-30 周三 */
export function fullDateLabel(date) {
  const weekday = weekdayLabel(date);
  return weekday ? `${date} ${weekday}` : String(date ?? '');
}

/** 日期条上的短标签：今天 / 昨天 / 9-28 周一 */
export function shortDateLabel(date, today) {
  const relative = relativeDayLabel(date, today);
  if (relative === '今天' || relative === '昨天') return relative;
  const weekday = weekdayLabel(date);
  return weekday ? `${relative} ${weekday}` : relative;
}

/** 本地日报缓存保留的天数 */
export const DAILY_CACHE_DAYS = 7;

/**
 * 日期条要显示的日期：本机有原始记录的日子 ∪ 缓存里有日报的日子 ∪ 今天。
 * 倒序、去重、最多 max 个。
 */
export function recentDates({ records = {}, daily = {}, today = '', max = 8 } = {}) {
  const dates = new Set();
  if (today) dates.add(today);
  for (const [date, list] of Object.entries(records ?? {})) {
    if ((list ?? []).length) dates.add(date);
  }
  for (const date of Object.keys(daily ?? {})) dates.add(date);
  return [...dates].filter(Boolean).sort().reverse().slice(0, max);
}

/** 只保留最近 days 天的日报缓存，返回新对象（不改原对象）。 */
export function pruneDailyCache(cache = {}, today = '', days = DAILY_CACHE_DAYS) {
  if (!today) return { ...(cache ?? {}) };
  const limit = new Date(`${today}T12:00:00`);
  limit.setDate(limit.getDate() - (days - 1));
  const oldest = dateKey(limit);
  const next = {};
  for (const [date, text] of Object.entries(cache ?? {})) {
    if (date >= oldest && date <= today) next[date] = text;
  }
  return next;
}

// ------------------------------------------------------------------ 月历

/** 6×7 的月历网格（周一起始），空白格为 null。 */
export function monthGrid(year, month) {
  const first = new Date(year, month - 1, 1, 12);
  const offset = (first.getDay() + 6) % 7; // 周一 = 0
  const days = new Date(year, month, 0, 12).getDate();
  const cells = [];
  for (let index = 0; index < offset; index += 1) cells.push(null);
  for (let day = 1; day <= days; day += 1) {
    cells.push(dateKey(new Date(year, month - 1, day, 12)));
  }
  while (cells.length < 42) cells.push(null);
  return cells;
}

/** 月份加减，跨年安全。 */
export function shiftMonth({ year, month }, delta) {
  const base = new Date(year, month - 1 + delta, 1, 12);
  return { year: base.getFullYear(), month: base.getMonth() + 1 };
}

/** 哪些日子有内容：本机记录（含已封存）与本地缓存的日报。 */
export function dateMarks({ records = {}, sealed = {}, daily = {} } = {}) {
  const hasRecord = new Set();
  for (const [date, list] of Object.entries(records ?? {})) {
    if ((list ?? []).length) hasRecord.add(date);
  }
  for (const date of Object.keys(sealed ?? {})) hasRecord.add(date);
  return { hasRecord, hasDaily: new Set(Object.keys(daily ?? {})) };
}

/** 去掉日报正文里与页面重复的那行日期标题（`# 2026-09-30 日记`）。 */
export function stripDailyHeading(markdown, date) {
  const text = String(markdown ?? '');
  const lines = text.split('\n');
  const index = lines.findIndex((line) => {
    const trimmed = line.trim();
    if (!/^#\s/.test(trimmed)) return false;
    return trimmed.includes(date) || /日记$/.test(trimmed);
  });
  if (index < 0) return text;
  lines.splice(index, 1);
  if ((lines[index] ?? '').trim() === '') lines.splice(index, 1);
  return lines.join('\n');
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
  misans:
    '"MiSans", "MiSans VF", "MiSans GB", "Mi Sans", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
  lxgw:
    '"LXGW Bright GB Light", "LXGW Bright GB", "LXGWBrightGB", "霞鹜文楷 GB Light", "LXGW WenKai", "霞鹜文楷", "Kaiti SC", KaiTi, serif',
  kaiti: '"Kaiti SC", KaiTi, "楷体", STKaiti, "华文楷体", serif',
  songti: '"Songti SC", SimSun, "宋体", STSong, "华文宋体", serif',
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
