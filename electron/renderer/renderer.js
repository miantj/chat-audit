const api = window.electronAPI;
if (!api) {
  document.body.innerHTML =
    '<p style="padding:24px;color:#ff4d4f">预加载失败，请完全退出后重新运行 pnpm start</p>';
  throw new Error('electronAPI not available');
}

const {
  startExport,
  pauseExport,
  resumeExport,
  stopExport,
  openDirectory,
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
const department = document.getElementById('department');
const outputDir = document.getElementById('outputDir');
const selectDirBtn = document.getElementById('selectDir');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resumeBtn = document.getElementById('resumeBtn');
const stopBtn = document.getElementById('stopBtn');

const statusBar = document.getElementById('statusBar');
const statusProgress = document.getElementById('statusProgress');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const progressPercentLabel = document.getElementById('progressPercentLabel');
const progressText = document.getElementById('progressText');
const logContent = document.getElementById('logContent');

let exportUiState = 'idle';
/** 最近一次带 current/total 的进度，避免普通日志把进度条打回「进行中」 */
let lastExportProgress = { current: 0, total: 0 };
let lastPercentShown = 0;
/** employees | conversation（补跑 failed_conversation_ids） */
let progressUnit = 'employee';
/** 用户点继续后跳过脚本侧 export-resumed 的重复日志 */
let suppressResumeLog = false;

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
  persistFormSettings();
}

function statusStateText() {
  if (exportUiState === 'pausing') return '暂停中…';
  if (exportUiState === 'paused') return '已暂停';
  if (exportUiState === 'running') return '导出中…';
  return '就绪';
}

function refreshStatusLabel() {
  const text = statusStateText();
  if (statusBar) {
    statusBar.textContent = text;
  }
  if (progressBar) {
    progressBar.setAttribute('aria-label', text);
  }
}

function employeeProgressPercent(current, total) {
  if (total <= 0) return 0;
  if (current >= total) return 100;
  return Math.round((current / total) * 100);
}

function formatProgressCaption(current, total, unit = progressUnit, options = {}) {
  if (total <= 0) {
    return unit === 'conversation' ? '续传 —' : '员工 —';
  }
  if (unit === 'conversation') {
    return `续传 ${current}/${total}`;
  }
  if (options.resume) {
    return `续传 ${current}/${total}`;
  }
  return `员工 ${current}/${total}`;
}

function setProgressPercentOnBar(percent) {
  if (progressPercentLabel) {
    progressPercentLabel.textContent = `${percent}%`;
  }
  if (progressBar) {
    progressBar.classList.toggle('progress-bar--fill-high', percent >= 50);
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
  progressFill.classList.remove('is-indeterminate');
  progressFill.style.width = `${lastPercentShown}%`;
  setProgressPercentOnBar(lastPercentShown);
  const resume = Boolean(options.resume);
  progressText.textContent = formatProgressCaption(current, total, unit, { resume });
  if (progressBar) {
    progressBar.setAttribute('aria-valuenow', String(lastPercentShown));
  }
  lastExportProgress = { current: Math.min(current, total), total };
  progressUnit = unit;
}

/** 导出成功结束时展示 100%（须在 setUIState('idle') 之前调用） */
function finishExportProgressBar() {
  const { total } = lastExportProgress;
  if (total > 0) {
    applyEmployeeProgressBar(total, total);
    return;
  }
  lastPercentShown = 100;
  progressFill.classList.remove('is-indeterminate');
  progressFill.style.width = '100%';
  setProgressPercentOnBar(100);
  progressText.textContent = '完成';
  if (progressBar) {
    progressBar.setAttribute('aria-valuenow', '100');
  }
}

function resetProgress() {
  lastExportProgress = { current: 0, total: 0 };
  lastPercentShown = 0;
  progressUnit = 'employee';
  progressFill.style.width = '0%';
  progressFill.classList.remove('is-indeterminate');
  setProgressPercentOnBar(0);
  if (progressBar) {
    progressBar.classList.remove('progress-bar--fill-high');
  }
  progressText.textContent = '员工 —';
  if (progressBar) {
    progressBar.setAttribute('aria-valuenow', '0');
  }
}

function setProgressVisible(visible) {
  if (statusProgress) {
    statusProgress.classList.toggle('is-hidden', !visible);
  }
}

function setUIState(state, options = {}) {
  exportUiState = state;
  const running =
    state === 'running' || state === 'paused' || state === 'pausing';
  startBtn.disabled = running;
  pauseBtn.disabled = state !== 'running';
  resumeBtn.disabled = state !== 'paused' && state !== 'pausing';
  stopBtn.disabled = !running;
  setProgressVisible(running || Boolean(options.showProgress));

  if (state === 'idle' && !options.keepProgress) {
    resetProgress();
  }
  refreshStatusLabel();
}

async function persistFormSettings() {
  const { start, end } = getDateRange();
  const payload = {
    startDate: start,
    endDate: end,
    exportDate: start,
    singleDayMode: singleDayMode.checked,
    useDateRange: !singleDayMode.checked,
    outputDir: outputDir.value,
    department: department.value
  };
  await saveSettings(payload);
}

async function restoreFormSettings() {
  const saved = await getSettings();
  const fallback = defaultExportDate();
  const start =
    saved.startDate || saved.exportDate || fallback;
  startDate.value = start;
  endDate.value = saved.endDate || start;

  const single =
    saved.singleDayMode != null
      ? saved.singleDayMode
      : saved.useDateRange == null
        ? true
        : !saved.useDateRange;
  singleDayMode.checked = single;

  if (saved.outputDir) outputDir.value = saved.outputDir;
  if (saved.department) department.value = saved.department;

  applySingleDayMode();

  if (saved.outputDir) {
    addLog(`已恢复输出目录: ${saved.outputDir}`, 'info');
  }
}

function addLog(message, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logContent.insertBefore(entry, logContent.firstChild);
  const scroller = logContent.parentElement;
  if (scroller) scroller.scrollTop = 0;
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
    if (msg.includes('[progress-debug]')) {
      addLog(msg, 'info');
    } else {
      const isProgressTicker =
        /^员工 \d+\/\d+/.test(msg) || /^续传 \d+\/\d+/.test(msg);
      if (!isProgressTicker) {
        addLog(msg, 'info');
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
  if (data.unit === 'conversation' || data.unit === 'employee') {
    progressUnit = data.unit;
  }
  if (retryPhase) {
    progressUnit = 'conversation';
  }

  if (retryPhase && Boolean(data.reset)) {
    progressUnit = 'conversation';
    lastPercentShown = 0;
    progressFill.classList.remove('is-indeterminate');
    progressFill.style.width = '0%';
    setProgressPercentOnBar(0);
    if (total > 0) {
      applyEmployeeProgressBar(current, total, {
        reset: true,
        allowDecrease: true,
        unit: 'conversation',
        phase: 'retry-failed'
      });
    } else {
      progressText.textContent = '续传 —';
      if (progressBar) {
        progressBar.setAttribute('aria-valuenow', '0');
      }
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
    // 无总量时显示活动状态
    progressFill.classList.add('is-indeterminate');
    progressFill.style.width = '35%';
    if (progressPercentLabel) {
      progressPercentLabel.textContent = '…';
    }
    progressText.textContent = '…';
  }
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

startDate.addEventListener('change', () => {
  endDate.min = startDate.value;
  if (singleDayMode.checked) {
    endDate.value = startDate.value;
  } else if (endDate.value < startDate.value) {
    endDate.value = startDate.value;
  }
  persistFormSettings();
});

endDate.addEventListener('change', () => {
  persistFormSettings();
});

startBtn.addEventListener('click', async () => {
  if (!outputDir.value) {
    addLog('请先选择输出目录', 'error');
    return;
  }

  const { start, end } = getDateRange();
  if (!start || !end) {
    addLog('请选择导出日期', 'error');
    return;
  }
  if (end < start) {
    addLog('结束日期不能早于开始日期', 'error');
    return;
  }

  resetProgress();
  setUIState('running');
  addLog(`开始导出：${start}${start === end ? '' : ` ~ ${end}`}`);
  await persistFormSettings();

  const result = await startExport({
    startDate: start,
    endDate: end,
    department: department.value,
    outputDir: outputDir.value
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
  const result = await stopExport();
  if (result.success) {
    setUIState('idle', { keepProgress: true, showProgress: true });
    addLog('已停止');
  } else {
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
    setUIState('idle', { keepProgress: true, showProgress: true });
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
    setUIState('idle', { keepProgress: true, showProgress: true });
  }
  if (data.failed > 0) {
    addLog(`仍有 ${data.failed} 条会话失败（已自动补跑最多 2 次）`, 'info');
  }
  addLog(`JSON: ${data.outputPath || ''}`, 'success');
  if (data.csvPath) {
    addLog(`CSV: ${data.csvPath}`, 'success');
  }
});

onExportError((error) => {
  const msg =
    typeof error === 'string'
      ? error
      : error?.message || JSON.stringify(error);
  addLog(`错误: ${msg}`, 'error');
  setUIState('idle');
});

if (onChromeStatus) {
  onChromeStatus((data) => {
    if (data.ready) {
      if (exportUiState === 'idle' && statusBar) {
        statusBar.textContent = data.message || 'Chrome 已就绪';
      }
      addLog(data.message || 'Chrome 调试环境已就绪', 'success');
    } else if (data.message) {
      addLog(data.message, 'info');
    }
  });
}

setUIState('idle');
restoreFormSettings()
  .then(() => {
    if (!startDate.value) {
      const d = defaultExportDate();
      startDate.value = d;
      endDate.value = d;
      applySingleDayMode();
    }
    addLog(`默认导出日期：${startDate.value}（本地时区）`, 'info');
    addLog('工具已就绪；请在专用 Chrome 窗口登录 CRM（非日常浏览器），关闭后重开仍保留登录态');
    addLog('导出已启用温和加速（paced 等待约为 Skill 默认一半）');
  })
  .catch((err) => {
    addLog(`加载设置失败: ${err.message}`, 'error');
  });
