import { WxworkLoginRequiredError, RateLimitedError } from '../lib/export-errors.js';

export class SelfHealCoordinator {
  constructor(tabManager, sharedState) {
    this.tabManager = tabManager;
    this.sharedState = sharedState;
    this.retryCount = new Map();
    this.maxRetries = 3;
  }

  async handleError(tabIndex, error, orchestrator) {
    const errorType = this._classifyError(error);

    if (error instanceof WxworkLoginRequiredError) {
      this.sharedState.setActiveLoginTab(tabIndex);
      orchestrator.pauseAllForQR();
      return 'WAIT_FOR_QR';
    }

    if (error instanceof RateLimitedError) {
      orchestrator.stopAll('RATE_LIMITED');
      return 'STOPPED';
    }

    const currentRetry = this.retryCount.get(tabIndex) || 0;
    if (currentRetry >= this.maxRetries) {
      this.tabManager.markTabDead(tabIndex);
      this.retryCount.delete(tabIndex);
      return 'TAB_DEAD';
    }

    this.retryCount.set(tabIndex, currentRetry + 1);

    // Bug6 Fix: regardless of selfHeal success, return RETRY if retries remain
    await this._selfHeal(tabIndex, errorType);
    return 'RETRY';
  }

  _classifyError(error) {
    const msg = error.message || '';
    if (msg.includes('CDP_NO_TARGET') || msg.includes('target not found')) return 'CDP_NO_TARGET';
    if (msg.includes('CASCADER_STUCK')) return 'CASCADER_STUCK_OPEN';
    if (msg.includes('page crash') || msg.includes('EXPORT_PAGE_CRASH')) return 'EXPORT_PAGE_CRASH';
    if (msg.includes('DATE_PICKER_STUCK')) return 'DATE_PICKER_STUCK';
    return 'UNKNOWN';
  }

  async _selfHeal(tabIndex, errorType) {
    const tab = this.tabManager.getTab(tabIndex);
    if (!tab) return;

    try {
      switch (errorType) {
        case 'CDP_NO_TARGET':
          await tab.send('Page.navigate', { url: 'https://tmscrm.yishouapp.com/#/salesQuality/chatAudit' });
          break;
        case 'CASCADER_STUCK_OPEN':
          await tab.send('Runtime.evaluate', {
            expression: `document.querySelector('.el-cascader__dropdown')?.remove()`
          });
          break;
        case 'EXPORT_PAGE_CRASH':
          await tab.send('Page.navigate', { url: 'https://tmscrm.yishouapp.com/#/salesQuality/chatAudit' });
          break;
      }
    } catch {
      // Swallow self-heal exceptions - let handleError decide retry
    }
  }

  resetRetries(tabIndex) {
    this.retryCount.delete(tabIndex);
  }
}