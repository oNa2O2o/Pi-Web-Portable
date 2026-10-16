# 本地定制与升级保留要求

合并上游、升级 Pi SDK、重新安装依赖和制作便携包时，必须保留这里列出的行为。
不能用“上游代码已更新”作为删除修复的理由。只有替代实现通过相同回归测试后，
才可以移除旧实现。

## 2026-10-16：Claude 跨模型工具历史兼容

- 词易 Claude 使用原生 `anthropic-messages`；不要改回 OpenAI 协议。
- Gemini/GPT 通过 OpenAI 接口生成的历史工具 ID 可能以 `call_` 开头。
  `api.chiyi.cc` 会拒绝这些 ID，即使请求本身已经使用 Anthropic `/v1/messages`。
- `lib/anthropic-tool-ids.ts` 在发送请求前，将该端点的外来工具 ID 映射为稳定、
  不冲突的 `toolu_` ID，同时更新配对的 `tool_result.tool_use_id`。
- 保留原始会话 JSONL、工具参数、正文和原生 `toolu_` ID；禁止批量改写或删除历史。
- 普通会话、Chat only 和子代理均需加载此兼容处理；其他协议和端点保持原行为。
- 不可只看“模型连接测试通过”：必须测试带工具历史的继续对话及后续工具调用。

升级与打包前必须运行：

```powershell
npm run test:anthropic-tool-ids
```

此检查必须保留在构建命令及发布工作流中。若新版 SDK 改变请求结构或扩展钩子，
先修复适配并通过测试，再生成发布包。不得跳过失败检查继续发布。
`build-portable.ps1 -SkipBuild` 也必须运行该检查，不能因为复用构建产物而绕过。

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

## 已有行为

- 保留 `scripts/patch-pi-retry.mjs` 的临时网关错误重试及其回归测试。
- 保留便携启动器的下载校验、失败回滚、运行中会话保护与更新后启动验证。
- 保留会话独立命名模型、地区标记和手动标题优先。
- 发布后的自动更新必须实际安装并启动新版，不能只检查更新发现。
  详见 `docs/portable-release.md`。
