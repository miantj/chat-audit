export class WxworkLoginRequiredError extends Error {
  constructor(message = '企业微信登录会话已过期，请在 CRM 内嵌企微二维码扫码登录后再重试') {
    super(message);
    this.name = 'WxworkLoginRequiredError';
  }
}

export class RateLimitedError extends Error {
  constructor(message = 'RATE_LIMITED: 页面提示请求过于频繁，已保存进度，请稍后从断点继续') {
    super(message);
    this.name = 'RateLimitedError';
  }
}

export function normalizeErrorMessage(error) {
  if (!error) {
    return '';
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return String(error);
}

export function isWxworkLoginRequiredError(error) {
  return error instanceof WxworkLoginRequiredError;
}

export function isRateLimitedError(error) {
  return error instanceof RateLimitedError || normalizeErrorMessage(error).includes('RATE_LIMITED');
}

export function shouldSkipConversationError(error) {
  // Page/iframe failures are page-state failures, not customer failures.
  // Stop the batch so the checkpoint can be resumed after the CRM recovers.
  if (isWxworkLoginRequiredError(error) || isRateLimitedError(error)) {
    return false;
  }
  const message = normalizeErrorMessage(error);
  return message.includes('friend-missing');
}

export function shouldRetryBatchError(error) {
  if (isWxworkLoginRequiredError(error) || isRateLimitedError(error)) {
    return false;
  }
  const message = normalizeErrorMessage(error);
  return (
    message.includes('batch exited with code') ||
    message.includes('message iframe target not found') ||
    message.includes('target not found')
  );
}
