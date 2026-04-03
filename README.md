# md2feishu

本地 Markdown 一键转飞书文档。零依赖，支持表格、代码块、列表等格式，自动开启链接分享。

## 安装

```bash
git clone https://github.com/housenyou123/md2feishu.git && cd md2feishu && bash setup.sh
```

安装脚本会自动完成：Node.js 检查 → 飞书凭据配置（交互式） → 文件安装 → 全局命令注册 → 端到端验证。

### 前提

- **Node.js 18+**（安装脚本会检查，macOS 自动 brew install）
- **飞书企业自建应用**（安装时引导创建，需 5 个 API 权限）
- **不需要 VPN** — 所有 API 调用走 `open.feishu.cn`

## 使用

### 终端

```bash
md2feishu ./report.md
md2feishu ./report.md --title "周报"
md2feishu ./report.md --folder fldcnXXX
```

### Claude Code

```
/md2feishu ~/path/to/file.md
```

## 支持的 Markdown 格式

| 元素 | 支持 | 说明 |
|------|------|------|
| 标题 H1-H6 | ✅ | 飞书 heading block |
| 粗体/斜体/删除线 | ✅ | 行内样式 |
| 行内代码 | ✅ | inline_code 样式 |
| 链接 | ✅ | 可点击 |
| 无序/有序列表 | ✅ | bullet/ordered block |
| 待办事项 | ✅ | todo block |
| 代码块 | ✅ | 30+ 语言语法高亮 |
| 引用块 | ✅ | quote block |
| 分割线 | ✅ | divider block |
| 表格 | ✅ | **飞书原生表格**，CJK 自适应列宽 |
| 图片 | ⚠️ | 转为链接形式 |
| YAML frontmatter | ✅ | 自动提取 title |

## 工作原理

```
.md 文件 → 解析为 Feishu Block JSON → 创建文档 → 批量插入 block → 设置链接分享 → 输出 URL
```

- 表格使用两步创建：先建空表结构 → 逐个填充单元格内容
- 列宽按内容显示宽度自动比例分配（CJK 字符算 2x 宽度）
- 超过 9 行的表格自动分段处理（飞书 API 限制）
- 429 限流自动退避重试

## 文件结构

```
md2feishu/
├── md2feishu.mjs   # 转换引擎（30KB，零 npm 依赖）
├── SKILL.md        # Claude Code skill 定义
├── setup.sh        # 一键安装脚本
└── README.md       # 本文件
```

## License

MIT
