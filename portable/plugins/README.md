# Pi Web 插件

便携版启动器 `Pi-Web-Portable.exe` 发现 `app\plugins\piweb-plugin-loader.cjs` 时，会通过 `NODE_OPTIONS=--require` 预加载它（源码在仓库 `portable/plugins`，打包时复制到 `app\plugins`）。
加载器做三件事：

1. 把 `web/*.js` 自动注入到 Pi Web 页面里（访问路径是 `/__piweb-plugins/<文件名>`）
2. 为 `server/<名字>/server.cjs` 启动一个后台子进程（随 Pi Web 一起启动和退出，崩溃后会自动重启）
3. 把 `/__piweb-plugins/ws/<名字>` 上的 WebSocket 请求转发给对应的后台子进程

它不修改 Pi Web 应用代码。

- 新增前端插件：把 `.js` 文件放进 `web/` 目录
- 停用前端插件：把文件改名成 `xxx.js.disabled`，或者在文件名前加 `_`
- 修改前端插件后刷新页面就能生效；新增或删除插件文件、修改 `server/` 或加载器后，要重启 Pi Web

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
