#!/usr/bin/env bash
# Brella — 一键安装脚本
# 用法: curl -fsSL https://raw.githubusercontent.com/NIRUNM00/brella/main/scripts/install.sh | bash
# 或:  git clone && cd brella && bash scripts/install.sh

set -euo pipefail
IFS=$'\n\t'

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

# ─── 路径 ────────────────────────────────────────────
REPO="${BRELLA_REPO:-git@github.com:NIRUNM00/brella.git}"
INSTALL_DIR="${BRELLA_DIR:-$HOME/.brella}"
COMPFYI_NODES="${COMFYUI_NODES:-}"

info()  { printf "${CYAN}→${NC} %s\n" "$1"; }
ok()    { printf "${GREEN}✅${NC} %s\n" "$1"; }
err()   { printf "${RED}❌${NC} %s\n" "$1"; exit 1; }
dim()   { printf "${DIM}  %s${NC}\n" "$1"; }

# ─── Node.js 检查 ────────────────────────────────────
check_node() {
  if ! command -v node &>/dev/null; then
    err "需要 Node.js >= 18。安装: https://nodejs.org 或使用 nvm"
  fi
  local ver
  ver=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$ver" -lt 18 ]; then
    err "Node.js $(node -v) 版本过低，需要 >= 18"
  fi
  ok "Node.js $(node -v)"
}

# ─── 安装 ────────────────────────────────────────────
do_install() {
  info "安装位置: $INSTALL_DIR"

  # Clone 或拉取最新
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "更新已有仓库…"
    cd "$INSTALL_DIR" && git pull --ff-only
  else
    info "克隆仓库…"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone "$REPO" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi

  # 安装依赖
  info "安装依赖…"
  npm install --omit=dev 2>/dev/null || npm install
  ok "依赖安装完成"

  # 编译
  info "编译 TypeScript…"
  npm run build
  ok "编译完成"

  # npm link 注册 CLI
  info "注册 brella 命令…"
  npm link
  ok "CLI 已注册，运行 brella -h 验证"

  # 初始化数据库
  info "初始化数据库…"
  cd "$INSTALL_DIR"
  npx tsx src/cli.ts init 2>/dev/null && ok "数据库已初始化" || dim "跳过数据库初始化（可手动运行 brella init）"

  # ─── ComfyUI 节点（可选） ──────────────────────────
  if [ -n "$COMPFYI_NODES" ]; then
    if [ -d "$COMPFYI_NODES" ]; then
      info "安装 ComfyUI 自定义节点…"
      cp -r "$INSTALL_DIR/custom_nodes/brella" "$COMPFYI_NODES/brella"
      ok "ComfyUI 节点已安装 → $COMPFYI_NODES/brella"
    else
      dim "ComfyUI 目录不存在: $COMPFYI_NODES，跳过节点安装"
      dim "手动安装: cp -r custom_nodes/brella /path/to/ComfyUI/custom_nodes/"
    fi
  fi

  # ─── 完成 ──────────────────────────────────────────
  echo ""
  ok "Brella v$(node -e "console.log(require('$INSTALL_DIR/package.json').version)") 安装完成！"
  echo ""
  echo "  快速开始:"
  echo "    brella init              # 初始化数据库"
  echo "    brella curate ./output   # 策展一批图片"
  echo "    brella -h                # 查看所有命令"
  echo ""
  echo "  ComfyUI 节点安装（如未安装）："
  echo "    cp -r $INSTALL_DIR/custom_nodes/brella \\"
  echo "      /path/to/ComfyUI/custom_nodes/"
  echo ""
}

# ─── 主流程 ──────────────────────────────────────────
main() {
  echo ""
  echo "  ${CYAN}☂️  Brella — 安装脚本${NC}"
  echo ""

  check_node
  do_install
}

main "$@"
