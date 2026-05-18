#!/usr/bin/env python3
"""测试导出功能"""
import sys
sys.path.insert(0, '.')

from app.cdp_controller import CDPController
from app.crm_login import CrmLogin

def test_export():
    cdp = CDPController()
    login = CrmLogin(cdp)

    # 检查 Chrome 连接
    print('检查 Chrome CDP...')
    if cdp.check_chrome():
        print('✓ Chrome CDP 已连接')
    else:
        print('✗ Chrome CDP 未连接')
        return False

    # 检查 CRM 登录状态
    print('\n检查 CRM 登录状态...')
    status = login.check_login_status()
    print(f'状态: {status}')

    if status == 'ready':
        print('✓ CRM 已在聊天审计页')
    elif status == 'login_required':
        print('✗ 需要登录')
        return False
    else:
        print(f'? 未知状态: {status}')

    # Gate 检查
    dept = '大客私域顾问-总'
    date = '2026-05-15'

    print(f'\n执行 Gate 检查: 部门={dept}, 日期={date}...')
    if login.gate_check(dept, date):
        print('✓ Gate 检查通过')
        return True
    else:
        print('✗ Gate 检查失败，尝试自动修复...')

        # 自动修复
        for attempt in range(3):
            print(f'\n自动修复尝试 {attempt + 1}/3...')

            print('  设置部门...')
            login.set_department(dept)
            import time
            time.sleep(1)

            print('  设置日期...')
            login.set_dates(date)
            time.sleep(3)

            if login.gate_check(dept, date):
                print('✓ Gate 检查通过')
                return True
            else:
                print(f'  ✗ 失败，重试...')
                if attempt < 2:
                    time.sleep(2)

        print('✗ 自动修复失败')
        return False

if __name__ == '__main__':
    success = test_export()
    sys.exit(0 if success else 1)