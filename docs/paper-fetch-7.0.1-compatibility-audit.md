# paper-fetch-skill 7.0.1 兼容性审计

审计日期：2026-09-27。结论：核心 CLI 接口兼容，但当前 LitRoot 不宜宣称已完整适配 7.0.1；Windows 配置继承、认证引导、诊断保留和批量状态解释存在缺口。以下问题是与 7.0.1 对照发现的现有适配问题，不代表都由 7.0.1 新引入。

审计基线：

- LitRoot：1.1.3，提交 `8b297b1`，审计开始时工作区干净。
- paper-fetch-skill：本地 `/home/dictation/paper-fetch-skill`，标签 `v7.0.1`，提交 `c77c19a79f8447eed04941d1cc2216e5728a4a02`，源码工作区干净。
- 源码虚拟环境入口实际报告 `paper-fetch 7.0.1`；当前 PATH 中的离线安装入口实际报告 `paper-fetch 7.0.0`。所以默认运行环境尚未切换到本次目标版本。
- 7.0.1 的变更集中在 Wiley、Taylor & Francis、Elsevier 的资产获取和诊断；7.0 保留 CLI/MCP 参数与公开结果结构。依据为目标仓库的 `CHANGELOG_CN.md`、`docs/cli.md`、`docs/migration-v7.md` 和实际实现。

## 发现

### 1. P1：Windows 本机入口丢失官方安装配置

位置：[`windowsPaperFetchCommand`](../src/main/wsl-manager.ts#L68) 和本机服务环境组装（同文件第 226–236 行）。

LitRoot 将官方 `bin/paper-fetch.cmd` 转成 `runtime/python.exe -X utf8 -m paper_fetch.cli`，只传递可执行文件和参数。7.0.1 官方 `.cmd` 还会在未设置时指定 `PAPER_FETCH_ENV_FILE=<安装目录>/offline.env`，LitRoot 没有复制此行为。上游 `config.py` 只读取显式参数、环境变量指定文件和用户配置目录，不自动根据 Python 路径发现该文件。

触发条件：从桌面启动 Windows 本机 LitRoot，父进程没有设置 `PAPER_FETCH_ENV_FILE`，相关配置仅保存在安装目录的 `offline.env`。此时官方 CLI 可用，LitRoot 却可能缺失凭据或图片工具、浏览器配置；`--version` 和 `fetch --help` 仍可成功，依赖诊断不能发现这一差异。

建议：命令描述携带必要的环境默认值；保留用户已有环境变量，缺失时补上安装目录的配置文件。继续采用参数数组和 `shell=false`。此项已完成静态代码核对，尚未在原生 Windows 上复现。

上游依据：`scripts/build-offline-package-windows.ps1` 第 359–366 行、`src/paper_fetch/config.py` 第 164–179 行。

### 2. P2：需要人工认证时没有生成可用引导

位置：[`parseTerminalRecord`](../src/service/fetch-record.ts#L106)、[`FetchAcceptance.accept`](../src/service/fetch-acceptance.ts#L51)。

解析器将 `provider` 取自顶层 `provider/source/metadata.provider`，未读取 `error.provider` 或 `acquisition.provider`。7.0.1 的真实失败记录可以是 `source=null`、`error.status=auth_required`、`error.provider=wiley`。离线联调中，这条记录进入 LitRoot 后仍正确显示 `action_required`，但 `provider=null`，没有生成 `paper-fetch auth wiley`，界面的“复制人工命令”入口也不会出现。

此外，`source` 与认证命令的 provider 不是同一枚举，例如 `wiley_browser` 是来源名称，不是 `auth` 接受的 `wiley`。不能直接把来源名称当认证参数。

建议：区分 source 与 provider；优先读取结构化失败或 acquisition 中的 provider，必要时使用上游 catalog 的来源映射，并核对该 provider 是否支持人工认证。

### 3. P2：失败码被误分类，成功降级的原因丢失

位置：[`parseTerminalRecord`](../src/service/fetch-record.ts#L108)、[`projectRecord`](../src/service/fetch-record.ts#L183)、[`FetchAcceptance.accept`](../src/service/fetch-acceptance.ts#L60)。

两个真实 7.0.1 记录已通过 LitRoot 服务复现：

| 上游事实 | LitRoot 最终结果 |
| --- | --- |
| `error.status=browser_context_create_failed`，无 Markdown 是抓取失败的正常结果 | `state=failed`，但 `errorCode=missing_markdown_output`；原错误文字仍保留 |
| HTML 浏览器失败后全文 fallback 成功，`overall=degraded`，`failure_codes/fallback_codes` 含 `browser_runtime_prepare_timeout` | 正文成功入库并保留 `degraded`，但 `reason=null`、`errorCode=null` |

第一种情况中，解析器没有将 `error.status` 的稳定错误码纳入映射；验收器随后对已经 `failed` 的记录执行缺少产物检查。第二种情况中，`trace`、`failure_codes`、`fallback_codes`、`warning_codes` 和七个验收分面没有进入应用记录。原始 engine manifest/JSONL 仍在磁盘上，因此不是原始证据被删除，而是 GUI 和应用记录无法解释降级。

建议：先处理失败终态，再判断成功结果是否缺少应有产物；保留上游稳定错误码和结构化降级原因。扩展应用记录以保留必要的 provenance、资产验收和语义损失摘要。不要将 `degraded` 提升为成功，也不要靠 warning 文案重新分类。

### 4. P2：限流导致的未调度条目显示成“已取消”

位置：[`parseTerminalRecord`](../src/service/fetch-record.ts#L97)、[`fetchItemStateSchema`](../src/shared/contracts.ts#L239)、[`FetchAcceptance.accept`](../src/service/fetch-acceptance.ts#L46)。

使用真实 7.0.1 CLI，提交同 provider 的三条 DOI、并发为 1，第一条返回 `rate_limited`。其余两条没有执行，上游最终记录为 `record_status=aborted`、`error.code=rate_limited`，reason 明确说明 provider lane 限流导致未调度。

LitRoot 无条件将 `aborted` 映射为 `cancelled`，最终状态为 `action_required / cancelled / cancelled`。用户没有发出取消请求，但界面和汇总将后两条计入“已取消”。英文原因仍保留，取消和未执行的语义却被合并。

建议：结合结构化错误码区分取消、限流中止与未调度；增加相应状态或至少独立的终止原因及汇总。7.0.1 CLI 本身使用 `aborted` 包装未调度结果，不能只靠 `record_status` 区分，也不能把 MCP 的顶层状态枚举直接套在 CLI 上。

### 5. P3：完成序号依赖了 CLI 未提供的字段

位置：[`parseTerminalRecord`](../src/service/fetch-record.ts#L120)、[`tests/helpers.ts`](../tests/helpers.ts#L94)。

当前解析器直接读取 `completion_order`，fake CLI 总是提供该字段。7.0.1 CLI 的 `ManifestRecord` 没有该字段，真实三条批量结果在应用中均为 `completionOrder=null`。基本导入不受影响，但 `docs/architecture.md` 所述的独立完成顺序没有得到真实 CLI 支持。

建议：若保留这项应用契约，在接收 terminal 事件时自行记录完成序号；否则修正文档和测试中的假设。不要依据最终 JSONL 的输入顺序推断实际完成顺序。

## 已核对的兼容部分

| 接口或行为 | 结论 |
| --- | --- |
| 单篇 `fetch --query`、批量 `--query-file` | 参数契约一致 |
| `--progress jsonl`、`--control-stdin` | 协议 1 的事件、run_id、输入 index 和取消消息格式一致 |
| 单篇 `--manifest`、批量 `--batch-results` | 均可读取真实 schema-v2 记录；未误用已不存在的引擎恢复参数 |
| `markdown-assets/body/all/full_text` 参数组合 | 仍为有效正文及正文资产归档组合 |
| Markdown frontmatter | 7.0.1 输出可解析，新增 acquisition 不会阻止导入 |
| 内容级别和实际文件验收 | `complete/degraded/limited` 可入库；摘要未被升格为全文；路径、SHA-256 检查仍执行 |
| 协作式取消 | 离线真实 CLI 进程可响应取消，取消结果不入库 |
| 大批量 | MCP 每次最多 50 条不等于 CLI query-file 的限制，不能据此认定 LitRoot 超过 50 条不兼容 |
| 旧缓存与 PDF 输出变化 | LitRoot 未直接消费引擎提取缓存，也未依赖旧版 PDF 内容清洗；当前未发现由这两项变更导致的调用阻断 |

## 验证与边界

- 使用锁文件安装项目依赖，未更新依赖声明或锁文件；安装跳过依赖脚本。
- `tsc --noEmit -p tsconfig.node.json` 通过。
- 相关既有测试：7 个文件、60 个用例通过，覆盖记录解析、Markdown、命令描述、抓取任务、项目流程、Windows 命令解析和阅读器。
- 额外使用目标仓库的真实 7.0.1 CLI、序列化器、进度协议、manifest 和 Markdown 输出代码，替换网络获取函数及运行环境加载，执行单篇全文、成功降级、受限内容、运行时失败、人工认证、取消、批量限流和正常批量场景。上述映射问题来自真实上游记录，而非 LitRoot 现有 fake CLI。
- 临时复现测试最终 3 个用例通过；断言同时核对正常路径和已发现问题的实际表现，并不表示这些缺陷已修复。
- 没有进行出版社联网抓取、真实浏览器登录、原生 Windows/macOS 或安装包验收；本审计不能证明这些运行环境已通过。
- 现有 fake CLI 自报 `6.1.5-fake`，认证 provider 的字段位置、错误码和完成序号与真实 CLI 存在差异，因此既有测试通过不足以排除本报告问题。
- 临时复现脚本和输出位于 `/tmp/litroot-pf701-audit/`；临时测试不保留在项目测试目录。未修改业务实现、升级已安装的 paper-fetch 或改动目标仓库。

建议顺序：先修复 Windows 环境继承，再补齐认证和诊断映射，随后区分未调度状态，并用真实 schema-v2 fixture 替换不准确的测试假设。


## 修复与验证补记（2026-09-27）

上文保留审计时的原始发现和结论。本节记录随后在 LitRoot 工作区完成的适配，不代表已经完成原生 Windows/macOS 或出版社联网验收。

| 原发现 | 已实施修复 | 验证证据 |
| --- | --- | --- |
| Windows 官方配置丢失 | `PaperFetchCommand.envDefaults` 提供安装目录 `offline.env`；非空用户值优先，服务启动、诊断、抓取共用合并规则 | 含空格安装路径的命令转换测试；空值/自定义值测试；同一配置通过版本、协议检查和实际抓取的集成测试 |
| 人工认证缺失或 provider 混淆 | 分离 source/provider，优先读取 error/acquisition；按需核对 `auth --help` 的 positional provider，通过独立 `authCommand` 提供命令 | 真实 `source=null/error.provider=wiley` 记录及真实 CLI 均产生 `paper-fetch auth wiley`；不支持的 provider、帮助读取失败和纯命令复制均有测试 |
| 错误码误分类、降级理由丢失 | 失败/操作/取消终态先于产物验收；保留明确 code 或有错误含义的 status，保存 acquisition、验收结构、代码列表、重试时间及 trace 摘要 | 真实 browser failure 保留 `browser_context_create_failed`；fallback 成功仍为 degraded，`browser_runtime_prepare_timeout` 在归档及重新打开后可见；失败/取消刷新保留旧正文 |
| 未调度被计入取消 | 根据结构化取消码与 schema-v2 批量未调度形态区分 `cancelled` 和 `not_scheduled`；未知/不完整中止保守按失败处理 | 真实限流批次得到 `action_required / not_scheduled / not_scheduled`；界面独立计数、提供继续入口；逐项/整批取消测试通过 |
| 完成序号依赖虚构字段 | 首次有效 terminal 事件到达时分配序号，持久化单调计数器；最终文件补回的结果不推断顺序 | fake CLI 已删除 `completion_order`，版本修正为正式 7.0.1；乱序、重复/过期事件、缺失事件、恢复后延续序号及旧任务默认值均通过 |

补充版本门槛：依赖诊断、新建和恢复统一要求 7.0.1 或更高正式版本及 `--progress jsonl / --control-stdin`。数值比较覆盖较高主/次/补丁版本；7.0.0、非法/预发行版本和能力缺失会被拒绝，创建/恢复失败不改动已有任务。构建服务对当前 PATH 实测返回 `paper-fetch 7.0.0`、`ready=false` 和明确升级提示。PATH 安装未升级。

验收结构核实：7.0.1 实际发出 `overall` 和 identity/fetch/content/asset/output/provenance 六个分面，本次诊断对象保留这七部分，不虚构额外的分面。旧任务只补默认字段并从已有序号恢复计数器，不猜测历史诊断，不重写旧论文；数据库结构与 HTTP/IPC 方法保持不变。

验证记录：

- `pnpm check:ci`：通过；32 个测试文件，251 项通过，7 项需显式指定本地源码/Python 的离线 CLI 测试在普通运行中跳过。类型检查、源码/格式检查、生产构建、bundle 语法、打包 preload 和包边界均通过。
- 显式设置 `LITROOT_PAPER_FETCH_SOURCE` 与 `LITROOT_PAPER_FETCH_PYTHON` 运行 `tests/integration/paper-fetch-701.test.ts`：该文件全部 15 项通过（含普通 fixture 回放及 7 项真实本地 7.0.1 离线 CLI 联调）。同期界面测试也通过。
- `verify-packaged-service.mjs` 对新构建 `dist/service/litroot-service.cjs` 验证通过，分别使用本地 Node 24.21.0 和从现有 Linux 1.1.3 deb 临时解包的 Electron 运行时；验证启动及已认证 health 请求，未生成或发布新安装包。
- 审计临时记录已脱敏固化在 `tests/fixtures/paper-fetch-7.0.1/`；Markdown 与原始 SHA-256 对应。普通测试不依赖相邻仓库绝对路径。可选离线适配器只替换网络获取和运行环境加载，真实 CLI 负责序列化、进度、取消与批量调度。
- 未新增依赖或修改依赖/锁文件，未修改 paper-fetch-skill 仓库；目标源码工作区仍干净。
- **未验证**：原生 Windows/macOS、出版社联网抓取、真实浏览器登录、新安装包端到端验收。Windows 配置结论目前来自自动化模拟和代码验证，需继续按 `docs/windows-acceptance.md` 在原生机器验收。
