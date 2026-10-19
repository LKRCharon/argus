# 桌面协议适配

本文件描述独立实现的互操作约定。没有包含原 App 的前端 bundle、提取代码、私有会话样本或认证信息。官方 app-server 文档：[结构化接口](https://developers.openai.com/codex/app-server)、[远程连接](https://developers.openai.com/codex/remote-connections)。桌面 follower IPC 来自当前已安装版本的本机兼容性验证，不能据此视作官方稳定接口。

## 建立 follower 连接

默认连接当前用户的 `~/.codex/ipc/ipc.sock`，验证 socket 和父目录的所有者及目录权限。每帧为四字节小端 UTF-8 JSON 字节数，后跟 JSON 数据；按字节处理分片，最大 64 MiB。

先发送版本 0 的 `initialize`，参数为 `{clientType:"argus-desktop-web"}`，使用返回的 `clientId`。客户端对所有所有权探测明确回答 `canHandle:false`，不成为会话 owner。

| 方法 | 版本 | 用途 |
| --- | --- | --- |
| `thread-owner-discovery` | 1 | 找到现有桌面会话所有者 |
| `thread-follower-start-turn` | 2 | 原 App 发起回合 |
| `thread-follower-steer-turn` | 1 | 追加指令 |
| `thread-follower-interrupt-turn` | 4 | 停止指定回合 |
| `thread-follower-read-model-settings` | 1 | 读取原 App 模型设置 |
| `thread-follower-command-approval-decision` | 1 | 命令审批 |
| `thread-follower-file-approval-decision` | 1 | 文件审批 |
| `thread-stream-following-changed` | 1 | 订阅广播 |
| `thread-stream-state-changed` | 11 | 桌面快照/补丁广播 |

写请求固定指向探测返回的 `handledByClientId`，不用后来的其他客户端替代 owner。

## 发送文本

`thread-follower-start-turn` 的核心参数：

```json
{
  "conversationId": "目标会话 UUID",
  "turnStart": {
    "request": {
      "threadId": "目标会话 UUID",
      "input": [{"type":"text","text":"用户输入","text_elements":[]}],
      "clientUserMessageId": "唯一消息编号",
      "turnTrigger": "composer"
    },
    "context": {"inheritThreadSettings":true,"attachments":[],"commentAttachments":[]}
  }
}
```

`text_elements:[]` 必须显式给出。桌面乐观渲染会先读取它，不能依赖 app-server 后续补默认值。最初的隔离测试曾因漏掉此字段出现桌面渲染错误；修正后在新的独立测试会话验证通过。

停止包含 `conversationId`、`expectedTurnId` 与 `mode:"user-stop"`，避免意外停止后来开始的回合。所有审批均来自用户的明确按钮操作。

追加指令还必须传 `attachments:[]` 和 `restoreMessage`。后者提供输入文本及 `context`，包含空的附件、评论附件数组；工作目录与模型沿用原线程。遗漏 `restoreMessage` 时此版本会在读取 `cwd` 前报错。显示模型同时处理原生 `steeringUserMessage` 与服务器确认后的 `userMessage`，按消息编号消除重复；仅乐观显示的追加指令不作为已投递证据。

## 增量状态

订阅参数为 `{conversationId,hostId:"local",following:true}`。接收的 `change` 可以是 `snapshot` 或 `patches`，校验会话 ID、owner、基础 revision 和新 revision；不连续时重新订阅。只支持数据补丁，拒绝原型路径。

当前版本可能将回合放在 canonical history 中：`turnHistory.history.entitiesByKey` 保存实体，`islands[].entries[].value` 保存顺序。适配后只向网页发送会话正文和可见活动，不转发开发者指令或原始内部日志元数据。浏览器接收的是独立的显示模型补丁，长文本增长使用 `append`。

## 实测依据与处理路径

| 证据 | 发现 | 实现路径 |
| --- | --- | --- |
| 原 App 同一会话显示外部发起的文本和回复 | follower 可驱动原会话 owner | `bridge.ts` 的 owner 定向请求 |
| 快照后连续收到 revision 补丁 | 无需持续传屏幕 | `state.ts` 与 WebSocket |
| 本机项目目录有两套项目 ID | 只用新项目筛选会漏掉原会话 | `projects.ts` 只读兼容映射 |
| 新空会话尚无可列出的回合历史 | 先读历史会阻断新建 | 先交原 App 接管，再读历史 |
| journal 重启恢复及重复 ID 测试 | 超时不能自动再次执行 | `delivery.ts` 的持久状态 |

本适配器没有修改原 App、Codex 数据库或桌面兼容缓存。App 更新后若帧版本、输入形状或所有权机制改变，停止该版本的写操作并重新验证；不要通过直接改数据库来补偿。
