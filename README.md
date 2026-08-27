# LitRoot

[English](README.en.md)

LitRoot 是一个以项目目录为事实来源、面向 paper-fetch Markdown 的本地文献管理器。首个 MVP 正式支持 Windows 11 + WSL2，界面为中文。

它只做五件事：

- 编辑论文核心元数据，并在当前项目内执行 FTS5 全文搜索和年份筛选；
- 安全渲染 paper-fetch Markdown、正文图片、GFM 表格、代码和 KaTeX 数学公式；
- 通过 GUI 单篇或最多 50 条批量调用官方 `paper-fetch fetch`；
- 注册多个项目，但浏览、搜索、抓取和笔记始终限定在当前项目；
- 把项目总笔记和逐篇笔记直接保存为项目内 Markdown。

LitRoot 不包含收藏、阅读状态、标签、AI 摘要/问答、Digest、Radar、PDF 标注、知识图谱、云同步、协作、Agent Relay 或内嵌终端。

## 运行架构

Windows Electron 仅负责窗口、WSL 发行版选择、安全 IPC 和受限图片协议。SQLite、扫描、监听、笔记写入和 paper-fetch 任务全部由 WSL 中的 Node.js 服务执行。Electron 使用 `wsl.exe` 进入固定的 Bash 登录-shell 跳板，加载 `nvm` 和用户级 paper-fetch 环境后，以 `exec` 启动打包为单个 CJS 文件的服务；服务绑定随机 `127.0.0.1` 端口，并要求 256-bit 会话令牌。

前置条件（LitRoot 只诊断并显示修复命令，不会自动安装）：

- Windows 11 + WSL2；
- WSL 内 Node.js 24.15+（24.x）；
- WSL 内可执行的官方 `paper-fetch`；
- WSL 内 Git。

## 项目目录

首次连接只创建缺失目录，不覆盖已有文件：

```text
<project>/
├── papers/
├── notes/
│   ├── project.md
│   └── papers/<paper-id>.md
└── .litroot/
    ├── project.yaml
    ├── metadata/<paper-id>.yaml
    ├── cache/index.sqlite3
    ├── runs/
    └── tmp/
```

`.litroot/.gitignore` 只忽略可重建的 `cache/`、`runs/` 和 `tmp/`。`project.yaml`、元数据覆盖和笔记适合提交 Git。断开项目只取消注册，不删除项目文件。

元数据覆盖遵循“项目覆盖值 > paper-fetch 抓取值”。字段缺失表示继承；空字符串或空数组表示显式清空；界面可逐字段恢复抓取值。paper ID 首次确定后持久化，所以修正 DOI 不会断开逐篇笔记。

## 抓取与验收

LitRoot 不复制抓取逻辑。单篇使用 `paper-fetch fetch --query`，批量使用 UTF-8 query file、JSONL 和 run manifest，固定参数为：

```text
--artifact-mode markdown-assets
--asset-profile body
--include-refs all
--max-tokens full_text
```

任务逐项展示身份、候选、provider、尝试次数、抓取阶段和 `complete / degraded / limited / failed / action_required`。顶层 `status=ok` 不等于全文完成；摘要和 metadata 结果最多为 `limited`。

所有新结果先写入 `.litroot/tmp/`。LitRoot 复核身份、可信 frontmatter、内容级别、资产边界、实际路径和 SHA-256 后再归档。刷新结果不是全文或资产验收失败时，旧正文保持不变；笔记和元数据覆盖永远不会被刷新替换。

## 安全边界

- renderer 无 Node、文件系统或进程权限，只能调用窄类型 IPC；
- localhost API 未带正确令牌时返回 401，并拒绝浏览器 `Origin` 直连；
- 只扫描 `papers/` 中带 `doi`、`source`、布尔 `has_fulltext` 和合法 `content_kind` 的 Markdown；
- 原始 HTML 经过白名单清洗，脚本、事件属性、危险 URL 和远程图片被阻止；
- 本地图片必须是论文 Markdown 明确引用的相对路径，真实路径仍位于当前项目；
- Windows 子进程使用参数数组且 `shell=false`；WSL 登录-shell 只执行固定的 `exec "$@"`，动态输入始终作为位置参数传递，不会拼接进 shell 命令字符串。

## 开发

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run build
pnpm dev
```

Node 版本见 [.node-version](.node-version)。生成未签名 Windows 安装器：

```bash
pnpm run package:win
```

完整架构说明见 [docs/architecture.md](docs/architecture.md)，Windows + WSL2 实机验收步骤见 [docs/windows-acceptance.md](docs/windows-acceptance.md)。

本仓库在 MVP 阶段保持私有；公开许可证、签名安装器和一键环境安装不在当前范围内。
