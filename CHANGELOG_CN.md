# 更新日志

[English](CHANGELOG.md)

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
