const api = window.electronAPI;
if (!api) {
  document.body.innerHTML =
    '<p style="padding:24px;color:#ff4d4f">预加载失败，请完全退出后重新运行 pnpm start</p>';
  throw new Error('electronAPI not available');
}

if (api.platform) {
  document.documentElement.classList.add(`platform-${api.platform}`);
}
if (api.winTitleBarOverlay) {
  document.documentElement.classList.add('platform-win32-overlay');
}

const {
  startExport,
  pauseExport,
  resumeExport,
  stopExport,
  openDirectory,
  openTargetsFile,
  getSettings,
  saveSettings,
  onExportProgress,
  onExportPaused,
  onExportResumed,
  onExportComplete,
  onExportError,
  onChromeStatus
} = api;

const startDate = document.getElementById('startDate');
const endDate = document.getElementById('endDate');
const singleDayMode = document.getElementById('singleDayMode');
const exportModeRadios = document.querySelectorAll('input[name="exportMode"]');
const targetListSection = document.getElementById('targetListSection');
const targetsFile = document.getElementById('targetsFile');
const selectTargetsFileBtn = document.getElementById('selectTargetsFile');
const targetsSheet = document.getElementById('targetsSheet');
const targetListStrategy = document.getElementById('targetListStrategy');
const department = document.getElementById('department');
const outputDir = document.getElementById('outputDir');
const selectDirBtn = document.getElementById('selectDir');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resumeBtn = document.getElementById('resumeBtn');
const stopBtn = document.getElementById('stopBtn');

const statusBar = document.getElementById('statusBar');
const taskHint = document.getElementById('taskHint');
const progressText = document.getElementById('progressText');
const exportProgressRing = document.getElementById('exportProgressRing');
const circularFill = document.getElementById('circularFill');
const circularPercent = document.getElementById('circularPercent');
const logContent = document.getElementById('logContent');
const crmStatusDot = document.getElementById('crmStatusDot');
const crmStatusText = document.getElementById('crmStatusText');
const wxStatusDot = document.getElementById('wxStatusDot');
const wxStatusText = document.getElementById('wxStatusText');
const wxLoginActions = document.getElementById('wxLoginActions');
const workflowStepper = document.getElementById('workflowStepper');
const statProcessed = document.getElementById('statProcessed');
const statSuccess = document.getElementById('statSuccess');
const statError = document.getElementById('statError');
const targetFileChip = document.getElementById('targetFileChip');
const targetFileName = document.getElementById('targetFileName');
const checkBtn = document.getElementById('checkBtn');

const CIRCULAR_CIRCUMFERENCE = 2 * Math.PI * 52;

let exportUiState = 'idle';
let idleStatusMessage = '就绪';
let chromeReady = false;
let wxLoginRequired = false;
/** 会话弹窗已就绪（好友列表弹窗或企微消息 iframe） */
let wxDialogReady = false;
/** 已从弹窗内成功读取至少一条会话消息（脚本 [conversation] messages 日志） */
let wxChatVerified = false;
let exportStats = { processed: 0, total: 0, success: 0, error: 0 };
let workflowCompleted = new Set();
/** 最近一次带 current/total 的进度，避免普通日志把进度条打回「进行中」 */
let lastExportProgress = { current: 0, total: 0 };
let lastPercentShown = 0;
/** employees | conversation（补跑 failed_conversation_ids） */
let progressUnit = 'employee';
/** 用户点继续后跳过脚本侧 export-resumed 的重复日志 */
let suppressResumeLog = false;

/** 导出脚本内部调试日志：不展示在 Electron 日志面板（stdout 仍保留，便于终端排查） */
const EXPORT_LOG_HIDE_PATTERNS = [
  /^\[dom-wait\]/,
  /^\[paced\] wait /,
  /^\[conversation\] scroll /,
  /^\[conversation\] messages /,
  /^\[conversation\] skip already completed/,
  /^\[conversation\] .+__customer_\d+ source=/,
  /^\[conversation\] .+ metrics=/,
  /^\[conversation\] .+ friend="/,
  /^\[metric\]/,
  /^\[voice\] found /,
  /^\[voice\] transcribe /,
  /^\[row\] dialog ready/,
  /^\[row\] adjust /,
  /^\[row\] filters title=/,
  /^\[row\] clear friend search/,
  /^\[friend-page\] next ok=/
];

function shouldShowExportLog(message) {
  if (!message || typeof message !== 'string') return false;
  if (message.includes('[progress-debug]')) return false;
  return !EXPORT_LOG_HIDE_PATTERNS.some((re) => re.test(message));
}

/** 本地时区 YYYY-MM-DD（避免 toISOString 差一天） */
function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return localDateStr(dt);
}

function defaultExportDate() {
  return addDays(localDateStr(), -1);
}

function applyDateInputBounds() {
  const today = localDateStr();
  startDate.max = today;
  endDate.max = today;
}

/** 无已保存日期时默认为昨天（本地时区） */
function applyDefaultExportDate() {
  const d = defaultExportDate();
  startDate.value = d;
  endDate.value = d;
  applyDateInputBounds();
  applySingleDayMode();
}

function applySingleDayMode() {
  const single = singleDayMode.checked;
  endDate.disabled = single;
  endDate.classList.toggle('date-input-muted', single);
  if (single) {
    endDate.value = startDate.value;
  } else {
    endDate.min = startDate.value;
    if (endDate.value < startDate.value) {
      endDate.value = startDate.value;
    }
  }
  syncDatePresetButtons();
}

function getDateRange() {
  const start = startDate.value;
  const end = singleDayMode.checked ? start : endDate.value || start;
  return { start, end };
}

function setDatePreset(preset) {
  const today = localDateStr();
  const pick = preset === 'today' ? today : addDays(today, -1);
  startDate.value = pick;
  if (singleDayMode.checked) {
    endDate.value = pick;
  } else if (!endDate.value || endDate.value < pick) {
    endDate.value = pick;
  }
  applySingleDayMode();
  syncDatePresetButtons();
}

function syncDatePresetButtons() {
  const today = localDateStr();
  const yesterday = addDays(today, -1);
  const start = startDate.value;
  const end = endDate.value;
  document.querySelectorAll('.btn-preset').forEach((btn) => {
    const isToday = btn.dataset.preset === 'today';
    const pick = isToday ? today : yesterday;
    let active;
    if (singleDayMode.checked) {
      active = start === pick && end === pick;
    } else {
      active = start === pick && end === pick;
    }
    btn.classList.toggle('is-active', active);
  });
}

function statusStateText() {
  if (wxLoginRequired) return '等待企业微信登录';
  if (exportUiState === 'stopping') return '停止中…';
  if (exportUiState === 'pausing') return '暂停中…';
  if (exportUiState === 'paused') return '已暂停';
  if (exportUiState === 'running') return '导出中…';
  return idleStatusMessage;
}

function setIdleStatus(message, hint) {
  idleStatusMessage = message || '就绪';
  if (taskHint && hint != null) {
    taskHint.textContent = hint;
  }
  refreshStatusLabel();
}

function refreshStatusLabel() {
  const text = statusStateText();
  if (statusBar) {
    statusBar.textContent = text;
  }
  if (exportProgressRing) {
    exportProgressRing.setAttribute('aria-label', text);
  }
  if (wxLoginActions) {
    wxLoginActions.classList.toggle('is-hidden', !wxLoginRequired);
  }
}

function setHeaderStatus(kind, state, text) {
  const dot = kind === 'crm' ? crmStatusDot : wxStatusDot;
  const label = kind === 'crm' ? crmStatusText : wxStatusText;
  if (!dot || !label) return;
  dot.className = `status-dot status-dot--${state}`;
  label.textContent = text;
}

const exportLifecycleActive = () =>
  exportUiState === 'running' ||
  exportUiState === 'paused' ||
  exportUiState === 'pausing' ||
  exportUiState === 'stopping';

function resetWxVerification() {
  wxDialogReady = false;
  wxChatVerified = false;
}

/** 根据导出脚本日志判定企微是否真能拉聊天记录（非导出开始即显示正常） */
function noteWxFromExportLog(message) {
  if (!message || typeof message !== 'string' || wxLoginRequired) return;
  if (/^\[row\] dialog ready true\b/.test(message)) {
    wxDialogReady = true;
  }
  if (/^\[dom-wait\] message iframe ready\b/.test(message)) {
    wxDialogReady = true;
  }
  if (wxDialogReady && /^\[conversation\] messages \d+\//.test(message)) {
    wxChatVerified = true;
    if (exportLifecycleActive()) {
      syncCrmWxHeader('wx-ok');
    }
  }
}

/** 左上角仅展示 CRM / 企微连接与就绪；导出、暂停、停止等只在右侧任务区 statusBar 展示 */
function syncCrmWxHeader(phase) {
  const setWxDetecting = () => {
    if (wxLoginRequired) return;
    setHeaderStatus('wx', 'info', '企微检测中');
  };
  const setWxNormal = () => {
    if (wxLoginRequired) return;
    setHeaderStatus('wx', 'ok', '企微正常');
  };
  const setWx = (state, text) => {
    if (wxLoginRequired) {
      setHeaderStatus('wx', 'error', '企微需登录');
      return;
    }
    setHeaderStatus('wx', state, text);
  };

  switch (phase) {
    case 'chrome-ready':
      if (exportLifecycleActive()) return;
      setHeaderStatus('crm', 'info', 'CRM 待导出');
      setWxDetecting();
      break;
    case 'chrome-connecting':
      setHeaderStatus('crm', 'info', 'CRM 连接中');
      setWxDetecting();
      break;
    case 'chrome-error':
      setHeaderStatus('crm', 'error', 'CRM 未就绪');
      setWxDetecting();
      break;
    case 'conditions':
      setHeaderStatus('crm', 'ok', 'CRM 已就绪');
      setWxDetecting();
      break;
    case 'preflight':
      setHeaderStatus('crm', 'info', 'CRM 准备中');
      if (wxChatVerified) setWxNormal();
      else setWxDetecting();
      break;
    case 'gate-ready':
      setHeaderStatus('crm', 'ok', 'CRM 已就绪');
      if (wxChatVerified) setWxNormal();
      else setWxDetecting();
      break;
    case 'wx-ok':
      setHeaderStatus('crm', 'ok', 'CRM 已就绪');
      setWxNormal();
      break;
    case 'wx-error':
      if (chromeReady) {
        setHeaderStatus('crm', 'ok', 'CRM 已就绪');
      }
      setHeaderStatus('wx', 'error', '企微需登录');
      break;
    default:
      break;
  }
}

function updateStepper(activeStep) {
  if (!workflowStepper) return;
  const order = ['chrome', 'crm', 'conditions', 'gate', 'export'];
  const activeIdx = order.indexOf(activeStep);
  workflowStepper.querySelectorAll('.stepper-item').forEach((item) => {
    const step = item.dataset.step;
    const idx = order.indexOf(step);
    item.classList.remove('is-done', 'is-active');
    if (workflowCompleted.has(step) || idx < activeIdx) {
      item.classList.add('is-done');
    } else if (step === activeStep) {
      item.classList.add('is-active');
    }
  });
  const lines = workflowStepper.querySelectorAll('.stepper-line');
  lines.forEach((line, i) => {
    line.classList.toggle('is-done', i < activeIdx);
  });
}

function updateStats() {
  const { processed, total, success, error } = exportStats;
  if (statProcessed) {
    if (total > 0) {
      statProcessed.innerHTML = `<span class="stat-value-num">${processed}</span><span class="stat-value-denom">/${total}</span>`;
    } else {
      statProcessed.innerHTML = `<span class="stat-value-num">${processed}</span>`;
    }
  }
  if (statSuccess) statSuccess.textContent = String(success);
  if (statError) statError.textContent = String(error);
}

function basename(filePath) {
  if (!filePath) return '';
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

function updateTargetFileChip() {
  const path = targetsFile?.value || '';
  const name = basename(path);
  if (targetFileName) {
    targetFileName.textContent = name || '未选择文件';
  }
  if (targetFileChip) {
    targetFileChip.classList.toggle('is-empty', !name);
  }
}

function inferLogType(message) {
  if (!message || typeof message !== 'string') return 'info';
  if (
    /^\[OK\]|导出完成|已成功|successfully|CSV written|CSV 已生成/i.test(message) ||
    /^条件检查通过|^已选择目录|^目标名单已读取/.test(message)
  ) {
    return 'success';
  }
  if (
    /^\[warn\]|^错误:|^错误 |失败|未就绪|export-error|需登录|仍有 \d+ 条.*失败/i.test(message)
  ) {
    return 'error';
  }
  return 'info';
}

function resolveLogType(message, type = 'info') {
  if (type === 'success' || type === 'error') return type;
  return inferLogType(message);
}

function detectLogTag(message) {
  if (/WXWORK_LOGIN_EXPIRED|企业微信登录会话已过期|企业微信内嵌登录/.test(message)) {
    return 'WXWORK_LOGIN_EXPIRED';
  }
  if (/CRM_LOGIN_REQUIRED|当前页面：/.test(message) && /登录 CRM|登录页/.test(message)) {
    return 'CRM_LOGIN';
  }
  return null;
}

function handleWxworkLoginRequired(message) {
  wxLoginRequired = true;
  resetWxVerification();
  syncCrmWxHeader('wx-error');
  setIdleStatus(
    '等待企业微信登录',
    message || '请在 CRM 页面选中客户后扫描内嵌二维码，完成后点击「我已扫码」。'
  );
  updateStepper('conditions');
}

/** 导出完成后用后端会话数更新「成功 / 错误」 */
function applyConversationStats(convTotal, convFailed) {
  const total = Number(convTotal) || 0;
  const failed = Number(convFailed) || 0;
  if (total <= 0 && failed <= 0) return;
  exportStats.success = total > 0 ? Math.max(0, total - failed) : 0;
  exportStats.error = failed;
  updateStats();
}

function employeeProgressPercent(current, total) {
  if (total <= 0) return 0;
  if (current >= total) return 100;
  return Math.round((current / total) * 100);
}

function formatProgressCaption(current, total, unit = progressUnit, options = {}) {
  if (total <= 0) {
    if (unit === 'conversation') return '续传 —';
    if (unit === 'day') return '按天 —';
    return '员工 —';
  }
  if (unit === 'conversation') {
    return `续传 ${current}/${total}`;
  }
  if (unit === 'day') {
    return `第 ${current}/${total} 天`;
  }
  if (options.resume) {
    return `续传 ${current}/${total}`;
  }
  return `员工 ${current}/${total}`;
}

function setProgressPercentOnBar(percent) {
  const label = percent < 0 ? '…' : `${percent}%`;
  if (circularPercent) {
    circularPercent.textContent = label;
  }
  if (circularFill) {
    const offset =
      percent >= 0
        ? CIRCULAR_CIRCUMFERENCE * (1 - Math.min(100, Math.max(0, percent)) / 100)
        : CIRCULAR_CIRCUMFERENCE * 0.75;
    circularFill.style.strokeDashoffset = String(offset);
  }
  if (exportProgressRing) {
    if (percent >= 0) {
      exportProgressRing.setAttribute(
        'aria-valuenow',
        String(Math.min(100, Math.max(0, percent)))
      );
    }
  }
}

function isRetryFailedProgress(unit, phase) {
  return unit === 'conversation' || phase === 'retry-failed';
}

/**
 * 进度条更新。主流程单调不降；补跑 failed 会话按实际比例更新。
 */
function applyEmployeeProgressBar(current, total, options = {}) {
  if (total <= 0) return;
  const unit = options.unit || progressUnit;
  const phase = options.phase || null;
  const retryMode = isRetryFailedProgress(unit, phase);
  const percent = employeeProgressPercent(current, total);
  if (options.reset || options.allowDecrease || retryMode) {
    lastPercentShown = percent;
  } else {
    lastPercentShown = Math.max(lastPercentShown, percent);
  }
  setProgressPercentOnBar(lastPercentShown);
  const resume = Boolean(options.resume);
  if (progressText) {
    progressText.textContent = formatProgressCaption(current, total, unit, { resume });
  }
  lastExportProgress = { current: Math.min(current, total), total };
  progressUnit = unit;
  exportStats.processed = Math.min(current, total);
  exportStats.total = total;
  updateStats();
  updateStepper('export');
}

/** 导出成功结束时展示 100%（须在 setUIState('idle') 之前调用） */
function finishExportProgressBar() {
  const { total } = lastExportProgress;
  if (total > 0) {
    applyEmployeeProgressBar(total, total);
    return;
  }
  lastPercentShown = 100;
  setProgressPercentOnBar(100);
  if (progressText) {
    progressText.textContent = '完成';
  }
}

function resetProgress(options = {}) {
  lastExportProgress = { current: 0, total: 0 };
  lastPercentShown = 0;
  progressUnit = 'employee';
  if (!options.keepStats) {
    exportStats = { processed: 0, total: 0, success: 0, error: 0 };
    updateStats();
  }
  setProgressPercentOnBar(0);
  if (progressText) {
    progressText.textContent = '员工 —';
  }
}

function setUIState(state, options = {}) {
  exportUiState = state;
  const exportActive =
    state === 'running' ||
    state === 'paused' ||
    state === 'pausing' ||
    state === 'stopping';
  startBtn.disabled = exportActive;
  if (checkBtn) {
    checkBtn.disabled = exportActive;
    checkBtn.classList.toggle('is-hidden', exportActive);
  }
  pauseBtn.disabled = state !== 'running';
  resumeBtn.disabled = state !== 'paused' && state !== 'pausing';
  stopBtn.disabled = !exportActive;
  pauseBtn.classList.toggle('is-hidden', state !== 'running');
  resumeBtn.classList.toggle('is-hidden', state !== 'paused' && state !== 'pausing');

  if (state === 'idle' && !options.keepProgress) {
    resetProgress({ keepStats: Boolean(options.keepStats) });
    if (!wxLoginRequired) {
      updateStepper(chromeReady ? 'conditions' : 'chrome');
    }
  } else if (exportActive) {
    updateStepper('export');
  }

  if (options.headerPhase) {
    syncCrmWxHeader(options.headerPhase);
  } else if (
    (state === 'running' || state === 'paused' || state === 'pausing' || state === 'stopping') &&
    chromeReady
  ) {
    syncCrmWxHeader('gate-ready');
  } else if (state === 'idle') {
    if (options.wxOk && wxChatVerified) {
      syncCrmWxHeader('wx-ok');
      setIdleStatus('导出完成', '可查看输出目录中的导出文件');
    } else if (options.wxOk) {
      if (chromeReady) {
        syncCrmWxHeader('conditions');
      }
      setIdleStatus('导出完成', '可查看输出目录中的导出文件');
    } else if (options.stopped) {
      if (chromeReady) {
        syncCrmWxHeader(wxChatVerified ? 'wx-ok' : 'gate-ready');
      }
      setIdleStatus('已停止', '进度已保存，可再次点击「开始导出」续传');
    } else if (!options.keepProgress && chromeReady && !wxLoginRequired) {
      syncCrmWxHeader('chrome-ready');
    }
  }

  refreshStatusLabel();
}

function getExportMode() {
  const checked = document.querySelector('input[name="exportMode"]:checked');
  return checked?.value || 'effective';
}

function applyExportModeUi() {
  const mode = getExportMode();
  targetListSection.classList.toggle('is-hidden', mode !== 'targetList');
}

async function persistFormSettings() {
  const { start, end } = getDateRange();
  const payload = {
    singleDayMode: singleDayMode.checked,
    useDateRange: !singleDayMode.checked,
    startDate: start,
    endDate: end,
    exportMode: getExportMode(),
    targetsFile: targetsFile.value,
    targetsSheet: targetsSheet.value,
    targetListStrategy: targetListStrategy.value,
    outputDir: outputDir.value,
    department: department.value
  };
  await saveSettings(payload);
}

async function restoreFormSettings() {
  const saved = await getSettings();

  const single =
    saved.singleDayMode != null
      ? saved.singleDayMode
      : saved.useDateRange == null
        ? true
        : !saved.useDateRange;
  singleDayMode.checked = single;

  const mode = saved.exportMode || (saved.allCustomers ? 'all' : 'effective');
  exportModeRadios.forEach((radio) => {
    radio.checked = radio.value === mode;
  });
  if (saved.targetsFile) targetsFile.value = saved.targetsFile;
  if (saved.targetsSheet) targetsSheet.value = saved.targetsSheet;
  if (saved.targetListStrategy) {
    targetListStrategy.value = saved.targetListStrategy;
  }

  if (saved.outputDir) outputDir.value = saved.outputDir;
  if (saved.department) department.value = saved.department;

  applyDateInputBounds();
  const today = localDateStr();
  const savedStart = saved.startDate;
  const savedEnd = saved.endDate;
  if (savedStart && savedStart <= today) {
    startDate.value = savedStart;
    if (singleDayMode.checked) {
      endDate.value = savedStart;
    } else if (savedEnd && savedEnd >= savedStart && savedEnd <= today) {
      endDate.value = savedEnd;
    } else {
      endDate.value = savedStart;
    }
  } else {
    applyDefaultExportDate();
  }
  applySingleDayMode();
  syncDatePresetButtons();
  applyExportModeUi();
  updateTargetFileChip();

  if (saved.outputDir) {
    addLog(`已恢复输出目录: ${saved.outputDir}`, 'info');
  }
}

function addLog(message, type = 'info', tag) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  const time = document.createElement('span');
  time.className = 'log-entry-time';
  time.textContent = new Date().toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const dot = document.createElement('span');
  const dotKind = resolveLogType(message, type);
  dot.className = `log-entry-dot log-entry-dot--${dotKind}`;
  dot.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'log-entry-message';
  text.textContent = message;
  const resolvedTag = tag || detectLogTag(message);
  entry.append(time, dot, text);
  if (resolvedTag) {
    const tagEl = document.createElement('span');
    tagEl.className = 'log-entry-tag';
    tagEl.textContent = resolvedTag;
    entry.appendChild(tagEl);
  }
  logContent.insertBefore(entry, logContent.firstChild);
  const scroller = logContent.parentElement;
  if (scroller) scroller.scrollTop = 0;

  noteWxFromExportLog(message);

  if (resolvedTag === 'WXWORK_LOGIN_EXPIRED') {
    handleWxworkLoginRequired(message);
  }
}

function updateProgress(data) {
  const msg = data.message;
  // 过滤脚本侧发的暂停/恢复通知
  if (
    msg &&
    typeof msg === 'string' &&
    (msg.includes('"event":"export-paused"') ||
      msg.includes('"event":"export-resumed"'))
  ) {
    return;
  }

  const total = typeof data.total === 'number' && data.total > 0 ? data.total : 0;
  const current = data.current ?? data.completed ?? 0;

  if (msg && typeof msg === 'string') {
    noteWxFromExportLog(msg);
    const syncHeader = exportUiState === 'running';
    if (msg.includes('正在准备 CRM') || msg.includes('预检')) {
      updateStepper('crm');
      if (syncHeader) {
        syncCrmWxHeader('preflight');
      }
      if (chromeReady) {
        workflowCompleted.add('chrome');
      }
    } else if (msg.includes('校验员工列表') || msg.includes('gate')) {
      updateStepper('gate');
      if (syncHeader) {
        syncCrmWxHeader('gate-ready');
      }
      workflowCompleted.add('crm');
      workflowCompleted.add('conditions');
    } else if (
      msg.includes('正在导出') ||
      msg.includes('按天导出') ||
      msg.includes('目标名单跨日期')
    ) {
      updateStepper('export');
      workflowCompleted.add('gate');
    } else if (msg.includes('目标名单') && msg.includes('读取')) {
      updateStepper('conditions');
    }

    if (msg.includes('[progress-debug]')) {
      /* 调试日志不展示 */
    } else {
      const isProgressTicker =
        /^员工 \d+\/\d+/.test(msg) || /^续传 \d+\/\d+/.test(msg);
      if (!isProgressTicker && shouldShowExportLog(msg)) {
        addLog(msg, inferLogType(msg));
      }
    }
  }

  const retryPhase =
    data.phase === 'retry-failed' ||
    data.unit === 'conversation' ||
    (typeof msg === 'string' && msg.includes('[retry-failed]'));

  if (data.reset || retryPhase) {
    lastPercentShown = 0;
  }
  if (data.unit === 'conversation' || data.unit === 'employee' || data.unit === 'day') {
    progressUnit = data.unit;
  }
  if (data.unit === 'day' && data.reset) {
    lastPercentShown = 0;
  }
  if (retryPhase) {
    progressUnit = 'conversation';
  }

  if (retryPhase && Boolean(data.reset)) {
    progressUnit = 'conversation';
    lastPercentShown = 0;
    setProgressPercentOnBar(0);
    if (total > 0) {
      applyEmployeeProgressBar(current, total, {
        reset: true,
        allowDecrease: true,
        unit: 'conversation',
        phase: 'retry-failed'
      });
    } else if (progressText) {
      progressText.textContent = '续传 —';
    }
    return;
  }

  const resume =
    progressUnit === 'employee' &&
    (data.phase === 'resume' ||
      (typeof msg === 'string' && msg.includes('续传')));

  if (total > 0) {
    applyEmployeeProgressBar(current, total, {
      reset: Boolean(data.reset) || retryPhase,
      allowDecrease: Boolean(data.reset) || retryPhase,
      unit: progressUnit,
      phase: data.phase,
      resume
    });
  } else if (current > 0) {
    setProgressPercentOnBar(-1);
    if (progressText) {
      progressText.textContent = '…';
    }
  }
}

function validateExportForm() {
  if (!outputDir.value) {
    addLog('请先选择输出目录', 'error');
    return false;
  }
  const { start, end } = getDateRange();
  if (!start || !end) {
    addLog('请选择导出日期', 'error');
    return false;
  }
  if (end < start) {
    addLog('结束日期不能早于开始日期', 'error');
    return false;
  }
  const mode = getExportMode();
  if (mode === 'targetList' && !targetsFile.value) {
    addLog('请先选择目标名单文件（Excel/CSV）', 'error');
    return false;
  }
  return true;
}

document.querySelectorAll('.btn-preset').forEach((btn) => {
  btn.addEventListener('click', () => {
    setDatePreset(btn.dataset.preset);
  });
});

singleDayMode.addEventListener('change', () => {
  applySingleDayMode();
  persistFormSettings();
});

exportModeRadios.forEach((radio) => {
  radio.addEventListener('change', () => {
    applyExportModeUi();
    persistFormSettings();
  });
});

targetsSheet.addEventListener('change', () => persistFormSettings());
targetListStrategy.addEventListener('change', () => persistFormSettings());

startDate.addEventListener('change', () => {
  endDate.min = startDate.value;
  if (singleDayMode.checked) {
    endDate.value = startDate.value;
  } else if (endDate.value < startDate.value) {
    endDate.value = startDate.value;
  }
  syncDatePresetButtons();
  persistFormSettings();
});

endDate.addEventListener('change', () => {
  syncDatePresetButtons();
  persistFormSettings();
});

if (checkBtn) {
  checkBtn.addEventListener('click', () => {
    if (!validateExportForm()) return;
    const { start, end } = getDateRange();
    addLog(
      `条件检查通过：${start}${start === end ? '' : ` ~ ${end}`} · ${department.value}`,
      'success'
    );
    updateStepper('conditions');
    if (chromeReady) {
      workflowCompleted.add('chrome');
    }
    syncCrmWxHeader('conditions');
    setIdleStatus('条件已就绪', '日期、部门与输出目录已填写；请在专用 Chrome 窗口确认 CRM 已登录后再导出。');
  });
}

const wxScannedBtn = document.getElementById('wxScannedBtn');
if (wxScannedBtn) {
  wxScannedBtn.addEventListener('click', () => {
    wxLoginRequired = false;
    resetWxVerification();
    syncCrmWxHeader(
      exportLifecycleActive()
        ? wxChatVerified
          ? 'wx-ok'
          : 'gate-ready'
        : 'conditions'
    );
    setIdleStatus('就绪', '若已完成扫码，可点击「开始导出」重试。');
  });
}

startBtn.addEventListener('click', async () => {
  if (!validateExportForm()) return;
  if (wxLoginRequired) {
    addLog('请先完成企业微信扫码，并点击「我已扫码」', 'error');
    return;
  }

  workflowCompleted = chromeReady ? new Set(['chrome']) : new Set();
  updateStepper('crm');
  resetWxVerification();

  const { start, end } = getDateRange();
  resetProgress();
  setUIState('running');
  const mode = getExportMode();
  const modeLabel =
    mode === 'targetList'
      ? '目标名单'
      : mode === 'all'
        ? '全部外部好友'
        : '有效指标客户';
  addLog(
    `开始导出：${start}${start === end ? '' : ` ~ ${end}`}（${modeLabel}）`
  );
  await persistFormSettings();

  const result = await startExport({
    startDate: start,
    endDate: end,
    department: department.value,
    outputDir: outputDir.value,
    exportMode: mode,
    allCustomers: mode === 'all',
    targetsFile: mode === 'targetList' ? targetsFile.value : '',
    targetsSheet: targetsSheet.value.trim(),
    targetListStrategy: targetListStrategy.value
  });

  if (!result.success) {
    addLog(`启动失败: ${result.error}`, 'error');
    setUIState('idle');
    return;
  }
  addLog('导出任务已在后台运行', 'info');
});

pauseBtn.addEventListener('click', async () => {
  setUIState('pausing');
  addLog('正在暂停（等待当前步骤结束）…', 'info');
  const result = await pauseExport();
  if (!result.success) {
    setUIState('running');
    addLog(`暂停失败: ${result.error}`, 'error');
  }
});

resumeBtn.addEventListener('click', async () => {
  const wasPausing = exportUiState === 'pausing';
  suppressResumeLog = true;
  const result = await resumeExport();
  if (result.success) {
    setUIState('running');
    addLog(wasPausing ? '已取消暂停' : '已继续', 'info');
  } else {
    suppressResumeLog = false;
    addLog(`继续失败: ${result.error}`, 'error');
  }
});

stopBtn.addEventListener('click', async () => {
  setUIState('stopping');
  addLog('正在停止（等待当前步骤结束）…', 'info');
  const result = await stopExport();
  if (result.success) {
    setUIState('idle', { keepProgress: true, stopped: true });
    addLog('已停止', 'info');
  } else {
    setUIState('running');
    addLog(`停止失败: ${result.error}`, 'error');
  }
});

selectDirBtn.addEventListener('click', async () => {
  try {
    const result = await openDirectory();
    if (result?.error) {
      addLog(`选择目录失败: ${result.error}`, 'error');
      return;
    }
    if (result?.canceled || !result?.path) {
      addLog('已取消选择目录');
      return;
    }
    outputDir.value = result.path;
    await persistFormSettings();
    addLog(`已选择目录: ${result.path}`, 'success');
  } catch (err) {
    addLog(`选择目录失败: ${err.message}`, 'error');
  }
});

selectTargetsFileBtn.addEventListener('click', async () => {
  try {
    const result = await openTargetsFile();
    if (result?.error) {
      addLog(`选择目标名单失败: ${result.error}`, 'error');
      return;
    }
    if (result?.canceled || !result?.path) {
      addLog('已取消选择目标名单');
      return;
    }
    targetsFile.value = result.path;
    updateTargetFileChip();
    await persistFormSettings();
    addLog(`目标名单已读取：${basename(result.path)}`, 'success');
  } catch (err) {
    addLog(`选择目标名单失败: ${err.message}`, 'error');
  }
});

onExportProgress((data) => updateProgress(data));

if (onExportPaused) {
  onExportPaused(() => {
    setUIState('paused');
    addLog('已暂停', 'info');
  });
}

if (onExportResumed) {
  onExportResumed(() => {
    setUIState('running');
    if (!suppressResumeLog) {
      addLog('已继续', 'info');
    }
    suppressResumeLog = false;
  });
}

onExportComplete((data) => {
  const elapsed = data.elapsed != null ? `，耗时 ${data.elapsed}s` : '';
  const convTotal =
    data.total != null && data.total > 0 ? `，共 ${data.total} 条会话` : '';
  if (data.shutdown) {
    addLog(`导出已停止（进度已保存）${elapsed}${convTotal}`, 'info');
    setUIState('idle', { keepProgress: true, stopped: true });
  } else {
    addLog(`导出完成${elapsed}${convTotal}`, 'success');
    const unit =
      data.progressUnit === 'conversation' ? 'conversation' : progressUnit;
    const empTotal = data.employeeProgressTotal || lastExportProgress.total;
    const empCurrent = data.employeeProgressCurrent ?? empTotal;
    if (empTotal > 0) {
      applyEmployeeProgressBar(empCurrent, empTotal, {
        unit,
        phase: unit === 'conversation' ? 'retry-failed' : null,
        allowDecrease: true
      });
    } else {
      finishExportProgressBar();
    }
    setUIState('idle', { keepProgress: true, wxOk: wxChatVerified });
  }
  applyConversationStats(data.total, data.failed);
  if (data.failed > 0) {
    addLog(`仍有 ${data.failed} 条会话失败（已自动补跑最多 2 次）`, 'error');
  }
  addLog(`JSON: ${data.outputPath || ''}`, 'success');
  if (data.csvPath) {
    addLog(`CSV: ${data.csvPath}`, 'success');
  }
  if (data.outDir) {
    addLog(`按天导出目录: ${data.outDir}`, 'info');
  }
});

onExportError((error) => {
  const raw =
    typeof error === 'string'
      ? error
      : error?.message || JSON.stringify(error);
  const msg = raw.startsWith('错误:') ? raw : `错误: ${raw}`;
  if (/WXWORK_LOGIN_EXPIRED|企业微信登录会话已过期|企业微信内嵌登录/.test(raw)) {
    handleWxworkLoginRequired('企业微信内嵌登录已过期，请在 CRM 页面重新选中客户后扫码。');
  }
  addLog(msg, 'error');
  setUIState('idle', {
    keepProgress: true,
    keepStats: true,
    ...(wxLoginRequired
      ? { headerPhase: 'wx-error' }
      : chromeReady
        ? {}
        : { headerPhase: 'chrome-error' })
  });
  if (!wxLoginRequired && chromeReady) {
    syncCrmWxHeader(wxChatVerified ? 'wx-ok' : 'conditions');
    setIdleStatus('导出失败', '请查看「最近事件」中的错误说明');
  }
});

if (onChromeStatus) {
  onChromeStatus((data) => {
    if (data.ready) {
      chromeReady = true;
      workflowCompleted.add('chrome');
      syncCrmWxHeader('chrome-ready');
      setIdleStatus(
        data.message || 'Chrome 已就绪',
        '请仅在应用弹出的专用 Chrome 中登录；关闭后重开仍会保留登录状态，日常 Chrome 的登录无效'
      );
      updateStepper('conditions');
      addLog(data.message || 'Chrome 调试环境已就绪', 'success');
    } else if (data.message) {
      const connecting = /正在连接/.test(data.message);
      syncCrmWxHeader(connecting ? 'chrome-connecting' : 'chrome-error');
      addLog(data.message, inferLogType(data.message));
    }
  });
}

/** 将说明气泡固定在视口内，避免被窗口或父级裁切 */
function initFieldHintTooltips() {
  const VIEWPORT_PAD = 12;
  const GAP = 8;
  let active = null;

  function measureTooltip(tooltip) {
    tooltip.classList.add('is-measuring');
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    tooltip.classList.remove('is-measuring');
    return { width, height };
  }

  function placeTooltip(trigger, tooltip) {
    const { width, height } = measureTooltip(tooltip);
    const icon = trigger.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = icon.bottom + GAP;
    if (top + height > vh - VIEWPORT_PAD) {
      top = icon.top - GAP - height;
    }
    top = Math.max(VIEWPORT_PAD, Math.min(top, vh - VIEWPORT_PAD - height));

    let left = icon.left + icon.width / 2 - width / 2;
    left = Math.max(VIEWPORT_PAD, Math.min(left, vw - VIEWPORT_PAD - width));

    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  function closeHint() {
    if (!active) return;
    const { trigger, tooltip } = active;
    tooltip.classList.remove('is-open', 'is-measuring');
    tooltip.style.left = '';
    tooltip.style.top = '';
    if (tooltip._hintOwner === trigger) {
      trigger.appendChild(tooltip);
      delete tooltip._hintOwner;
    }
    active = null;
  }

  function openHint(trigger) {
    const tooltip = trigger.querySelector('.field-hint-tooltip');
    if (!tooltip) return;
    if (active && active.trigger !== trigger) {
      closeHint();
    }
    if (!tooltip._hintOwner) {
      tooltip._hintOwner = trigger;
      document.body.appendChild(tooltip);
    }
    active = { trigger, tooltip };
    tooltip.classList.add('is-open');
    placeTooltip(trigger, tooltip);
  }

  document.querySelectorAll('.field-hint-trigger').forEach((trigger) => {
    trigger.addEventListener('mouseenter', () => openHint(trigger));
    trigger.addEventListener('mouseleave', closeHint);
    trigger.addEventListener('focus', () => openHint(trigger));
    trigger.addEventListener('blur', closeHint);
  });

  window.addEventListener('resize', () => {
    if (active) placeTooltip(active.trigger, active.tooltip);
  });
  window.addEventListener(
    'scroll',
    () => {
      if (active) placeTooltip(active.trigger, active.tooltip);
    },
    true
  );
}

initFieldHintTooltips();

if (api.isDev) {
  const devBadge = document.getElementById('devBadge');
  if (devBadge) devBadge.classList.remove('is-hidden');
}

updateStepper('chrome');
updateStats();
setUIState('idle');
restoreFormSettings()
  .then(() => {
    addLog(`默认导出日期：${startDate.value}（昨天，本地时区）`, 'info');
    addLog('工具已就绪；请在专用 Chrome 窗口登录 CRM（非日常浏览器），关闭后重开仍保留登录态');
    addLog('导出已启用温和加速（paced 等待约为 Skill 默认一半）');
  })
  .catch((err) => {
    addLog(`加载设置失败: ${err.message}`, 'error');
  });
