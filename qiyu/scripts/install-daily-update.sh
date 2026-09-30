#!/usr/bin/env bash
# 安装 / 卸载 macOS launchd：每天 13:00 / 18:00 / 00:00 跑 scripts/daily-update.sh
#   ./scripts/install-daily-update.sh          # 安装并启用
#   ./scripts/install-daily-update.sh uninstall
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.qiyu.daily-update"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
SCRIPT="$ROOT/scripts/daily-update.sh"
UID_NUM="$(id -u)"

uninstall() {
  if launchctl print "gui/${UID_NUM}/${LABEL}" &>/dev/null; then
    launchctl bootout "gui/${UID_NUM}/${LABEL}" || true
  fi
  rm -f "$PLIST"
  echo "已卸载 ${LABEL}"
}

install() {
  mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"
  chmod +x "$SCRIPT"

  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${SCRIPT}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Hour</key>
      <integer>13</integer>
      <key>Minute</key>
      <integer>0</integer>
    </dict>
    <dict>
      <key>Hour</key>
      <integer>18</integer>
      <key>Minute</key>
      <integer>0</integer>
    </dict>
    <dict>
      <key>Hour</key>
      <integer>0</integer>
      <key>Minute</key>
      <integer>0</integer>
    </dict>
  </array>
  <key>StandardOutPath</key>
  <string>${ROOT}/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${ROOT}/logs/launchd.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/Users/mingmacmini/.npm-global/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

  if launchctl print "gui/${UID_NUM}/${LABEL}" &>/dev/null; then
    launchctl bootout "gui/${UID_NUM}/${LABEL}" || true
  fi
  launchctl bootstrap "gui/${UID_NUM}" "$PLIST"
  launchctl enable "gui/${UID_NUM}/${LABEL}" || true

  echo "已安装 ${LABEL}"
  echo "  plist:  $PLIST"
  echo "  脚本:   $SCRIPT"
  echo "  计划:   每天 13:00 / 18:00 / 00:00（本机时区）拉取当日数据"
  echo "          （00:00 对应 24 点档，取刚结束的那天）"
  echo "  日志:   $ROOT/logs/"
  echo "  试跑:   $SCRIPT"
  echo "  卸载:   $0 uninstall"
}

case "${1:-install}" in
  install) uninstall >/dev/null 2>&1 || true; install ;;
  uninstall) uninstall ;;
  *)
    echo "用法: $0 [install|uninstall]" >&2
    exit 1
    ;;
esac
