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
  onExportComplete,
  onExportError,
  onChromeStatus
} = api;

const startDate = document.getElementById('startDate');
const endDate = document.getElementById('endDate');
const singleDayMode = document.getElementById('singleDayMode');
const dateSummary = document.getElementById('dateSummary');
const department = document.getElementById('department');
const outputDir = document.getElementById('outputDir');
const selectDirBtn = document.getElementById('selectDir');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resumeBtn = document.getElementById('resumeBtn');
const stopBtn = document.getElementById('stopBtn');

const statusBar = document.getElementById('statusBar');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const logContent = document.getElementById('logContent');

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
  updateDateSummary();
}

function updateDateSummary() {
  const { start, end } = getDateRange();
  if (!start) {
    dateSummary.textContent = '请选择导出日期';
    dateSummary.classList.add('date-summary-warn');
    return;
  }
  dateSummary.classList.remove('date-summary-warn');
  if (start === end) {
    dateSummary.textContent = `将导出 ${start} 当天的聊天记录（CRM 主表按该日筛选）`;
  } else {
    dateSummary.textContent = `将导出 ${start} 至 ${end} 的聊天记录（主表按开始日 ${start} 筛选）`;
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

function setUIState(state) {
  const running = state === 'running' || state === 'paused';
  startBtn.disabled = running;
  pauseBtn.disabled = state !== 'running';
  resumeBtn.disabled = state !== 'paused';
  stopBtn.disabled = !running;

  if (state === 'idle') {
    statusBar.className = 'status-bar';
    statusBar.textContent = '就绪';
  } else if (state === 'running') {
    statusBar.className = 'status-bar';
    statusBar.textContent = '导出中…';
  } else if (state === 'paused') {
    statusBar.className = 'status-bar';
    statusBar.textContent = '已暂停';
  }
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
  if (data.message) addLog(data.message, 'info');
  const current = data.current ?? data.completed ?? 0;
  const total = data.total ?? 0;
  if (total > 0) {
    const percent = Math.min(100, Math.round((current / total) * 100));
    progressFill.style.width = `${percent}%`;
    progressText.textContent = `${percent}%`;
  } else if (data.message) {
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
  updateDateSummary();
  persistFormSettings();
});

endDate.addEventListener('change', () => {
  updateDateSummary();
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
  const result = await pauseExport();
  if (result.success) {
    setUIState('paused');
    addLog('已暂停');
  } else {
    addLog(`暂停失败: ${result.error}`, 'error');
  }
});

resumeBtn.addEventListener('click', async () => {
  const result = await resumeExport();
  if (result.success) {
    setUIState('running');
    addLog('已继续');
  } else {
    addLog(`继续失败: ${result.error}`, 'error');
  }
});

stopBtn.addEventListener('click', async () => {
  const result = await stopExport();
  if (result.success) {
    setUIState('idle');
    addLog('已停止');
    progressFill.style.width = '0%';
    progressText.textContent = '0%';
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

onExportComplete((data) => {
  setUIState('idle');
  const elapsed = data.elapsed != null ? `，耗时 ${data.elapsed}s` : '';
  const total =
    data.total != null && data.total > 0 ? `，共 ${data.total} 条会话` : '';
  if (data.shutdown) {
    addLog(`导出已停止（进度已保存）${elapsed}${total}`, 'info');
  } else {
    addLog(`导出完成${elapsed}${total}`, 'success');
  }
  if (data.failed > 0) {
    addLog(`仍有 ${data.failed} 条会话失败（已自动补跑最多 3 次）`, 'info');
  }
  addLog(`JSON: ${data.outputPath || ''}`, 'success');
  if (data.csvPath) {
    addLog(`CSV: ${data.csvPath}`, 'success');
  }
  progressFill.style.width = '100%';
  progressText.textContent = '100%';
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
      statusBar.textContent = 'Chrome 已就绪';
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
