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

## model-quick-add.js 快速添加模型 + server/model-health 自动检测

- 模型设置里点「添加 Provider」：只填 Base URL 和 API Key，停手 0.8 秒后自动拉取全部模型（弹框开着时每 60 秒刷新，新出现的标「新」）
- 填错时显示具体原因：URL 格式、域名解析不到、连接被拒、超时、证书、Key 无效（401）、余额不足、没权限（403）、路径不对（404）、填成了官网（返回网页）等，并列出试过的地址
- 勾选的模型自动真实测试（每个只花几个 token，同时测 3 个），自动匹配接口类型（Claude 先试 Anthropic，GPT/Gemini 先试 Responses，再试 Chat Completions）和带不带 `/v1`；列表里显示 ✓ 耗时 或 ✗ 原因，点 ✗ 重测
- 只保存测试通过的模型；参数套用 `~/.pi/agent/models.json` 里同名模型或同系列最新模型的预设；同一个 URL+Key+接口已有 Provider 时直接加进去
- 底部「高级：手动配置」回到原版添加界面
- 后台服务每 10 分钟拉一次每个已启用 Provider 的模型列表（不花 token），每 6 小时对每个已启用模型真实调用一次；结果存在 `~/.pi/agent/model-health.json`
  - 模型设置左栏：Provider 和模型旁的小圆点（绿/黄/红），悬停看原因和检测时间；底部有「立即检测」
  - 上游出现新模型：左栏顶部提示「有 N 个新模型可添加」，点「查看」才添加，「忽略」不再提示
  - Provider 变成失败：右上角一行小字，不会自动消失，点 × 关闭；恢复正常后自动消失
- 环境变量 `PIWEB_HEALTH_CONN_MINUTES`、`PIWEB_HEALTH_CALL_MINUTES` 可改检测间隔
- 设置项（localStorage）：`piweb.quickadd.disabled=1` 关闭插件；`piweb.health.alerts=off` 不显示右上角提醒

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
