#!/usr/bin/env bash
# 用 mitmproxy 抓 Trae SOLO 流量的启动脚本
#
# 用法：
#   1. 先启动 mitmweb（见下方命令）
#   2. 把 TRAE_EXE 改成你机器上 Trae SOLO 的实际 exe 路径
#   3. bash scripts/capture-trae.sh
#
# 启动 mitmweb 的命令（另开一个窗口）：
#   mitmweb --listen-host 127.0.0.1 --listen-port 8888 \
#     --set view_filter='~d trae-api-cn.mchost.guru | ~u api/agent/v3 | ~u api/ide/v1'
#
# 抓完想恢复正常使用 Trae：关掉本脚本启动的 Trae，直接用正常方式启动即可
# （本脚本只在 Trae 子进程里设了代理环境变量，不影响系统全局）

set -e

# ============ 改这里：你的 Trae SOLO exe 路径 ============
TRAE_EXE="/d/software/TRAE SOLO CN/TRAE SOLO CN.exe"
# =========================================================

PROXY="http://127.0.0.1:8888"

# 代理变量：Electron/Node/Chromium 都认这些
export HTTP_PROXY="$PROXY"
export HTTPS_PROXY="$PROXY"
# Electron 渲染进程也走这些（带 ALL_PROXY 兜底）
export http_proxy="$PROXY"
export https_proxy="$PROXY"
export ALL_PROXY="$PROXY"

# 关键：让 Trae 内部的 Node fetch 信任 mitmproxy 证书（绕过 TLS 校验）
# 仅对此 Trae 子进程生效，安全
export NODE_TLS_REJECT_UNAUTHORIZED=0

# 让 Chromium 渲染进程也走代理（Electron 命令行参数）
# 部分 Electron 版本需要显式指定
export ELECTRON_EXTRA_LAUNCH_ARGS="--proxy-server=$PROXY --ignore-certificate-errors"

if [ ! -f "$TRAE_EXE" ]; then
  echo "❌ 找不到 Trae exe：$TRAE_EXE"
  echo "   请改本脚本顶部的 TRAE_EXE 变量。"
  echo "   查找方法：右键 Trae 桌面/开始菜单快捷方式 → 属性 → 目标"
  exit 1
fi

echo "✅ 启动 Trae（走 mitmproxy $PROXY，证书校验已绕过）"
echo "   exe: $TRAE_EXE"
echo "   抓包界面: http://127.0.0.1:8081"
echo "   按 Ctrl+C 退出（Trae 会被一起关掉）"
echo ""

exec "$TRAE_EXE" $ELECTRON_EXTRA_LAUNCH_ARGS
