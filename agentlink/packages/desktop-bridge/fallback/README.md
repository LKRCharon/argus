# Argus App View

可选的单个 App 窗口转发组件。在 Windows 浏览器查看、点击并输入到 Mac 的 Codex 桌面 App，适合处理原生未发送草稿、附件和网页控制器尚未覆盖的操作。日常文本工作优先使用 [Desktop Web](../README.md)。

当前实现只操作 bundle ID `com.openai.codex` 的窗口，要求 macOS 14.2 或更新版本。使用 ScreenCaptureKit 截取窗口；最高配置为每秒 4 帧、宽度上限 1920。这是窗口画面流，流畅程度取决于画面大小和网络。

## 使用已经安装的组件

Mac 保持登录、唤醒且原 App 打开。Windows 运行 [Open-Mac-Window.cmd](windows/Open-Mac-Window.cmd)，打开 `http://127.0.0.1:18942/`。默认 SSH 别名为 `myten`，可用 PowerShell 的 `-Relay` 指定别名。

先点击“启用键鼠”，确认目标窗口和焦点。中文或长文本填入下方输入框，点击“输入到 Mac”；这一步只粘贴。“按 Enter”是单独动作，可能发送当前 Mac 输入框的内容。Ctrl 映射到 Mac 的 Command。浏览器失去焦点后关闭键鼠转发。

[Stop-Connection.cmd](windows/Stop-Connection.cmd) 停止 Windows 的窗口转发连接，不中断 Mac 的任务。

本次已实测窗口画面、鼠标定位、中文输入和回车发送，并据此补全用户指定项目里的原生草稿。无法承诺所有弹窗、窗口缩放状态或多显示器布局都已覆盖。

## 从源码构建

已经获得系统授权的已安装组件可以继续使用。更新 Desktop Web 无需重编译本组件。原生重新编译会改变临时签名，macOS 可能要求重新授予屏幕录制和辅助功能。

在 `agentlink` 中运行，输出目录必须不存在：

```bash
bun run packages/desktop-bridge/fallback/build.ts ./window-build
```

构建只生成 App 与网页资产，不替换已安装组件。首次安装可以将输出的 `ArgusAppView.app` 放到 `~/Applications/`，将输出 `web/` 的三个文件放到 `~/Library/Application Support/ArgusAppView/web/`，然后打开 App。在系统设置中给 **Argus App View** 授予屏幕录制、辅助功能；按系统要求退出并重新打开。组件不录制系统音频。

```bash
open ~/Applications/ArgusAppView.app
curl http://127.0.0.1:18942/api/status
```

首次应先在 Mac 检查有画面和输入，再配置网络。保留原 App 和现有聊天，无需修改 Codex 数据库。

## SSH 与启动

服务仅绑定 `127.0.0.1:18942`。在 Mac 使用单独的 SSH 反向转发：

```bash
ssh -NT -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -R 127.0.0.1:18942:127.0.0.1:18942 your-pinned-relay-alias
```

使用已核对主机公钥的别名与专用隧道密钥。中转账号的授权行可由 [relay-key.ts](../deploy/relay-key.ts) 加 `--with-viewer` 生成。Mac 窗口组件和这一条隧道需自行加入登录启动；Desktop Web 的安装器只管理 18943。

两个 SSH 连接在中转服务器终止，中转服务器属于受信任范围。请求检查精确回环 Host；输入操作另校验 Origin 和当前进程随机令牌。

`source/` 包含本项目编写的 Swift 组件和网页，`windows/` 包含 Windows 启动、监督重连和停止脚本。源码不包含机器密钥、用户截图或 Codex 原版前端。
