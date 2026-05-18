export async function openDialogWithRetry({
  openDialog,
  waitForDialog,
  sleep,
  maxAttempts = 3,
  intervalMs = 800
}) {
  let lastDialogState = { exists: false, friendCount: 0 };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const opened = await openDialog();
    if (!opened.ok) {
      if (attempt < maxAttempts) {
        await sleep(intervalMs);
      }
      continue;
    }

    lastDialogState = await waitForDialog();
    if (lastDialogState.exists) {
      return lastDialogState;
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  return lastDialogState;
}
