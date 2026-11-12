# Pi Web 插件

便携版启动器（Windows 是 `Pi-Web-Portable.exe`，macOS 是 `Pi Web.command`）发现 `app/plugins/piweb-plugin-loader.cjs` 时，会通过 `NODE_OPTIONS=--require` 预加载它（源码在仓库 `portable/plugins`，打包时复制到 `app/plugins`）。
加载器做四件事：

1. 把 `web/*.js` 自动注入到 Pi Web 页面里（访问路径是 `/__piweb-plugins/<文件名>`）
2. 为 `server/<名字>/server.cjs` 启动一个后台子进程（随 Pi Web 一起启动和退出，崩溃后会自动重启）
3. 把 `/__piweb-plugins/ws/<名字>` 上的 WebSocket 请求转发给对应的后台子进程
4. 把 `/__piweb-plugins/api/<名字>/...` 上的 HTTP 请求转发给对应的后台子进程（只接受同源请求；设了 `PI_WEB_PASSWORD` 时非本机访问要先登录）

它不修改 Pi Web 应用代码。

- 新增前端插件：把 `.js` 文件放进 `web/` 目录
- 停用前端插件：把文件改名成 `xxx.js.disabled`，或者在文件名前加 `_`
- 修改前端插件后刷新页面就能生效；新增或删除插件文件、修改 `server/` 或加载器后，要重启 Pi Web

## 模型自动检测：Pi Web 模型设置页 + server/model-health + model-health-ui.js

功能直接做在 Pi Web 原有的模型设置页面里（`components/ModelsConfig.tsx`、`components/model-auto-check.ts`、`components/ModelAutoCheckUi.tsx`），没有另外的弹框。新建和编辑 Provider 用的是同一个页面，所以两种情况都生效：

- **Provider 页面**：打开就自动拉全部模型、对已添加的每个模型实际调用一次（每个只花几个 token，同时 3 个）。改 URL、Key、API、Headers 后停手 0.8 秒再测一遍。页面开着时每 60 秒刷新模型列表，新出现的标「新」并排在最前
  - 顶部一行显示结果：连接是否正常、上游有几个模型、已添加的模型几个可用，旁边「立即检测」
  - 拉不到模型列表时，在 API Key 下方显示具体原因：URL 格式、域名解析不到、连接被拒、超时、证书、Key 无效（401）、余额不足、没权限（403）、路径不对（404）、填成了官网（返回网页）等，以及服务商原话和试过的地址
  - 「已添加的模型」列表：每个模型 ✓ 耗时，或 ✗ 原因（悬停看详情，点 ✗ 重测）
  - **自动修正**：现在填的接口调用失败、换一种接口类型或 URL 写法（带不带 `/v1`）能调通时，自动改好并保存；所有模型都要同样改时改 Provider 的「API」栏，否则只给那几个模型单独设置 `api` / `baseUrl`。页面上一行字说明改了什么，可「撤销」（撤销后不再自动改，直到你改了连接设置）
  - 模型列表里勾选的模型自动实际调用，**只有通过的能添加**；按钮「添加 N 个通过的模型并保存」直接写入 models.json，并在启用列表是自定义范围时把它们打开。参数套用 models.json 里同名模型或同系列（Claude / GPT / Gemini）最新模型的预设
  - 新建的 Provider（`new-provider`）拉到模型后，名称自动按域名起（`api.chiyi.cc` → `chiyi`）
- **模型页面**：打开就实际调用一次（之后每次编辑停手 0.8 秒再测），显示 ✓ 耗时或具体失败原因；接口填错时同样自动修正并保存，可撤销
- 测试结果都存进 `~/.pi/agent/model-health.json`（只记录和已保存配置一致的那次测试），左栏小圆点和右上角提醒马上更新
- 后台服务 `server/model-health` 每 10 分钟拉一次每个已启用 Provider 的模型列表（不花 token），每 6 小时对每个已启用模型真实调用一次
- `web/model-health-ui.js` 负责页面上的提醒：
  - 模型设置左栏：Provider 和模型旁的小圆点（绿/黄/红），悬停看原因和检测时间；底部有「立即检测」
  - 上游出现新模型：左栏顶部提示「有 N 个新模型可添加」，点「查看」打开那个 Provider 的页面并勾好这些模型，「忽略」不再提示
  - Provider 变成失败：右上角一行小字，不会自动消失，点 × 关闭；恢复正常后自动消失
- 服务没运行时（比如普通 pi-web 安装），页面退回 Pi Web 自带的拉取 / 测试接口，报错没那么具体，也不会自动修正
- 环境变量 `PIWEB_HEALTH_CONN_MINUTES`、`PIWEB_HEALTH_CALL_MINUTES` 可改检测间隔；localStorage `piweb.health.alerts=off` 不显示右上角提醒

### 中转余额

- 用模型的同一个 Key 查余额，不花额度；自动识别 Sub2API（`/v1/usage`）、New API / One API（`/api/usage/token`）、OpenAI 账单接口，以及 OpenRouter、DeepSeek、Moonshot、SiliconFlow。查不到时显示「这个服务商不支持查余额」
- 金额单位跟着接口走（$、¥ 或写明单位）
- **对话页面**：输入框下方当前模型旁显示「供应商 · 余额」，悬停看今日 / 累计花费，点击刷新，每次回复结束自动刷新
- **Provider 页面**：状态行下一行余额、今日、累计；「明细」里看近 7 天每天花费、各模型用量，并可改提醒线
- **模型设置左栏**：Provider 名旁小字余额，欠费红色、低于提醒线橙色；同一账户的几个 Provider 标 ↔
- 余额低于提醒线（默认 5）时右上角一行小字，不会自动消失；同一账户只出一条；充值后自动消失
- 后台每 10 分钟随连通性检测查一次；结果存 `~/.pi/agent/model-health.json`

## voice-input.js 长按语音输入

- 在聊天输入框上按住鼠标左键约 0.45 秒，看到红点后开始说话
- **边说边出字**：说的话会实时写进输入框里，后面的话可能会修正前面几个字
- 松开结束（会多录 0.3 秒，避免最后一个字被截掉）；按 Esc 取消，这次说的字会被撤掉
- 只是点一下，或者按下后拖动选择文字，都不会触发录音
- **按住 Alt 再长按输入框**：选择用哪个麦克风。每个麦克风旁边有实时音量条，对着说话时哪条在动就选哪个。选择会保存下来
- 识别引擎：本机离线识别（`server/voice-asr`），不联网、不上传声音，支持中文、英文、中英混说，自动加标点
  - 本地识别服务没运行时，会自动改用 Edge 在线识别（气泡下方会显示当前用的是哪一种）
- 设置项（在 DevTools 控制台执行，保存在 localStorage）：
  - `localStorage.setItem('piweb.voice.holdMs','600')`：长按多久开始录音，单位毫秒
  - `localStorage.setItem('piweb.voice.engine','edge')`：强制使用 Edge 在线识别（删除这个设置就恢复本地识别）
  - `localStorage.setItem('piweb.voice.lang','en-US')`：Edge 在线识别的语言，默认 `zh-CN`（本地识别自动识别中英文）
  - `localStorage.setItem('piweb.voice.disabled','1')`：关闭这个插件
- 每次使用都会记录到便携包目录下的 `logs\voice-input.log`，方便排查问题

## server/voice-asr 本地语音识别服务

- 引擎：[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（k2-fsa，Apache-2.0），npm 包 `sherpa-onnx-node`
- 模型：`models/sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05`
  （X-ASR 中英流式模型，带标点，int8，约 160 MB），纯 CPU 运行，识别速度大约是说话速度的 10 倍
- 只接受本机页面（127.0.0.1 / localhost）发起的连接
- 环境变量：`PIWEB_ASR_MODEL`（`models/` 下的目录名，用来换模型）、`PIWEB_ASR_THREADS`（默认 2）
- 换模型：从 https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models 下载 `*streaming-zipformer*` 模型，
  解压到 `models/` 目录（打包时由 `scripts/build-portable.ps1` 自动下载默认模型并校验 SHA256）。`160ms` 版本出字更快，但识别准确率比 `480ms` 版本低一些
