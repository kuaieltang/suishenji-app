/**
 * 随身记 PWA —— 界面与流程编排。
 *
 * 设计原则：打开就是输入态；不做任何智能处理；只有"某天结束后的下次打开"
 * 才把内容推到私有仓库。所有智能整理发生在电脑端的 Codex 任务里。
 */

import {
  dateKey,
  dateMarks,
  foldText,
  fontScale,
  fontStack,
  formatClock,
  formatStatus,
  fullDateLabel,
  makeConfirmation,
  monthGrid,
  pendingItems,
  recentDates,
  relativeDayLabel,
  renderMarkdown,
  shiftMonth,
  shortDateTime,
  shortDateLabel,
  shortTime,
  stripDailySeconds,
  stripDailyHeading,
  timeKey,
  weekdayLabel,
} from './core.js';
import { createRemote, providerInfo } from './remote.js';
import { createStore } from './store.js';
import { createSync } from './sync.js';

const CATEGORY_OPTIONS = [
  '餐饮',
  '交通',
  '居家',
  '购物',
  '医疗健康',
  '教育成长',
  '人情往来',
  '亲子',
  '娱乐',
  '订阅服务',
  '旅行',
  '其他',
];

const RELATION_OPTIONS = ['不确定', '家人', '亲戚', '朋友', '同事', '邻里', '其他'];
const MAX_DAY_CHIPS = 8;

const store = createStore();
const byId = (id) => document.getElementById(id);

const dom = {
  screens: {
    input: byId('screen-input'),
    read: byId('screen-read'),
    confirm: byId('screen-confirm'),
  },
  editor: byId('editor'),
  send: byId('btn-send'),
  today: byId('btn-today'),
  todayLabel: byId('today-label'),
  pending: byId('btn-pending'),
  pendingLabel: byId('pending-label'),
  openSettings: byId('btn-settings'),
  readTitle: byId('read-title'),
  readCount: byId('read-count'),
  readDate: byId('read-date'),
  readChip: byId('read-chip'),
  readPick: byId('btn-pick-date'),
  derivedLabel: byId('read-derived-label'),
  readDays: byId('read-days'),
  readSeal: byId('read-seal'),
  readList: byId('read-list'),
  append: byId('btn-append'),
  refresh: byId('btn-refresh'),
  derived: byId('read-derived'),
  derivedBody: byId('read-derived-body'),
  confirmEmpty: byId('confirm-empty'),
  confirmList: byId('confirm-list'),
  syncButton: byId('btn-sync'),
  form: byId('settings-form'),
  setProvider: byId('set-provider'),
  setOwner: byId('set-owner'),
  setRepo: byId('set-repo'),
  setBranch: byId('set-branch'),
  setToken: byId('set-token'),
  toggleToken: byId('btn-toggle-token'),
  setFontFamily: byId('set-font-family'),
  setFontSize: byId('set-font-size'),
  tokenHelp: byId('set-token-help'),
  status: byId('set-status'),
  settingsSheet: byId('settings-sheet'),
  settingsMenu: byId('settings-menu'),
  settingsTitle: byId('settings-title'),
  settingsBack: byId('btn-settings-back'),
  settingsClose: byId('btn-settings-close'),
  settingsViews: document.querySelectorAll('.settings-view'),
  menuRepoValue: byId('menu-repo-value'),
  menuDisplayValue: byId('menu-display-value'),
  menuSyncValue: byId('menu-sync-value'),
  calSheet: byId('calendar-sheet'),
  calTitle: byId('cal-title'),
  calGrid: byId('cal-grid'),
  calPrev: byId('btn-cal-prev'),
  calNext: byId('btn-cal-next'),
  calToday: byId('btn-cal-today'),
  uploadNow: byId('btn-upload-now'),
  sealToday: byId('btn-seal-today'),
  clear: byId('btn-clear'),
  toast: byId('toast'),
};

const ui = {
  screen: 'input',
  readDate: dateKey(),
  pending: [],
  derivedDate: '',
  syncing: false,
  syncQueued: false,
  syncTimer: null,
  toastTimer: null,
  focusTimer: null,
  settingsView: 'menu',
  calYear: 0,
  calMonth: 1,
};

let ghClient = null;
let sync = null;

// ------------------------------------------------------------------ 基础设施

function show(name) {
  ui.screen = name;
  for (const [key, element] of Object.entries(dom.screens)) {
    element.hidden = key !== name;
  }
  if (name === 'input') ensureEditorFocus();
}

function focusEditor() {
  try {
    dom.editor.focus({ preventScroll: true });
  } catch {
    dom.editor.focus();
  }
}

/** 输入法弹出时 Android Chrome 会压缩可视视口，这是判断键盘是否真的弹出来的依据。 */
function keyboardLikelyOpen() {
  const viewport = globalThis.visualViewport;
  if (!viewport) return false;
  return window.innerHeight - viewport.height > 80;
}

/**
 * 让键盘尽量随打开一起弹出：多次重试，键盘一弹出就停手。
 * 浏览器若因为"没有用户手势"而拒绝，不做任何提示——用户点一下输入框即可。
 */
function ensureEditorFocus() {
  if (ui.screen !== 'input' || document.querySelector('.sheet:not([hidden])')) return;
  clearTimeout(ui.focusTimer);
  const delays = [0, 120, 400, 900];
  let index = 0;
  const attempt = () => {
    if (ui.screen !== 'input' || document.querySelector('.sheet:not([hidden])')) return;
    focusEditor();
    // 只有键盘真的弹出来才算成功：Chrome 会"聚焦成功但不弹键盘"
    if (keyboardLikelyOpen()) return;
    index += 1;
    if (index < delays.length) {
      ui.focusTimer = setTimeout(attempt, delays[index] - delays[index - 1]);
    }
  };
  attempt();
}

function toast(message, duration = 2600) {
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => {
    dom.toast.hidden = true;
  }, duration);
}

function buildClient() {
  const settings = store.settings();
  if (!settings.owner || !settings.repo || !settings.token) {
    ghClient = null;
    sync = null;
    return null;
  }
  ghClient = createRemote({
    provider: settings.provider,
    owner: settings.owner,
    repo: settings.repo,
    branch: settings.branch || 'main',
    token: settings.token,
  });
  sync = createSync({ store, github: ghClient });
  return sync;
}

function shortError(message) {
  const text = String(message ?? '');
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

// ------------------------------------------------------------------ 计数与同步

function refreshCounts() {
  const today = dateKey();
  const count = store.dayRecords(today).length;
  ui.pending = pendingItems(store.pendingCache(), store.confirmations());
  dom.today.title = formatStatus({ recordCount: count, pendingCount: ui.pending.length });
  if (dom.todayLabel) dom.todayLabel.textContent = `今天 ${count} 条`;
  if (dom.pendingLabel) dom.pendingLabel.textContent = `待确认 ${ui.pending.length}`;
  if (ui.pending.length) {
    dom.pending.hidden = false;
  } else {
    dom.pending.hidden = true;
  }
  renderSettingsStatus();
}

function scheduleSync(delay = 0) {
  if (!sync) return;
  clearTimeout(ui.syncTimer);
  ui.syncTimer = setTimeout(runSync, delay);
}

async function runSync() {
  if (!sync) return;
  if (ui.syncing) {
    ui.syncQueued = true;
    return;
  }
  ui.syncing = true;
  try {
    const result = await sync.syncNow();
    if (result.ok) {
      refreshCounts();
      if (result.uploaded?.length) {
        const dates = result.uploaded.map((item) => item.date).join('、');
        toast(`已上传封存：${dates}`);
      }
    } else if (result.reason !== 'not-configured') {
      refreshCounts();
      toast(`同步失败：${shortError(result.error)}`, 4000);
    }
  } finally {
    ui.syncing = false;
    if (ui.syncQueued) {
      ui.syncQueued = false;
      scheduleSync(0);
    }
  }
}

// ------------------------------------------------------------------ 输入页

let draftTimer = null;

function commitEntry() {
  const text = dom.editor.value;
  if (!foldText(text)) {
    if (text) dom.editor.value = '';
    store.clearDraft();
    return false;
  }
  store.addRecord(text, new Date());
  dom.editor.value = '';
  store.clearDraft();
  refreshCounts();
  scheduleSync(1200);
  return true;
}

function bindEditor() {
  dom.editor.addEventListener('input', () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => store.saveDraft(dom.editor.value), 500);
  });

  dom.editor.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.isComposing || event.keyCode === 229) return; // 中文输入法候选框
    event.preventDefault();
    commitEntry();
  });

  dom.send.addEventListener('click', () => {
    commitEntry();
    focusEditor();
  });
}

// ------------------------------------------------------------------ 回看页

function dateChips() {
  const today = dateKey();
  const dates = recentDates({
    records: store.records(),
    daily: store.dailyCache(),
    today,
    max: MAX_DAY_CHIPS,
  });
  // 正在查看的那一天也放进日期条，避免"我到底在哪天"的困惑
  if (ui.readDate && !dates.includes(ui.readDate)) {
    dates.pop();
    dates.push(ui.readDate);
    dates.sort().reverse();
  }
  return dates;
}

function renderRead() {
  const today = dateKey();
  const date = ui.readDate;
  const sealed = store.isSealed(date);
  const records = store.dayRecords(date);
  const daily = store.dailyCache()[date] ?? '';

  dom.readTitle.textContent = date === today ? '今天的记录' : `${shortDateLabel(date, today)}的记录`;
  if (dom.readDate) dom.readDate.textContent = fullDateLabel(date);
  if (dom.readChip) dom.readChip.textContent = relativeDayLabel(date, today);
  if (dom.derivedLabel) {
    dom.derivedLabel.textContent = `当天的整理 · ${date.slice(5)} ${weekdayLabel(date)}`.trim();
  }
  if (dom.readCount) {
    dom.readCount.textContent = records.length ? String(records.length) : daily ? '—' : '0';
  }

  dom.readDays.innerHTML = dateChips()
    .map(
      (item) =>
        `<button class="day" type="button" data-date="${item}" aria-current="${
          item === date ? 'true' : 'false'
        }">${shortDateLabel(item, today)}</button>`
    )
    .join('');

  if (sealed) {
    const info = store.sealed()[date] ?? {};
    const when = formatClock(info.uploadedAt ?? '');
    const grown = records.length > Number(info.count ?? 0);
    dom.readSeal.textContent = grown
      ? `已封存${when ? ` · ${when} 上传` : ''}，之后新增 ${
          records.length - Number(info.count ?? 0)
        } 条`
      : `已封存${when ? ` · ${when} 上传` : ''}${
          info.count ? ` · ${info.count} 条` : ''
        }`;
  } else if (date < today) {
    dom.readSeal.textContent = '还没上传 · 下次打开自动补传';
  } else {
    dom.readSeal.textContent = '未封存 · 随时可以改';
  }
  dom.readSeal.hidden = false;

  if (!records.length) {
    dom.readList.innerHTML = `<li class="empty">${
      daily ? '原始记录不在本机，下面是当天整理好的日报。' : '这一天还没有记录。'
    }</li>`;
  } else {
    dom.readList.innerHTML = records
      .map(
        (record) => `<li class="line" data-uuid="${record.uuid}">
          <span class="line__time">${shortTime(record.time)}</span>
          <p class="line__text">${escapeText(record.text)}</p>
          <button class="line__more" type="button" data-action="record-menu" aria-label="更多">
            <svg class="icon" aria-hidden="true"><use href="#i-more"></use></svg>
          </button>
        </li>`
      )
      .join('');
  }

  dom.append.hidden = sealed;

  if (ui.derivedDate !== date) {
    ui.derivedDate = date;
    dom.derivedBody.innerHTML = '<p class="empty">正在读取当天的整理…</p>';
    dom.derived.hidden = false;
    loadDerived(date);
  }
}

function escapeText(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function loadDerived(date) {
  const cached = store.dailyCache()[date];
  if (cached) {
    dom.derivedBody.innerHTML = renderMarkdown(
      stripDailySeconds(stripDailyHeading(cached, date))
    );
  } else {
    dom.derivedBody.innerHTML = '<p class="empty">这天还没有整理好的日报。</p>';
  }
  if (!sync) return;
  try {
    const markdown = await sync.fetchDaily(date);
    if (markdown && ui.derivedDate === date) {
      dom.derivedBody.innerHTML = renderMarkdown(
        stripDailySeconds(stripDailyHeading(markdown, date))
      );
    }
  } catch (error) {
    if (!cached) {
      dom.derivedBody.innerHTML = `<p class="empty">读取失败：${escapeText(
        shortError(error?.message ?? error)
      )}</p>`;
    }
  }
}

function openRead(date = dateKey()) {
  ui.readDate = date;
  ui.derivedDate = '';
  renderRead();
  show('read');
}

// ------------------------------------------------------------------ 月历

function openCalendar() {
  const [year, month] = ui.readDate.split('-').map((part) => Number(part));
  ui.calYear = year;
  ui.calMonth = month;
  renderCalendar();
  dom.calSheet.hidden = false;
}

function closeCalendar() {
  if (dom.calSheet) dom.calSheet.hidden = true;
}

function pickDate(date) {
  if (!date) return;
  ui.readDate = date;
  ui.derivedDate = '';
  closeCalendar();
  renderRead();
}

function renderCalendar() {
  if (!dom.calGrid) return;
  const year = ui.calYear;
  const month = ui.calMonth;
  const today = dateKey();
  dom.calTitle.textContent = `${year}年${month}月`;
  const marks = dateMarks({
    records: store.records(),
    sealed: store.sealed(),
    daily: store.dailyCache(),
  });
  dom.calGrid.innerHTML = monthGrid(year, month)
    .map((date) => {
      if (!date) return '<span class="cal-cell cal-cell--empty"></span>';
      const mark = marks.hasRecord.has(date) ? 'record' : marks.hasDaily.has(date) ? 'daily' : 'none';
      const classes = ['cal-cell'];
      if (date === today) classes.push('is-today');
      if (date === ui.readDate) classes.push('is-selected');
      const dot = `<span class="cal-dot${mark === 'daily' ? ' cal-dot--soft' : ''}"></span>`;
      return `<button class="${classes.join(' ')}" type="button" data-date="${date}" data-mark="${mark}"${
        date > today ? ' disabled' : ''
      }>
        <span class="cal-day">${Number(date.slice(8))}</span>${dot}
      </button>`;
    })
    .join('');
}

// ------------------------------------------------------------------ 浮层

function closeSheet() {
  for (const sheet of document.querySelectorAll('.sheet--dynamic')) sheet.remove();
}

function openSheet(builder) {
  closeSheet();
  const sheet = document.createElement('div');
  sheet.className = 'sheet sheet--dynamic';
  const panel = document.createElement('div');
  panel.className = 'sheet__panel';
  sheet.appendChild(panel);
  sheet.addEventListener('click', (event) => {
    if (event.target === sheet) closeSheet();
  });
  builder(panel);
  document.body.appendChild(sheet);
  return panel;
}

function openTextSheet({ title, value, placeholder, confirmLabel = '保存', onSave }) {
  const panel = openSheet((host) => {
    host.innerHTML = `
      <p class="sheet__title">${escapeText(title)}</p>
      <textarea class="sheet__textarea" placeholder="${escapeText(placeholder ?? '')}"></textarea>
      <div class="row">
        <button class="primary" type="button" data-role="confirm">${escapeText(confirmLabel)}</button>
        <button class="ghost" type="button" data-role="cancel">取消</button>
      </div>`;
  });
  const textarea = panel.querySelector('textarea');
  textarea.value = value ?? '';
  textarea.focus();
  panel.addEventListener('click', (event) => {
    const role = event.target.closest('[data-role]')?.dataset.role;
    if (!role) return;
    if (role === 'cancel') {
      closeSheet();
      show(ui.screen);
      return;
    }
    const text = textarea.value;
    closeSheet();
    onSave(text);
  });
}

function openRecordMenu(date, record) {
  const sealed = store.isSealed(date);
  openSheet((host) => {
    host.innerHTML = `
      <p class="sheet__title">${shortTime(record.time)}</p>
      ${sealed ? '' : '<button class="sheet__action" type="button" data-role="edit">编辑</button>'}
      <button class="sheet__action" type="button" data-role="correct">追加更正</button>
      ${
        sealed
          ? ''
          : '<button class="sheet__action sheet__action--danger" type="button" data-role="delete">删除</button>'
      }
      <button class="sheet__action" type="button" data-role="cancel">取消</button>`;
  });

  const sheet = document.querySelector('.sheet--dynamic');
  sheet.addEventListener('click', (event) => {
    const role = event.target.closest('[data-role]')?.dataset.role;
    if (!role) return;
    closeSheet();
    if (role === 'cancel') return;

    if (role === 'edit') {
      openTextSheet({
        title: '修改这条记录',
        value: record.text,
        onSave: (text) => {
          if (store.updateRecord(date, record.uuid, text)) {
            renderRead();
            toast('已修改');
          }
        },
      });
      return;
    }

    if (role === 'delete') {
      if (window.confirm('删除这条记录？')) {
        store.deleteRecord(date, record.uuid);
        renderRead();
        refreshCounts();
        toast('已删除');
      }
      return;
    }

    if (role === 'correct') {
      openTextSheet({
        title: `更正 ${date} ${shortTime(record.time)}`,
        placeholder: '正确的说法，例如：买菜实际花了 320 元',
        onSave: (text) => {
          const body = foldText(text);
          if (!body) return;
          store.addRecord(`更正 ${date} ${shortTime(record.time)}：${body}`, new Date(), record.uuid);
          refreshCounts();
          scheduleSync(1200);
          toast('已作为今天的更正记录保存');
        },
      });
    }
  });
}

// ------------------------------------------------------------------ 待确认页

function optionButtons(item) {
  const options = Array.isArray(item.options) ? item.options : [];
  if (!options.length) return '';
  return `<div class="options">${options
    .map(
      (value) =>
        `<button class="option" type="button" data-action="pick" data-value="${value}">${value}</button>`
    )
    .join('')}</div>`;
}

function cardHtml(item) {
  const head = `<p class="card__q">${escapeText(item.question || '需要确认')}</p>
    <p class="card__hint">${escapeText(item.hint || '')}</p>`;
  const dismiss = '<button class="ghost" type="button" data-action="dismiss">不用问</button>';

  if (item.kind === 'amount') {
    const suggested = item.suggested_amount ?? '';
    return `<article class="card" data-id="${item.id}" data-date="${item.date}" data-ref="${
      item.source_ref ?? ''
    }" data-kind="amount">
      ${head}
      ${optionButtons(item)}
      <div class="row">
        <input class="input" type="number" inputmode="decimal" min="0" step="0.01" value="${suggested}" aria-label="金额" />
        <button class="primary" type="button" data-action="amount">确认</button>
        ${dismiss}
      </div>
    </article>`;
  }

  if (item.kind === 'person') {
    return `<article class="card" data-id="${item.id}" data-date="${item.date}" data-alias="${escapeText(
      item.alias ?? ''
    )}" data-kind="person">
      ${head}
      <div class="row">
        <input class="input" data-field="person" placeholder="真实姓名" aria-label="真实姓名" />
        <select class="input" data-field="relation" aria-label="关系">${RELATION_OPTIONS.map(
          (name) => `<option value="${name}">${name}</option>`
        ).join('')}</select>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="primary" type="button" data-action="person">确认</button>
        ${dismiss}
      </div>
    </article>`;
  }

  if (item.kind === 'category') {
    return `<article class="card" data-id="${item.id}" data-date="${item.date}" data-ref="${
      item.source_ref ?? ''
    }" data-kind="category">
      ${head}
      <div class="row">
        <select class="input" data-field="category" aria-label="分类">${CATEGORY_OPTIONS.map(
          (name) => `<option value="${name}">${name}</option>`
        ).join('')}</select>
        <input class="input" data-field="subcategory" placeholder="细类（可空）" aria-label="细类" />
      </div>
      <div class="row" style="margin-top:8px">
        <button class="primary" type="button" data-action="category">确认</button>
        ${dismiss}
      </div>
    </article>`;
  }

  return `<article class="card" data-id="${item.id}" data-date="${item.date}" data-kind="other">
    ${head}
    <div class="row"><button class="ghost" type="button" data-action="dismiss">知道了</button></div>
  </article>`;
}

function renderConfirm() {
  ui.pending = pendingItems(store.pendingCache(), store.confirmations());
  if (!ui.pending.length) {
    dom.confirmEmpty.hidden = false;
    dom.confirmList.innerHTML = '';
    return;
  }
  dom.confirmEmpty.hidden = true;
  dom.confirmList.innerHTML = ui.pending.map(cardHtml).join('');
}

async function submitConfirmation(row) {
  store.addConfirmations([row]);
  refreshCounts();
  renderConfirm();
  if (!sync) {
    toast('已记下，配置仓库后会自动上传');
    return;
  }
  try {
    await sync.uploadConfirmations();
    toast('已确认');
  } catch (error) {
    toast(`已记下，上传失败：${shortError(error?.message ?? error)}`, 4000);
  }
}

function handleConfirmClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const card = button.closest('.card');
  if (!card) return;
  const date = card.dataset.date;
  const id = card.dataset.id;

  if (action === 'pick') {
    const input = card.querySelector('input[type="number"]');
    if (input) input.value = button.dataset.value;
    return;
  }

  if (action === 'dismiss') {
    submitConfirmation(makeConfirmation('dismiss', { date, pending_id: id }));
    return;
  }

  if (action === 'amount') {
    const raw = card.querySelector('input[type="number"]').value;
    const amount = Number.parseFloat(raw);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast('请填一个大于 0 的金额');
      return;
    }
    submitConfirmation(
      makeConfirmation('amount', { date, source_ref: card.dataset.ref, amount })
    );
    return;
  }

  if (action === 'person') {
    const person = foldText(card.querySelector('[data-field="person"]').value);
    if (!person) {
      toast('请填真实姓名');
      return;
    }
    const relation = card.querySelector('[data-field="relation"]').value;
    submitConfirmation(
      makeConfirmation('person', {
        date,
        alias: card.dataset.alias,
        person,
        relation: relation === '不确定' ? '' : relation,
      })
    );
    return;
  }

  if (action === 'category') {
    const category = card.querySelector('[data-field="category"]').value;
    const subcategory = foldText(card.querySelector('[data-field="subcategory"]').value);
    submitConfirmation(
      makeConfirmation('category', {
        date,
        source_ref: card.dataset.ref,
        category,
        subcategory,
      })
    );
  }
}

// ------------------------------------------------------------------ 设置页

/** 令牌输入框的提示随平台变化：GitHub 是 fine-grained token，Gitee 是私人令牌 */
function applyProviderHints(provider) {
  const info = providerInfo(provider);
  if (dom.setToken) dom.setToken.placeholder = info.tokenPlaceholder;
  if (dom.tokenHelp) {
    dom.tokenHelp.textContent = `${info.tokenHelp}令牌只存在本机浏览器，只有 ${info.host} 的 API 会收到它。`;
  }
}

const FONT_SIZE_LABELS = { small: '小', normal: '标准', large: '大', xlarge: '特大' };
const FONT_FAMILY_LABELS = { system: '系统默认', serif: '衬线', mono: '等宽' };
const SETTINGS_TITLES = { menu: '设置', repo: '仓库连接', display: '显示', sync: '同步', about: '关于' };

function renderSettingsStatus() {
  const settings = store.settings();
  const info = providerInfo(settings.provider);
  const status = store.status();
  const unsealed = store.daysToUpload();
  const parts = [];
  parts.push(
    store.configured()
      ? `仓库：${info.label} · ${settings.owner}/${settings.repo}@${settings.branch || 'main'}`
      : '还没配置仓库'
  );
  parts.push(status.lastSyncAt ? `上次同步：${shortDateTime(status.lastSyncAt)}` : '还没同步过');
  parts.push(unsealed.length ? `待上传：${unsealed.join('、')}` : '没有待上传的日子');
  if (status.lastError) parts.push(`上次错误：${status.lastError}`);
  if (dom.status) dom.status.textContent = parts.join('\n');
  if (dom.sealToday) dom.sealToday.hidden = !store.dayRecords(dateKey()).length;

  if (dom.menuRepoValue) {
    dom.menuRepoValue.textContent = store.configured()
      ? `${info.label} · ${settings.repo}`
      : '未配置';
  }
  if (dom.menuSyncValue) {
    dom.menuSyncValue.textContent = status.lastSyncAt
      ? formatClock(status.lastSyncAt)
      : status.lastError
        ? '有错误'
        : '未同步';
  }
  if (dom.menuDisplayValue) {
    dom.menuDisplayValue.textContent = `${FONT_SIZE_LABELS[settings.fontSize] ?? '标准'} · ${
      FONT_FAMILY_LABELS[settings.fontFamily] ?? '系统默认'
    }`;
  }
}

/** 打开设置抽屉。未配置仓库时直接落在「仓库连接」。 */
function openSettingsSheet(view = 'menu') {
  const settings = store.settings();
  const target = !store.configured() && view === 'menu' ? 'repo' : view;
  if (dom.setProvider) dom.setProvider.value = providerInfo(settings.provider).id;
  dom.setOwner.value = settings.owner;
  dom.setRepo.value = settings.repo;
  dom.setBranch.value = settings.branch || 'main';
  dom.setToken.value = settings.token;
  applyProviderHints(settings.provider);
  applyDisplaySettings();
  renderSettingsStatus();
  dom.settingsSheet.hidden = false;
  showSettingsView(target);
}

function showSettingsView(view) {
  ui.settingsView = view;
  if (dom.settingsTitle) dom.settingsTitle.textContent = SETTINGS_TITLES[view] ?? '设置';
  if (dom.settingsBack) dom.settingsBack.hidden = view === 'menu';
  if (dom.settingsMenu) dom.settingsMenu.hidden = view !== 'menu';
  for (const element of dom.settingsViews) {
    element.hidden = element.dataset.view !== view;
  }
}

function closeSettingsSheet() {
  if (dom.settingsSheet) dom.settingsSheet.hidden = true;
  refreshCounts();
  if (ui.screen === 'input') ensureEditorFocus();
}

/** 把显示设置写到 <html> 上：正文用 rem 跟随基准字号，输入框另有下限。 */
function applyDisplaySettings() {
  const settings = store.settings();
  const root = document.documentElement;
  root.style.setProperty('--font-family', fontStack(settings.fontFamily));
  root.style.setProperty('--font-scale', String(fontScale(settings.fontSize)));
  if (dom.setFontFamily) dom.setFontFamily.value = settings.fontFamily;
  if (dom.setFontSize) {
    for (const button of dom.setFontSize.querySelectorAll('[data-size]')) {
      button.setAttribute('aria-pressed', String(button.dataset.size === settings.fontSize));
    }
  }
}

function changeFontFamily() {
  if (!dom.setFontFamily) return;
  store.saveSettings({ fontFamily: dom.setFontFamily.value });
  applyDisplaySettings();
  renderSettingsStatus();
}

function changeFontSize(event) {
  const button = event.target.closest('[data-size]');
  if (!button) return;
  store.saveSettings({ fontSize: button.dataset.size });
  applyDisplaySettings();
  renderSettingsStatus();
  toast('字号已更新');
}

function toggleTokenVisibility() {
  if (!dom.setToken || !dom.toggleToken) return;
  const reveal = dom.setToken.type === 'password';
  dom.setToken.type = reveal ? 'text' : 'password';
  dom.toggleToken.setAttribute('aria-pressed', String(reveal));
  dom.toggleToken.setAttribute('aria-label', reveal ? '隐藏令牌' : '显示令牌');
  dom.toggleToken.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${
    reveal ? 'i-eye-off' : 'i-eye'
  }"></use></svg>`;
}

async function saveSettings(event) {
  event.preventDefault();
  store.saveSettings({
    provider: dom.setProvider ? dom.setProvider.value : store.settings().provider,
    owner: dom.setOwner.value.trim(),
    repo: dom.setRepo.value.trim(),
    branch: dom.setBranch.value.trim() || 'main',
    token: dom.setToken.value.trim(),
  });
  applyProviderHints(store.settings().provider);
  buildClient();
  refreshCounts();
  if (!sync) {
    toast('请填写账号、仓库名和令牌');
    return;
  }
  toast('正在验证令牌…');
  try {
    const login = await ghClient.whoAmI();
    const result = await sync.syncNow();
    renderSettingsStatus();
    refreshCounts();
    if (result.ok) {
      toast(`连接成功（${login}），已同步`);
    } else {
      toast(`令牌可用，但同步失败：${shortError(result.error)}`, 4000);
    }
  } catch (error) {
    store.saveStatus({ lastError: error?.message ?? String(error) });
    renderSettingsStatus();
    toast(`连接失败：${shortError(error?.message ?? error)}`, 4000);
  }
}

async function uploadNow() {
  if (!sync) {
    toast('先配置仓库');
    return;
  }
  toast('正在上传…');
  const result = await sync.syncNow();
  renderSettingsStatus();
  refreshCounts();
  if (result.ok) {
    toast(result.uploaded?.length ? `已上传 ${result.uploaded.length} 天` : '没有需要上传的内容');
  } else if (result.reason === 'not-configured') {
    toast('先配置仓库');
  } else {
    toast(`上传失败：${shortError(result.error)}`, 4000);
  }
}

async function sealToday() {
  const today = dateKey();
  const count = store.dayRecords(today).length;
  if (!count) {
    toast('今天还没有记录');
    return;
  }
  if (!sync) {
    toast('先配置仓库');
    return;
  }
  if (!window.confirm(`把今天 ${count} 条记录立即上传并封存？封存后只能追加"更正"。`)) return;
  try {
    await sync.uploadDay(today);
    refreshCounts();
    renderSettingsStatus();
    renderRead();
    toast('已封存');
  } catch (error) {
    toast(`上传失败：${shortError(error?.message ?? error)}`, 4000);
  }
}

function clearLocal() {
  if (!window.confirm('清空这台设备上的全部本地数据？')) return;
  if (!window.confirm('再次确认：未上传的记录会永久丢失，无法恢复。')) return;
  store.clearAll();
  window.location.reload();
}

// ------------------------------------------------------------------ 分享目标

function applyShareTarget() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('share') !== '1') return;
  const shared = [params.get('title'), params.get('text'), params.get('url')]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (shared) {
    dom.editor.value = shared;
    store.saveDraft(shared);
    toast('已填入分享内容，保存后即记录');
  }
  window.history.replaceState(null, '', window.location.pathname);
}

// ------------------------------------------------------------------ 启动

function bindEvents() {
  dom.today.addEventListener('click', () => openRead(dateKey()));
  dom.pending.addEventListener('click', () => {
    renderConfirm();
    show('confirm');
  });
  dom.openSettings.addEventListener('click', () => openSettingsSheet('menu'));

  if (dom.settingsMenu) {
    dom.settingsMenu.addEventListener('click', (event) => {
      const item = event.target.closest('[data-view]');
      if (item) showSettingsView(item.dataset.view);
    });
  }
  if (dom.settingsBack) {
    dom.settingsBack.addEventListener('click', () => showSettingsView('menu'));
  }
  if (dom.settingsClose) {
    dom.settingsClose.addEventListener('click', closeSettingsSheet);
  }
  if (dom.settingsSheet) {
    dom.settingsSheet.addEventListener('click', (event) => {
      if (event.target === dom.settingsSheet) closeSettingsSheet();
    });
    // 输入框聚焦后滚进可视区，避免软键盘把它挡住
    dom.settingsSheet.addEventListener('focusin', (event) => {
      const field = event.target;
      if (!field || typeof field.matches !== 'function') return;
      if (!field.matches('input, select, textarea')) return;
      setTimeout(() => {
        try {
          field.scrollIntoView({ block: 'center' });
        } catch {
          /* 老浏览器忽略即可 */
        }
      }, 250);
    });
  }

  for (const button of document.querySelectorAll('[data-action="back"]')) {
    button.addEventListener('click', () => {
      show('input');
      refreshCounts();
    });
  }

  dom.readDays.addEventListener('click', (event) => {
    const button = event.target.closest('[data-date]');
    if (!button) return;
    ui.readDate = button.dataset.date;
    ui.derivedDate = '';
    renderRead();
  });

  dom.readList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="record-menu"]');
    if (!button) return;
    const uuid = button.closest('[data-uuid]')?.dataset.uuid;
    const record = store.dayRecords(ui.readDate).find((item) => item.uuid === uuid);
    if (record) openRecordMenu(ui.readDate, record);
  });

  if (dom.readPick) dom.readPick.addEventListener('click', openCalendar);
  if (dom.calPrev) {
    dom.calPrev.addEventListener('click', () => {
      const next = shiftMonth({ year: ui.calYear, month: ui.calMonth }, -1);
      ui.calYear = next.year;
      ui.calMonth = next.month;
      renderCalendar();
    });
  }
  if (dom.calNext) {
    dom.calNext.addEventListener('click', () => {
      const next = shiftMonth({ year: ui.calYear, month: ui.calMonth }, 1);
      ui.calYear = next.year;
      ui.calMonth = next.month;
      renderCalendar();
    });
  }
  if (dom.calToday) {
    dom.calToday.addEventListener('click', () => pickDate(dateKey()));
  }
  if (dom.calGrid) {
    dom.calGrid.addEventListener('click', (event) => {
      const cell = event.target.closest('[data-date]');
      if (cell) pickDate(cell.dataset.date);
    });
  }
  if (dom.calSheet) {
    dom.calSheet.addEventListener('click', (event) => {
      if (event.target === dom.calSheet) closeCalendar();
    });
  }

  dom.append.addEventListener('click', () => {
    const date = ui.readDate;
    openTextSheet({
      title: `补记到 ${date}`,
      placeholder: '补一条漏掉的',
      onSave: (text) => {
        const body = foldText(text);
        if (!body) return;
        store.addRecord(body, new Date(`${date}T${timeKey()}`));
        renderRead();
        refreshCounts();
        scheduleSync(1200);
        toast('已补记');
      },
    });
  });

  dom.refresh.addEventListener('click', async () => {
    ui.derivedDate = '';
    renderRead();
    scheduleSync(0);
    toast('正在刷新');
  });

  dom.confirmList.addEventListener('click', handleConfirmClick);
  dom.syncButton.addEventListener('click', uploadNow);
  dom.form.addEventListener('submit', saveSettings);
  dom.setProvider.addEventListener('change', () => applyProviderHints(dom.setProvider.value));
  if (dom.setFontFamily) dom.setFontFamily.addEventListener('change', changeFontFamily);
  if (dom.setFontSize) dom.setFontSize.addEventListener('click', changeFontSize);
  if (dom.toggleToken) dom.toggleToken.addEventListener('click', toggleTokenVisibility);
  dom.uploadNow.addEventListener('click', uploadNow);
  dom.sealToday.addEventListener('click', sealToday);
  dom.clear.addEventListener('click', clearLocal);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      clearTimeout(draftTimer);
      store.saveDraft(dom.editor.value);
      return;
    }
    if (ui.screen === 'input') ensureEditorFocus();
    refreshCounts();
    scheduleSync(0);
  });

  window.addEventListener('pagehide', () => {
    clearTimeout(draftTimer);
    store.saveDraft(dom.editor.value);
  });

  // 首次点击任何位置都把焦点交给输入框（兜底：移动端未必允许自动弹键盘）
  document.addEventListener(
    'pointerdown',
    () => {
      if (ui.screen === 'input' && document.activeElement !== dom.editor) focusEditor();
    },
    { passive: true }
  );

  window.addEventListener('pageshow', () => ensureEditorFocus());
  window.addEventListener('focus', () => ensureEditorFocus());
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (window.location.protocol === 'http:' && window.location.hostname !== 'localhost') return;
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* 离线缓存失败不影响使用 */
  });
}

function init() {
  buildClient();
  bindEditor();
  bindEvents();
  applyShareTarget();

  const draft = store.draft();
  if (draft.text) dom.editor.value = draft.text;

  refreshCounts();
  renderSettingsStatus();
  applyDisplaySettings();
  registerServiceWorker();

  if (!store.configured()) {
    openSettingsSheet();
    toast('先选好托管平台，填上仓库与访问令牌', 3600);
    return;
  }

  const status = store.status();
  if (status.lastError) toast(`上次同步失败：${shortError(status.lastError)}`, 4000);
  show('input');
  ensureEditorFocus();
  scheduleSync(400);
}

init();
