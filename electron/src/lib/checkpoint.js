import fs from 'node:fs/promises';
import path from 'node:path';

export function getDefaultCheckpointPath(outputPath) {
  const resolved = path.resolve(outputPath);
  const dir = path.dirname(resolved);
  const ext = path.extname(resolved);
  const base = path.basename(resolved, ext);
  return path.join(dir, `${base}.checkpoint.json`);
}

export function createEmptyCheckpoint() {
  return {
    main_page_no: 1,
    employee_name: null,
    metric_category: null,
    metric_page: 1,
    customer_id: null,
    friend_page: 1,
    friend_index: -1,
    conversation_id: null,
    updated_at: null
  };
}

export async function loadCheckpoint(checkpointPath) {
  try {
    const text = await fs.readFile(checkpointPath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return createEmptyCheckpoint();
    }
    throw error;
  }
}

export async function saveCheckpoint(checkpointPath, checkpoint) {
  const next = {
    ...createEmptyCheckpoint(),
    ...checkpoint,
    updated_at: new Date().toISOString()
  };
  await fs.writeFile(checkpointPath, JSON.stringify(next, null, 2), 'utf8');
}

export function shouldSkipMainPageBeforeCheckpoint(checkpoint, mainPageNo) {
  if (!checkpoint?.employee_name) {
    return false;
  }
  return mainPageNo < (checkpoint.main_page_no || 1);
}

export function shouldSkipRowBeforeCheckpoint(checkpoint, employeeName, checkpointReached) {
  if (checkpointReached || !checkpoint.employee_name) {
    return false;
  }
  return employeeName !== checkpoint.employee_name;
}

export function shouldSkipConversationBeforeCheckpoint(
  checkpoint,
  employeeName,
  friendPage,
  friendIndex,
  checkpointReached
) {
  if (checkpointReached || !checkpoint.employee_name) {
    return false;
  }

  if (employeeName !== checkpoint.employee_name) {
    return true;
  }

  if (friendPage < checkpoint.friend_page) {
    return true;
  }

  if (friendPage === checkpoint.friend_page && friendIndex <= checkpoint.friend_index) {
    return true;
  }

  return false;
}

export function isMetricCheckpoint(checkpoint) {
  return Boolean(
    checkpoint &&
      checkpoint.employee_name &&
      (checkpoint.metric_category || checkpoint.customer_id)
  );
}

export function shouldSkipMetricCustomerBeforeCheckpoint(
  checkpoint,
  employeeName,
  metricCategory,
  metricPage,
  customerId,
  checkpointReached,
  metricCategoryOrder = []
) {
  if (checkpointReached || !checkpoint?.employee_name) {
    return false;
  }

  if (employeeName !== checkpoint.employee_name) {
    return true;
  }

  const currentCategoryIndex = metricCategoryOrder.indexOf(metricCategory);
  const checkpointCategoryIndex = metricCategoryOrder.indexOf(checkpoint.metric_category);

  if (currentCategoryIndex >= 0 && checkpointCategoryIndex >= 0) {
    if (currentCategoryIndex < checkpointCategoryIndex) {
      return true;
    }
    if (currentCategoryIndex > checkpointCategoryIndex) {
      return false;
    }
  } else if (metricCategory !== checkpoint.metric_category) {
    return true;
  }

  if (metricPage < (checkpoint.metric_page || 1)) {
    return true;
  }

  if (metricPage > (checkpoint.metric_page || 1)) {
    return false;
  }

  if (!checkpoint.customer_id) {
    return false;
  }

  return customerId !== checkpoint.customer_id;
}