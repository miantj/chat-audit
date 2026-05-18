#!/usr/bin/env python3
"""诊断 CRM 页面状态"""
import sys
sys.path.insert(0, '.')

from app.cdp_controller import CDPController
from app.crm_login import CrmLogin

def diagnose():
    cdp = CDPController()
    login = CrmLogin(cdp)

    if not cdp.check_chrome():
        print('Chrome 未连接')
        return

    print('检查 CRM 页面状态...')
    status = login.check_login_status()
    print(f'登录状态: {status}')

    # 直接运行 check-page 看原始输出
    print('\n原始输出:')
    result = login._run_node_script("check-page")
    print(f'stdout: {result.stdout}')
    print(f'stderr: {result.stderr}')
    print(f'returncode: {result.returncode}')

if __name__ == '__main__':
    diagnose()