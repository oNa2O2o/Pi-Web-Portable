# 本地定制与升级保留要求

合并上游、升级 Pi SDK、重新安装依赖和制作便携包时，必须保留这里列出的行为。
不能用“上游代码已更新”作为删除修复的理由。只有替代实现通过相同回归测试后，
才可以移除旧实现。

## 2026-10-23：Claude 5.5 自适应思考

- 词易 `api.chiyi.cc` 的原生 `claude-opus-5-5` 和 `claude-sonnet-5-5`
  自定义模型缺少 `compat.forceAdaptiveThinking` 时，SDK 会发送旧式预算思考，
  服务端返回 `requires adaptive thinking` 400。
- 内置请求钩子将这两个模型的 `thinking.type=enabled` 改为 `adaptive`，
  删除 `budget_tokens`，按当前思考档位设置 `output_config.effort`。
  保留显式 effort、原生 adaptive 请求、关闭思考、输出上限和完整会话历史。
- 普通会话、Chat-only、子代理与 reload 共用既有内置兼容扩展。
  不写入用户 models.json，不分发用户凭据。其他端点和模型保持原行为。
- `npm run test:models` 和便携包复用构建检查必须包含自适应思考回归。

## 2026-10-21：元衡 Gemini 4 思考参数兼容

- `google-generative-ai` 的自定义 baseUrl 必须包含 `/v1beta`；仅填写网站根地址
  会使聊天请求收到 HTML。保存配置后应让旧模型运行时失效。
- Pi 1.2 未把 `gemini-4-argon` 识别为使用 `thinkingLevel` 的模型，会将所有启用的
  思考档位发成 `thinkingBudget: -1`。元衡原生接口的对照测试中，该参数出现
  60 秒无响应超时，而显式 `thinkingLevel: HIGH` 成功回复。
- `lib/gemini-4-thinking.ts` 是独立 Pi 扩展，当前部署于用户数据目录
  `~/.pi/agent/extensions/gemini-4-thinking.ts`，在发送前替换该模型的旧思考参数。
  必须保留用户数据目录内的扩展；不能通过清空扩展目录升级。
- 仅适配元衡的 `gemini-4-argon` 原生接口。保留用户选定的档位、输出上限、
  系统提示、工具及所有历史；关闭思考、显式原生档位和其他提供商保持原行为。
  SDK 已提供原生 `thinkingLevel` 时该扩展不再修改请求。
- `npm run test:models` 包含参数及扩展钩子回归。验收仍需实际高思考聊天、
  工具结果继续对话，以及原有会话重新加载；单次 OK 不代表上游持续可用。

## 2026-10-16：Claude 跨模型工具历史兼容

- 词易 Claude 使用原生 `anthropic-messages`；不要改回 OpenAI 协议。
- Gemini/GPT 通过 OpenAI 接口生成的历史工具 ID 可能以 `call_` 开头。
  `api.chiyi.cc` 会拒绝这些 ID，即使请求本身已经使用 Anthropic `/v1/messages`。
- `lib/anthropic-tool-ids.ts` 在发送请求前，将该端点的外来工具 ID 映射为稳定、
  不冲突的 `toolu_` ID，同时更新配对的 `tool_result.tool_use_id`。
- 保留原始会话 JSONL、工具参数、正文和原生 `toolu_` ID；禁止批量改写或删除历史。
- 普通会话、Chat only 和子代理均需加载此兼容处理；其他协议和端点保持原行为。
- 不可只看“模型连接测试通过”：必须测试带工具历史的继续对话及后续工具调用。

### 2026-10-21：跨 API 思考记录不得转成正文

- Pi SDK 1.2 会将其他 API 的助手 `thinking` 块转换成普通文本，再发给 Claude。
  `lib/anthropic-foreign-thinking.ts` 在请求上下文投影阶段阻止这种转换，
  仅作用于 `api.chiyi.cc` 的原生 Anthropic 请求。
- 只移除发送副本中来自其他 API 的 `thinking` 类型块，不按词语筛选正文；
  用户消息、正式回答、工具调用与结果、系统规则、原生 Anthropic 思考与签名不变。
  原始会话文件及其中的思考记录必须保留。
- `createAnthropicToolIdsExtension()` 注册该上下文钩子，普通会话、
  Chat-only、子代理及 reload 均由集成测试覆盖。
  当前运行版通过用户目录 `extensions/anthropic-foreign-thinking.ts` 加载；
  内置修复与独立扩展并存时应幂等，不得重复改写。
- 在原失败会话副本上，同一 Opus 5.5、同一原始提问经过该修正后得到
  `end_turn` 和真实业务回答；不是空白聊天的 OK 测试。
  不能将这条证据推广为所有上游拒绝都能或都应绕过。

升级与打包前必须运行：

```powershell
npm run test:models
```

此检查必须保留在构建命令及发布工作流中。若新版 SDK 改变请求结构或扩展钩子，
先修复适配并通过测试，再生成发布包。不得跳过失败检查继续发布。
`build-portable.ps1 -SkipBuild` 也必须运行该检查，不能因为复用构建产物而绕过。

### Claude 系统文档索引兼容

- 已验证 `api.chiyi.cc` 会在 system 中同时出现 `docs/custom-provider.md` 和
  `pi packages (docs/packages.md)` 时返回 extra-usage 400；相同内容放在用户消息
  或工具结果中可以成功。不能把这类错误统一解释为 Key 额度耗尽。
- `lib/anthropic-system-docs.ts` 仅在该端点的原生 Anthropic 请求发送前，把可识别的
  Pi SDK 内置 `<docs>` 索引替换为 README、docs、examples 路径和按需完整阅读指令。
  保留 Pi 身份、项目规则、技能、自定义提示、扩展附加规则、缓存字段及所有会话历史。
- 通过现有请求兼容钩子覆盖普通会话、重新打开的旧会话、reload 和子代理；
  自定义 Chat-only 提示及其他端点不应被改写。不得改成伪装 Claude Code 客户端。
- 构建前的 `npm run test:models` 和 `-SkipBuild` 必须包含系统文档回归；
  `test:billion-context` 及打包后插件测试必须确认请求仍为按需文档形式。
- 升级 SDK 若改变内置索引结构，必须重新检查适配并验证实际工具调用；
  不得删除失败测试、清空历史、停用十亿上下文插件或恢复被拒绝的固定索引。

### 与十亿上下文插件共存

- 2026-10-16 已用实际安装的 `billion-context@0.1.197` 验证：原生 fetch 拦截、
  本地代理解析与序列化、压缩工具注册、历史工具 ID 配对和新工具调用可以共同工作。
- `npm run test:billion-context` 使用临时配置、临时代理状态和本地模拟模型，
  不读取用户对话，不修改用户的插件设置。可用 `PI_WEB_BILLION_CONTEXT_DIR`
  指定待测插件目录；默认读取全局 Pi 安装目录。
- 发布工作流安装固定版本插件并执行此测试。插件升级后需使用新版本重新验证，
  不可用停用插件替代兼容性修复。
- 打包后执行 `node scripts/verify-billion-context.mjs --app-dir <包目录>/app`，
  经实际编译后的 HTTP 服务复测，避免只验证源码却发布了旧构建。
- 此检查覆盖短历史请求路径，不代表已验证所有长上下文压缩阈值及摘要质量。

## 2026-10-16：重发旧消息保留当前模型

- 同一对话切换模型后，编辑/重发旧用户消息必须使用当前选择的模型及思考档位。
- 重发导航会回到旧消息之前，不能因此丢失后续的 `model_change` 选择记录。
  `navigate_tree` 的 `preserveModel: true` 在导航成功后，将当前模型写到新分支，
  再恢复当前思考档位；导航被取消时不写入。
- 此标记只用于编辑/重发；普通分支浏览保持原行为。
- 提供商报错或连接超时后再次重发、刷新或重开会话，仍必须保留当前选择。
- `lib/resend-model.integration.test.mjs` 用真实 SDK 验证失败、重开及后续成功请求；
  `hooks/resend-model.test.mjs` 验证浏览器编辑发送路径确实传入保留标记。
- 构建与 `-SkipBuild` 均须执行 `npm run test:models` 所包含的回归检查。
- 打包后执行 `node scripts/verify-resend-model.mjs <包目录>/app`，验证实际 HTTP
  路径在 400/504 后重发、刷新及进程重启仍保留选择，并能继续成功响应。

## 已有行为

- 保留 `scripts/patch-pi-retry.mjs` 的临时网关错误重试及其回归测试。
- 保留便携启动器的下载校验、失败回滚、运行中会话保护与更新后启动验证。
- 保留会话独立命名模型、地区标记和手动标题优先。
- 发布后的自动更新必须实际安装并启动新版，不能只检查更新发现。
  详见 `docs/portable-release.md`。
