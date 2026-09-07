# LitRoot

[English](README.en.md)

LitRoot 是一个以项目目录为事实来源、面向 paper-fetch Markdown 的本地文献管理器。支持 Windows 11 x64 本机或 WSL2、Linux x64，以及 macOS 15+ Apple Silicon，界面为中文。

它只做六件事：

- 编辑论文核心元数据，并在当前项目内执行 FTS5 全文搜索和年份筛选；
- 安全渲染 paper-fetch Markdown、正文图片、GFM 表格、代码和 KaTeX 数学公式；
- 通过 GUI 单篇或批量调用官方 `paper-fetch fetch`，批量条目数量不设固定上限；
- 注册多个项目，但浏览、搜索、抓取和笔记始终限定在当前项目；
- 把项目总笔记和逐篇笔记直接保存为项目内 Markdown。
- 在全局“期刊雷达”中查看 Crossref 最近登记的文献，并将最多 50 条交给现有 paper-fetch 流程。

LitRoot 不包含项目文献收藏/阅读状态、标签、AI 摘要/问答、Digest、订阅自动规则、PDF 标注、知识图谱、云同步、协作、Agent Relay 或内嵌终端。

## 运行架构

Electron 仅负责窗口、运行环境选择、安全 IPC 和受限图片协议。SQLite、扫描、监听、笔记写入和 paper-fetch 任务由打包为单个 CJS 文件的本地服务执行。Windows 可为每个项目选择本机或 WSL2；Linux 和 macOS 使用本机模式。本机服务通过 Electron 内置 Node 启动，WSL 模式继续通过固定 Bash 登录-shell 加载发行版内的 Node 与 paper-fetch。服务只绑定随机 `127.0.0.1` 端口，并要求 256-bit 会话令牌。

期刊雷达由 Electron 主进程管理，独立保存在 `userData/feeds.sqlite3`，不写入任何项目。期刊名称搜索、ISSN 验证和近期文献均使用 Crossref；“近 N 天”按 DOI 首次登记到 Crossref 的时间计算，正式出版日期单独显示。首次添加期刊回填近 30 天，启动时补刷超过 24 小时未检查的期刊，运行期间每小时检查，临时文献保留 90 天；应用关闭后不后台更新。只有显式添加到项目后，文献才进入现有抓取与验收流程。

前置条件（LitRoot 只诊断并显示修复命令，不会自动安装）：

- Windows 11 x64、Linux x64，或 macOS 15+ Apple Silicon；
- 本机模式安装对应平台的官方 `paper-fetch`；Node.js 已由 LitRoot 内置；
- WSL 模式需要 WSL2，并在所选发行版内安装 Node.js 24.15+（24.x）和官方 `paper-fetch`。

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

LitRoot 不复制抓取逻辑。单篇使用 `paper-fetch fetch --query`，批量使用 UTF-8 query file 和最终 JSONL 结果；单篇保留独立 manifest。两者都通过 stderr JSONL 事件显示实时进度，通过 stdin 请求协作式取消，固定参数为：

```text
--progress jsonl
--control-stdin
--artifact-mode markdown-assets
--asset-profile body
--include-refs all
--max-tokens full_text
```

单篇、批量及两种刷新入口都逐项展示中文阶段、阶段耗时、当前轮次的正文图/公式/表格图计数与取消按钮。取消请求先显示“取消中”，执行端确认后显示“已取消”，其余论文继续；进入“验收归档”的结果会完成归档事务。汇总按“已结束 X/N”分别统计成功、降级、失败、受限、需要操作和取消。顶层 `status=ok` 不等于全文完成；摘要和 metadata 结果最多为 `limited`。

LitRoot 要求 paper-fetch 声明 `--progress` 和 `--control-stdin`，依赖诊断及创建/恢复时都会检查；旧版会收到明确升级提示。

所有新结果先写入 `.litroot/tmp/`。每篇完成后立即独立验收、归档并更新文献列表，无需等待整批结束。取消项的部分产物留在暂存区，不入库；取消刷新保留旧全文，可显式“从 manifest 恢复”重新执行取消项。LitRoot 复核身份、可信 frontmatter、内容级别、资产边界、实际路径和 SHA-256 后再归档。刷新结果不是全文或资产验收失败时，旧正文保持不变；笔记和元数据覆盖永远不会被刷新替换。

## 安全边界

- renderer 无 Node、文件系统或进程权限，只能调用窄类型 IPC；
- localhost API 未带正确令牌时返回 401，并拒绝浏览器 `Origin` 直连；
- 只扫描 `papers/` 中带 `doi`、`source`、布尔 `has_fulltext` 和合法 `content_kind` 的 Markdown；
- 原始 HTML 经过白名单清洗，脚本、事件属性、危险 URL 和远程图片被阻止；
- 本地图片必须是论文 Markdown 明确引用的相对路径，真实路径仍位于当前项目；
- 子进程使用参数数组且 `shell=false`；WSL 登录-shell 只执行固定的 `exec "$@"`。Windows 官方 `paper-fetch.cmd` 会解析到安装器内置 Python 的模块入口，不会通过 `cmd.exe` 执行用户输入。

## 开发

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run build
pnpm dev
```

Node 版本见 [.node-version](.node-version)。生成各平台安装包：

```bash
pnpm run package:win
pnpm run package:linux
pnpm run package:mac
```

Windows 打包先由 electron-builder 生成 x64 `win-unpacked`，再输出未签名 Inno Setup 安装器 `LitRoot-<version>-windows-x64-unsigned-setup.exe`；本机构建要求 Inno Setup 6 的 `ISCC.exe` 位于 `PATH`，GitHub `windows-2022` runner 使用[预装的 Inno Setup](https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md?plain=1)。从旧 NSIS 安装包升级前需先手动卸载旧版，本次不自动检测、卸载或迁移。Linux 输出 x64 AppImage 与 deb，macOS 输出未签名、未公证的 arm64 DMG；未签名的 macOS 安装包可能触发 Gatekeeper 提示。

完整架构说明见 [docs/architecture.md](docs/architecture.md)，Windows 本机与 WSL2 实机验收步骤见 [docs/windows-acceptance.md](docs/windows-acceptance.md)。

当前发布的安装包未签名，也不包含一键环境安装功能。
