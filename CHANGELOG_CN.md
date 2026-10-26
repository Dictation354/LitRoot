# 更新日志

[English](CHANGELOG.md)

## [1.2.1](https://github.com/Dictation354/LitRoot/releases/tag/v1.2.1) — 2026-10-26

### 修复

- 项目目录删除后仍可断开对应条目，同时清除服务端残留的注册记录，不再要求项目已加载。
- 修复 Windows 的 PATH 中缺少 paper-fetch 时系统报错乱码的问题，改为清晰的安装和配置提示。

[完整变更](https://github.com/Dictation354/LitRoot/compare/v1.2.0...v1.2.1)

## [1.2.0](https://github.com/Dictation354/LitRoot/releases/tag/v1.2.0) — 2026-10-23

### 改进

- 使用 MathJax 4.1.3 替代 KaTeX，同步离线渲染 SVG 和辅助 MathML，内置 TeX、mhchem、bbm 字库并扩展 TeX 命令支持。
- 与 paper-fetch 7.2.0 共用公式引擎，通过生成源码和 SHA-256 摘要检查保持一致，并以离线 CLI 联调及阅读器测试验证兼容性。
- 每篇文档独立维护宏与诊断；失败公式显示源 TeX 和错误提示，其余正文继续渲染。
- 保留 Markdown 公式定界规则与源 TeX，适配 MathJax 显示样式和正文搜索，并通过保留解析器行为的 pnpm 补丁移除未使用的 KaTeX 依赖。

[完整变更](https://github.com/Dictation354/LitRoot/compare/v1.1.4...v1.2.0)

## 1.1.4 — 2026-09-27

- 新建/恢复任务前统一检查 paper-fetch 7.0.1+ 正式版本及 JSONL 进度/控制能力。
- Windows 官方入口保留安装配置，用户显式配置优先。
- 保存来源、获取路线和验收诊断，保留失败/降级原因，独立提供受支持的人工认证命令。
- 区分批量未调度与取消，按真实 terminal 事件记录完成顺序并在恢复后继续计数。
- 增加真实 7.0.1 契约 fixture 与可选离线 CLI 联调；旧任务记录保持可读。

## [1.1.3](https://github.com/Dictation354/LitRoot/releases/tag/v1.1.3) — 2026-09-13

### 修复

- 将已选文献数量移至现有底部分页栏，修复选中文献后列表位移、导致双击误点其他文献的问题。

[完整变更](https://github.com/Dictation354/LitRoot/compare/v1.1.2...v1.1.3)

## [1.1.2](https://github.com/Dictation354/LitRoot/releases/tag/v1.1.2) — 2026-09-12

### 修复

- 抓取的论文保留生成的文件名，直接归档到 `papers/`，不再创建基于论文身份的子目录。
- 论文或附件重名时拒绝覆盖已有文件，并提示冲突。
- 复制本地附件到归档目录时保留图片相对路径。

[完整变更](https://github.com/Dictation354/LitRoot/compare/v1.1.1...v1.1.2)

## [1.1.1](https://github.com/Dictation354/LitRoot/releases/tag/v1.1.1) — 2026-09-09

### 修复

- 修复多个 Markdown 文件共享论文身份（例如相同 DOI，或无 DOI 时相同的来源 URL）导致持续重扫、“扫描中 / 已就绪”反复切换的问题。
- 保留当前已索引版本，将其余副本记录为冲突，不修改原始文件；重启或重建索引缓存后仍保留所选版本。
- 相同冲突不再重复写入，扫描结果无变化时不再发送扫描通知。
- 已索引文件删除后，由剩余副本接替，并保留论文 ID、元数据覆盖和笔记关联；重复文件删除后清除对应冲突记录。

[完整变更](https://github.com/Dictation354/LitRoot/compare/v1.1.0...v1.1.1)

## [1.1.0](https://github.com/Dictation354/LitRoot/releases/tag/v1.1.0) — 2026-09-07

### 新增

- 期刊雷达与订阅收件箱，并改进文献工作区操作。
- 实时抓取进度与单篇论文取消抓取。
- 分页大小偏好设置，移除固定抓取批次上限。

### 改进与修复

- 保留笔记和元数据编辑草稿，改进未保存内容提示与应用退出流程。
- 改进 Markdown 阅读、滚动位置、对话框交互与错误反馈。
- 修复取消状态测试的时序依赖，以及 CI 中的 Windows 代码检出失败。

[完整变更](https://github.com/Dictation354/LitRoot/compare/v1.0.0...v1.1.0)

## [1.0.0](https://github.com/Dictation354/LitRoot/releases/tag/v1.0.0) — 2026-08-29

### 新增

- 面向 paper-fetch Markdown、以项目目录为事实来源的本地文献管理器首个正式版本。
- 支持 Windows 11 x64 本机与 WSL2、Linux x64，以及 macOS 15+ Apple Silicon。
- 支持 Markdown 正文、本地图片、GFM 表格、代码和 KaTeX 数学公式阅读，以及项目内全文搜索、年份筛选、元数据覆盖、批量抓取和项目/逐篇笔记。
- Windows 双语 Inno Setup 安装器，并在 CI 中验证安装、运行时与卸载流程。
- Windows、Linux 和 macOS 安装包的 SHA-256 校验文件。

### 修复

- 修正文献阅读页在页面标题下方重复显示正文一级标题的问题。
