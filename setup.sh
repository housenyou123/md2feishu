#!/bin/bash
# md2feishu — One-click setup script
# Usage: bash setup.sh
set -e

SKILL_DIR="$HOME/.claude/skills/md2feishu"
MCP_JSON="$HOME/.claude/mcp.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=========================================="
echo "  md2feishu — Markdown 转飞书文档 安装程序"
echo "=========================================="
echo ""

# ─── Step 1: Check Node.js ───────────────────────────────────────
echo "[1/5] 检查 Node.js..."
if ! command -v node &>/dev/null; then
  echo "❌ 未安装 Node.js"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "   正在通过 Homebrew 安装..."
    if command -v brew &>/dev/null; then
      brew install node
    else
      echo "   未找到 Homebrew，请手动安装 Node.js: https://nodejs.org"
      exit 1
    fi
  else
    echo "   请安装 Node.js 18+: https://nodejs.org"
    exit 1
  fi
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "❌ Node.js 版本过低: $(node -v)，需要 v18+"
  echo "   请升级: https://nodejs.org"
  exit 1
fi
echo "✅ Node.js $(node -v)"

# ─── Step 2: Check Claude Code ───────────────────────────────────
echo ""
echo "[2/5] 检查 Claude Code..."
if [ ! -d "$HOME/.claude" ]; then
  echo "❌ 未找到 ~/.claude 目录，请先安装 Claude Code"
  echo "   https://claude.ai/download"
  exit 1
fi
echo "✅ Claude Code 已安装"

# ─── Step 3: Configure Feishu credentials ────────────────────────
echo ""
echo "[3/5] 配置飞书应用凭据..."
echo ""

# Helper: validate credentials via API
validate_creds() {
  local id="$1" secret="$2"
  node -e "
    fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({app_id: process.argv[1], app_secret: process.argv[2]})
    }).then(r=>r.json()).then(d=>{
      if(d.code===0) console.log('OK');
      else console.log('FAIL:'+d.msg);
    }).catch(e=>console.log('FAIL:'+e.message));
  " "$id" "$secret" 2>/dev/null
}

# Helper: prompt user to input new credentials
input_credentials() {
  echo "请先在飞书开发者后台创建你自己的企业自建应用:"
  echo "  https://open.feishu.cn/app"
  echo ""
  echo "需要开通的权限（在应用的「权限管理」中搜索添加）:"
  echo "  - docx:document          创建和编辑文档"
  echo "  - docx:document:readonly 读取文档"
  echo "  - drive:drive            访问云空间"
  echo "  - drive:drive:readonly   读取云空间"
  echo "  - drive:permission.member:create 管理文档权限"
  echo ""
  echo "添加权限后，需要在「版本管理与发布」中创建版本并发布（管理员审批）"
  echo ""

  read -p "请输入你的 App ID (格式 cli_xxx): " APP_ID
  if [[ ! "$APP_ID" =~ ^cli_ ]]; then
    echo "❌ App ID 格式不正确，应以 cli_ 开头"
    exit 1
  fi

  read -p "请输入你的 App Secret: " APP_SECRET
  if [ -z "$APP_SECRET" ]; then
    echo "❌ App Secret 不能为空"
    exit 1
  fi

  echo ""
  echo "验证凭据..."
  VALIDATE=$(validate_creds "$APP_ID" "$APP_SECRET")
  if [ "$VALIDATE" != "OK" ]; then
    echo "❌ 凭据验证失败: $VALIDATE"
    echo "   请检查 App ID 和 App Secret 是否正确"
    exit 1
  fi
  echo "✅ 凭据验证通过"

  write_credentials "$APP_ID" "$APP_SECRET"
}

# Helper: write credentials to mcp.json
write_credentials() {
  local id="$1" secret="$2"
  node -e "
    const fs = require('fs');
    const p = process.argv[1];
    let config = {};
    try { config = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers['lark-mcp'] = {
      command: 'echo',
      args: ['-a', process.argv[2], '-s', process.argv[3]]
    };
    fs.writeFileSync(p, JSON.stringify(config, null, 2));
  " "$MCP_JSON" "$id" "$secret"
  echo "✅ 凭据已写入 $MCP_JSON"
}

# Check if already configured
EXISTING_ID=""
EXISTING_SECRET=""
if [ -f "$MCP_JSON" ]; then
  EXISTING_ID=$(node -e "
    try {
      const c = require('$MCP_JSON');
      const a = c.mcpServers?.['lark-mcp']?.args || [];
      const i = a.indexOf('-a');
      if (i >= 0) console.log(a[i+1]);
    } catch {}
  " 2>/dev/null || true)
  EXISTING_SECRET=$(node -e "
    try {
      const c = require('$MCP_JSON');
      const a = c.mcpServers?.['lark-mcp']?.args || [];
      const i = a.indexOf('-s');
      if (i >= 0) console.log(a[i+1]);
    } catch {}
  " 2>/dev/null || true)
fi

if [ -n "$EXISTING_ID" ] && [ -n "$EXISTING_SECRET" ]; then
  SECRET_PREVIEW="${EXISTING_SECRET:0:4}***"
  echo "检测到已有配置:"
  echo "  App ID:     $EXISTING_ID"
  echo "  App Secret: $SECRET_PREVIEW"
  echo ""
  echo "验证已有凭据..."
  VALIDATE=$(validate_creds "$EXISTING_ID" "$EXISTING_SECRET")
  if [ "$VALIDATE" = "OK" ]; then
    echo "✅ 已有凭据有效"
    echo ""
    read -p "是否继续使用此配置？[Y/n] " USE_EXISTING
    if [[ "$USE_EXISTING" =~ ^[Nn] ]]; then
      echo ""
      echo "请输入你自己的飞书应用凭据："
      echo ""
      input_credentials
    else
      echo "✅ 使用已有飞书配置"
    fi
  else
    echo "⚠️  已有凭据已失效: $VALIDATE"
    echo "请重新输入你的飞书应用凭据："
    echo ""
    input_credentials
  fi
else
  echo "未检测到飞书应用配置，请输入你的飞书应用凭据。"
  echo ""
  input_credentials
fi

# ─── Step 4: Install skill files ─────────────────────────────────
echo ""
echo "[4/5] 安装 Skill 文件..."
mkdir -p "$SKILL_DIR"

# Try local files first, then download from GitHub
REPO_URL="https://raw.githubusercontent.com/housenyou123/md2feishu/main"

if [ -f "$SCRIPT_DIR/md2feishu.mjs" ]; then
  cp "$SCRIPT_DIR/md2feishu.mjs" "$SKILL_DIR/md2feishu.mjs"
  cp "$SCRIPT_DIR/SKILL.md" "$SKILL_DIR/SKILL.md"
else
  echo "   从 GitHub 下载文件..."
  curl -sL "$REPO_URL/md2feishu.mjs" -o "$SKILL_DIR/md2feishu.mjs"
  curl -sL "$REPO_URL/SKILL.md" -o "$SKILL_DIR/SKILL.md"
  if [ ! -s "$SKILL_DIR/md2feishu.mjs" ]; then
    echo "❌ 下载失败，请检查网络连接"
    exit 1
  fi
fi
echo "✅ 文件已安装到 $SKILL_DIR"

# Register global CLI command
chmod +x "$SKILL_DIR/md2feishu.mjs"
mkdir -p "$HOME/.local/bin"
ln -sf "$SKILL_DIR/md2feishu.mjs" "$HOME/.local/bin/md2feishu"
if ! echo "$PATH" | tr ':' '\n' | grep -q ".local/bin"; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
  echo "   已添加 ~/.local/bin 到 PATH（重启终端生效）"
fi
echo "✅ 全局命令 md2feishu 已注册"

# ─── Step 5: Smoke test ──────────────────────────────────────────
echo ""
echo "[5/5] 运行验证测试..."

TEST_FILE=$(mktemp /tmp/md2feishu-test-XXXXXX.md)
cat > "$TEST_FILE" << 'TESTMD'
# 安装验证

这是 md2feishu 的安装验证文档。

| 项目 | 状态 |
|------|------|
| Node.js | ✅ |
| 飞书凭据 | ✅ |
| Skill 安装 | ✅ |
TESTMD

RESULT=$(node "$SKILL_DIR/md2feishu.mjs" "$TEST_FILE" --title "md2feishu 安装验证" 2>&1)
rm -f "$TEST_FILE"

if echo "$RESULT" | grep -q '"success":true'; then
  DOC_URL=$(echo "$RESULT" | grep -o 'https://feishu.cn/docx/[^ "]*')
  echo "✅ 验证通过！"
  echo ""
  echo "=========================================="
  echo "  安装完成！"
  echo "=========================================="
  echo ""
  echo "使用方式:"
  echo "  在 Claude Code 中:  /md2feishu <文件路径>"
  echo "  在终端中:           node ~/.claude/skills/md2feishu/md2feishu.mjs <文件路径>"
  echo ""
  echo "验证文档: $DOC_URL"
  echo ""
else
  echo "⚠️  验证未完全通过，输出:"
  echo "$RESULT"
  echo ""
  echo "Skill 文件已安装，但可能需要检查飞书应用权限。"
  echo "请确保应用已发布且权限已审批通过。"
fi
