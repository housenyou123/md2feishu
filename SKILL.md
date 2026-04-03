---
name: md2feishu
description: 将本地 Markdown 文件转换为飞书云文档。自动解析标题、列表、代码块、表格等元素，创建带格式的飞书文档并设置链接分享权限。
allowed-tools: Bash, Read
---

# md2feishu — Markdown 转飞书文档

## 使用方式

- `/md2feishu <文件路径>` — 转换 md 文件到飞书文档
- `/md2feishu <文件路径> --title "标题"` — 指定文档标题
- `/md2feishu <文件路径> --folder fldcnXXX` — 创建到指定飞书文件夹

## 前置依赖（首次使用前需完成）

### 1. Node.js 18+

脚本使用内置 `fetch`，需要 Node.js 18 或更高版本：

```bash
node -v  # 确认 >= v18
```

如未安装：`brew install node`（macOS）或从 https://nodejs.org 下载。

### 2. 飞书企业自建应用

1. 打开 [飞书开发者后台](https://open.feishu.cn/app) → **创建企业自建应用**
2. 记下 **App ID**（格式 `cli_xxx`）和 **App Secret**
3. 进入应用 → **权限管理** → 搜索并开通以下权限：
   - `docx:document` — 创建和编辑文档
   - `docx:document:readonly` — 读取文档
   - `drive:drive` — 访问云空间
   - `drive:drive:readonly` — 读取云空间
   - `drive:permission.member:create` — 管理文档权限（用于开启链接分享）
4. 进入 **版本管理与发布** → 创建版本 → 申请发布（需管理员审批通过）

### 3. 配置凭据（二选一）

**方式 A — 写入 `~/.claude/mcp.json`**（推荐，持久化）：

```json
{
  "mcpServers": {
    "lark-mcp": {
      "command": "echo",
      "args": ["-a", "cli_你的AppID", "-s", "你的AppSecret"]
    }
  }
}
```

**方式 B — 环境变量**（临时使用）：

```bash
export FEISHU_APP_ID=cli_你的AppID
export FEISHU_APP_SECRET=你的AppSecret
```

### 4. 安装 Skill 文件

确保以下两个文件存在：

```
~/.claude/skills/md2feishu/
├── SKILL.md         # 本文件（skill 定义）
└── md2feishu.mjs    # 转换脚本（零 npm 依赖）
```

### 5. 验证安装

```bash
# 创建测试文件
echo "# 测试\n\n- 项目 1\n- 项目 2" > /tmp/test.md

# 运行转换
node ~/.claude/skills/md2feishu/md2feishu.mjs /tmp/test.md

# 成功输出: ✅ Document created ... URL: https://feishu.cn/docx/xxx
```

## 执行流程

直接运行脚本：

```bash
node ~/.claude/skills/md2feishu/md2feishu.mjs "<文件路径>" [--title "标题"] [--folder <folder_token>]
```

脚本会自动：
1. 从 `~/.claude/mcp.json` 或环境变量读取飞书应用凭据
2. 获取 tenant_access_token
3. 解析 Markdown 内容为飞书 block 格式
4. 创建飞书文档并批量插入内容（表格单独处理）
5. 设置文档链接分享权限（组织内可编辑）
6. 输出文档 URL

## 支持的 Markdown 元素

- 标题 H1-H6
- 段落（含粗体、斜体、删除线、行内代码、链接）
- 无序列表、有序列表
- 待办事项 `- [x]`
- 代码块（30+ 语言语法高亮）
- 引用块 `>`
- 分割线 `---`
- **飞书原生表格**（自动按内容比例分配列宽，CJK 字符感知，超 9 行自动分段）
- YAML frontmatter（自动提取 title 字段）
- 图片转为链接形式

## 常见问题

| 错误 | 原因 | 解决 |
|------|------|------|
| `No credentials found` | 未配置凭据 | 按上方步骤 3 配置 |
| `Auth failed` / `Tenant auth failed` | App ID 或 Secret 错误 | 检查飞书开发者后台的凭据 |
| `code 99991663` / `99991664` | 应用缺少文档权限 | 按步骤 2 添加权限并发布版本 |
| `code 1770001` (invalid param) | 表格超过 9 行 | 脚本自动处理，无需操作 |
| `429 Rate limited` | API 调用频率过高 | 脚本自动退避重试，无需操作 |
| 文档打不开 / 无权限 | 链接分享未生效 | 检查应用是否有 `drive:permission.member:create` 权限 |
