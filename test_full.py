#!/usr/bin/env python3
"""测试完整导出流程"""
import sys
sys.path.insert(0, '.')

from app.cdp_controller import CDPController
from app.crm_login import CrmLogin
import time

def test_full_flow():
    cdp = CDPController()
    login = CrmLogin(cdp)

    if not cdp.check_chrome():
        print('Chrome 未连接')
        return

    print('=== 步骤 1: 检查页面状态 ===')
    status = login.check_login_status()
    print(f'登录状态: {status}')

    if status == "unknown":
        print('\n=== 步骤 1.1: 自动导航 ===')
        success = login.navigate_audit()
        if success:
            print('导航命令已发送，等待页面加载...')
            time.sleep(4)
            status = login.check_login_status()
            print(f'导航后状态: {status}')
        else:
            print('✗ 导航失败')
            return

    if status != 'ready':
        print(f'✗ 当前状态不是 ready: {status}')
        return

    print('\n=== 步骤 2: Gate 检查 ===')
    dept = '大客私域顾问-总'
    date = '2026-05-15'

    if login.gate_check(dept, date):
        print('✓ Gate 检查通过')
    else:
        print('✗ Gate 检查失败，尝试自动修复...')

        print('\n=== 步骤 2.1: 自动修复 ===')
        for attempt in range(3):
            print(f'\n尝试 {attempt + 1}/3:')

            print('  设置部门...')
            login.set_department(dept)
            time.sleep(1)

            print('  设置日期...')
            login.set_dates(date)
            time.sleep(3)

            if login.gate_check(dept, date):
                print('  ✓ Gate 检查通过')
                break
            else:
                print('  ✗ 失败，重试...')
                if attempt < 2:
                    time.sleep(2)
        else:
            print('\n✗ 自动修复失败')
            return

    print('\n=== 步骤 3: Gate Start Export ===')
    if login.gate_start_export(dept, date):
        print('✓ Start Gate 通过，准备导出！')
    else:
        print('✗ Start Gate 失败')

if __name__ == '__main__':
    test_full_flow()