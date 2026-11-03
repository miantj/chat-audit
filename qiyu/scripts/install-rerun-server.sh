#!/usr/bin/env bash
# 安装 / 卸载本地补跑 HTTP 服务（launchd KeepAlive，与 daily-update 定时任务独立）
#   ./scripts/install-rerun-server.sh          # 安装并启用
#   ./scripts/install-rerun-server.sh uninstall
# 默认监听 http://127.0.0.1:18765
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.qiyu.rerun-server"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
SCRIPT="$ROOT/scripts/rerun-server.mjs"
UID_NUM="$(id -u)"
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "$c" ]] && NODE_BIN="$c" && break
  done
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "找不到 node" >&2
  exit 1
fi

uninstall() {
  if launchctl print "gui/${UID_NUM}/${LABEL}" &>/dev/null; then
    launchctl bootout "gui/${UID_NUM}/${LABEL}" || true
  fi
  rm -f "$PLIST"
  echo "已卸载 ${LABEL}"
}

install() {
  mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"
  chmod +x "$ROOT/scripts/manual-rerun.sh" "$ROOT/scripts/install-rerun-server.sh"

  cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${SCRIPT}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${ROOT}/logs/rerun-server.out.log</string>
  <key>StandardErrorPath</key>
  <string>${ROOT}/logs/rerun-server.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/Users/mingmacmini/.npm-global/bin:/usr/bin:/bin</string>
    <key>QIYU_RERUN_PORT</key>
    <string>18765</string>
    <key>QIYU_RERUN_COOLDOWN_MS</key>
    <string>300000</string>
  </dict>
</dict>
</plist>
PLIST

  if launchctl print "gui/${UID_NUM}/${LABEL}" &>/dev/null; then
    launchctl bootout "gui/${UID_NUM}/${LABEL}" || true
  fi
  launchctl bootstrap "gui/${UID_NUM}" "$PLIST"
  launchctl enable "gui/${UID_NUM}/${LABEL}" || true

  echo "已安装 ${LABEL}"
  echo "  plist: $PLIST"
  echo "  监听: http://127.0.0.1:18765"
  echo "  触发: curl 'http://127.0.0.1:18765/qiyu/rerun?day=2026-11-02'"
  echo "  状态: curl 'http://127.0.0.1:18765/qiyu/status'"
  echo "  日志: $ROOT/logs/rerun-server.*.log"
  echo "  卸载: $0 uninstall"
}

case "${1:-install}" in
  install) uninstall >/dev/null 2>&1 || true; install ;;
  uninstall) uninstall ;;
  *)
    echo "用法: $0 [install|uninstall]" >&2
    exit 1
    ;;
esac
