/** DOM 驱动 pacing：轮询间隔与就绪超时（与 moderate-paced-env 一并注入 process.env） */
export const DOM_PACE_DEFAULTS = {
  DOM_POLL_INTERVAL_MS: 150,
  DOM_SEARCH_READY_TIMEOUT_MS: 4000,
  DOM_SELECT_READY_TIMEOUT_MS: 5000,
  DOM_MESSAGE_CHANGE_TIMEOUT_MS: 1200
};

export function numberEnv(name, defaultValue) {
  return Number(process.env[name] || String(defaultValue));
}

export function getDomPaceConfig() {
  return Object.fromEntries(
    Object.entries(DOM_PACE_DEFAULTS).map(([key, value]) => [key, numberEnv(key, value)])
  );
}
