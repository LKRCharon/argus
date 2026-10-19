# 登录并控制多个设备

浏览器打开部署的 HTTPS 域名，用配置允许的 OJ 账号和原密码登录，再在左侧选择设备。每台设备有独立的项目、会话和浏览器草稿。发送、追加指令和停止始终交给该设备原 App 的会话所有者执行。

## 连接与登录

浏览器通过 HTTPS 连接受信任网关。Mac、Windows 分别用独立 SSH 密钥向网关建立仅监听回环地址的反向隧道。网关按固定设备配置代理 HTTP 和 WebSocket，绝不把任意浏览器参数当作上游地址。

网关只读使用 OJ `users.json` 的 PBKDF2-SHA256 校验值：600000 次迭代、32 字节结果；额外要求 `allowedUsers` 白名单。不会改变 OJ 密码、会话或进度，也不会复制、存储明文密码。Cookie 使用 HttpOnly、Secure、SameSite=Strict 和 12 小时有效期，服务内只保留 token 的摘要。退出、超时、密码校验文件变化或网关重启使会话失效；已经打开的实时连接也会被关闭。

登录每个来源最多失败 8 次/15 分钟，全局每分钟最多 64 次尝试，同时最多执行 4 个密码派生任务。登录接口验证精确 Origin；其余写请求继续验证原生桥接 token，退出另需当前登录会话的 CSRF token。浏览器的 Cookie 不会转发给设备。

`basePath` 使用至少 20 个随机字节生成，作为登录后的私有路径；它是额外隐藏层。真正的传输加密由 HTTPS 和 SSH 提供。HTTPS 在 Cloudflare/网关终止，SSH 在受信任网关终止，因此网关可以看到转发数据；这不是浏览器到设备的端到端加密。真实随机路径、密码校验文件、运行数据库、SSH 私钥都不应提交到 Git。

## 安装 Windows 受控端

需要已登录的 Windows Codex App、Bun、Windows OpenSSH，以及预先登记到网关的专用隧道密钥和已核对的 `known_hosts`。Windows IPC 使用命名管道 `\\.\pipe\codex-ipc`，目录读取使用桌面 App 安装的原生 CLI。明确选择未加载的会话时，通过系统注册的 `codex://threads/ID` 打开原 App。不会停止或替换原 App。

在 `agentlink` 目录构建后安装：

```powershell
bun install --frozen-lockfile
bun run desktop:build
$hostSsh = Join-Path $env:LOCALAPPDATA 'ArgusDesktopHost/ssh'
bun run packages/desktop-bridge/deploy/install-windows.ts --target argus-desktop-win@myten --key "$hostSsh/myten_ed25519" --known-hosts "$hostSsh/known_hosts"
```

安装器把独立版本复制到 `%LOCALAPPDATA%/ArgusDesktopHost/releases`，保留投递数据库，并创建当前用户的登录启动快捷方式。它在后台监督桥接与专用隧道，失败后退避重连；原有只用于浏览 Mac 的本地隧道仍独立运行。监听本机和网关的 `127.0.0.1:18944`。

```powershell
$control = Join-Path $env:LOCALAPPDATA 'ArgusDesktopHost/host-control.ts'
bun $control status
bun $control stop
bun $control start
```

停止只作用于监督进程自己启动的桥接、目录读取进程和 SSH 子进程。日志保存在 `logs/supervisor.log`，最大约 5 MiB，保留一份旧日志。升级时运行安装器替换 `current.json`；回退时先停止，把 `current.json` 指向保留的旧 release，再启动。保留 `state/delivery.sqlite*`，不重置原 App。

SSH 服务端应为专用账号配置 `AllowTcpForwarding remote`、`PermitListen 127.0.0.1:18944`、`PermitOpen none`、`GatewayPorts no`、`MaxSessions 0`，禁止密码、PTY、agent 转发。公钥再用 `restrict,port-forwarding,permitlisten="127.0.0.1:18944",command="/usr/sbin/nologin"` 限制。`PermitOpen none` 属于 sshd 配置，不能写成公钥的 `permitopen="none"`。

## 安装网关

在 Linux 网关创建私有目录，将 [配置示例](../deploy/gateway.config.example.json) 复制为 `~/argus-desktop-gateway/config.json`，设置真实 HTTPS origin、已存在的 OJ 校验文件、白名单和固定回环上游。随机路径可用下面的命令生成，结果仅写入私有配置：

```bash
umask 077
bun -e 'console.log("/r/" + require("node:crypto").randomBytes(24).toString("hex"))'
```

在经过验证的源码 `agentlink` 目录运行：

```bash
bun install --frozen-lockfile
bun run desktop:build
bun run packages/desktop-bridge/deploy/install-gateway.ts
```

将 [systemd 示例](../deploy/argus-desktop-gateway.service.example) 安装为服务，核对用户名、Bun 路径后启用。将 [Nginx 示例](../deploy/gateway.nginx.conf.example) 放到现有 sites include 中，替换域名和证书位置。先执行当前 Nginx 实例的 `nginx -t`，成功后仅 reload；网关监听 `127.0.0.1:18945`，不公开任何设备端口。

如果使用 Cloudflare，Nginx 仅信任官方公布的代理网段的 `CF-Connecting-IP`，再覆盖网关的 `X-Real-IP`。不要无条件信任来自公网的客户端 IP 头。公网站点关闭访问日志，避免记录随机路径；错误日志和会话正文也不应上传公开仓库。

升级运行安装器后仅重启 `argus-desktop-gateway.service`。旧 release 保留，回退可以重新指向旧 `current` 链接并重启该服务；登录会话会失效，原 App 的工作和 OJ 数据保持。停止公网入口只需停此服务或移除这一站点并 reload Nginx。

## 更新与故障检查

每台设备的 `/api/status` 返回安装提交、源码摘要、原 App 连通性和平台；公网状态接口同样需要登录。设备离线时仅提示该设备离线，可切换到其他设备。网页 401 会回到登录，403 写请求最多刷新一次原生 token，未知投递结果继续保留原编号，禁止自动重发。

原生补丁按顺序应用，每 40 ms 最多投影一次；客户端按动画帧渲染。投递观察使用已有消息编号的内存索引，历史消息不再逐条查询 SQLite。原生版本号与网页已发送版本号独立维护，合并更新不会破坏重连校验。WebSocket 双向缓冲有上限，慢连接关闭后重新获取快照。

Bun 1.3.14 的服务主动关闭 WebSocket 可能留下内部连接计数，最小独立程序亦可重现。网关先关闭/终止连接与监听，再为排空 Promise 设置 250 ms 上限，避免服务重启挂住。会话过期和退出会立即撤销访问权限，测试同时检查 HTTP 拒绝与已开连接关闭。

数据模式仍不包含原生未发送草稿、附件上传、内嵌浏览器和全部复杂交互；这些使用目标设备原窗口。Mac 已授权窗口组件不随网页更新而重编译。

官方背景：[Windows 原生支持](https://developers.openai.com/codex/windows/)、[App Server](https://developers.openai.com/codex/app-server)。桌面 follower 协议属于版本适配，需用实际 App 复验。
