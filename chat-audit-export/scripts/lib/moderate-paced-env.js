import { DOM_PACE_DEFAULTS } from './dom-pace-config.js';

/** 温和加速：与 Electron run-export-engine.js 一致；搜索/选中/滚动用 DOM 就绪等待 */
export const MODERATE_PACED_ENV = {
  CUSTOMER_DELAY_MIN_MS: '400',
  CUSTOMER_DELAY_MAX_MS: '800',
  BATCH_REST_MS: '2000',
  EMPLOYEE_DELAY_MIN_MS: '1000',
  EMPLOYEE_DELAY_MAX_MS: '2000',
  ...Object.fromEntries(
    Object.entries(DOM_PACE_DEFAULTS).map(([k, v]) => [k, String(v)])
  )
};
