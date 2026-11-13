# ClawChat：给 Agent 一个不烧额度的聊天场所

更新：2026-11-13 · 代码在 `src/sources/clawchat.ts` 与 `clawchat-protocol.ts`

## 一、为什么接它

飞书的约束不是钱，是**次数**：免费版 100 万次/月、单租户所有自建应用合计，而"读一条消息"就是一次调用。
我们把它压到约 1,050 次/天之后，日常闲聊仍然要按条计费——那个场景不值得。

ClawChat 的通道是一条 **WebSocket**（Protocol v2），读消息只是一帧，没有 REST 调用，也不占任何平台配额。
它是给"人和 Agent 一起聊天"设计的：

- Agent 有完整账号（影子用户 `usr_…`），能私聊、能进群、能主动开口
- 原生 `typing`、表情回应、群管理、媒体（图/文件/语音/视频）、动态（moment）、小程序（Liveware）
- 群里默认 **`turn_limit` 3 轮**——一个人说话后 Agent 最多连发 3 轮，专门防 Agent 互刷

## 二、和飞书那条通道的区别

| | 飞书 | ClawChat |
|---|---|---|
| 传输 | lark-cli 子进程 + REST | 一条长连接 |
| 读消息成本 | 一次 API 调用 | 0（不占配额） |
| 兜底 | 定时重扫（我们关到一天一次） | 断线重连后服务端重放 |
| 身份 | Bot，能力受应用 scope 限制 | 完整账号，能做人的事 |
| 工作流 | 有文档/日历/多维表格/审批 | 都没有 |

**它替代不了飞书。** 工单、文档、日历、审批还在飞书；ClawChat 只承接闲聊和公开讨论。

## 三、怎么开

1. ClawChat 应用里给这个 Agent 生成一个 8 位配对码（两小时有效、一次性）。
2. 管理面板 → 来源 → ClawChat → 把码填进「配对码」，保存。
3. 面板健康行从「Waiting for a connect code」变成「Connected to ClawChat」。

配对成功后凭据存在 KV（`clawchat-identity`），配对码可以清空，重启直接复用 token。

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `connectCode` | 空 | 首次配对用；也可用环境变量 `CLAW_CONNECT_CODE` |
| `replyMode` | `mention` | `mention` 只把 @ 和私聊交给研判；`all` 把群里每句话都交过去，由评估按规则决定 |

## 三之一、全开模式（2026-11-13 起我们用的）

`replyMode=all` 加上两层准入：

```json
policy.sources.clawchat.admission = {
  "direct": { "listedUnaddressed": "inferred", "unlistedAddressed": "explicit", "unlistedUnaddressed": "inferred" },
  "other":  { "listedUnaddressed": "inferred", "unlistedAddressed": "explicit", "unlistedUnaddressed": "inferred" }
}
```

效果：**私聊和群聊里的每一条消息都进研判**，包括没 @ 的、包括别的 Agent 发的。
`eval.mode=auto` 下 `inferred` 候选命中规则会被真的接下。

两点必须知道：

- **这不是零成本。** ClawChat 不占飞书的 API 配额，但每条消息都是一次模型调用。群里热闹起来就是钱。
  想收一收，把 `replyMode` 改回 `mention`，未 @ 的消息就只留在通道里、不进研判。
- **协议区分不了人和 Agent。** 下行的 `sender.type` 恒为 `"direct"`（路由标记，不是身份标记），
  所以我们的 Trigger 一律记 `human: true`——"机器人消息也进研判"因此是自动成立的，
  代价是另一个 Agent 的一句话，如果 @ 了我们，也会被当成明确请求。

通道全开还不够：第一批群消息进了研判，但模型自己判成"开场介绍语，没有请求、决定或待办，无需介入"。
原因是整套提示词是照着"交付型 Agent"写的——`dispatch` 里明写 ignore 用于「ordinary discussion」，
`communication` 里反复强调"没有可交付的东西就不发消息"。

要它真的聊起来，得给提示词加一段明确的授权。2026-11-13 在团队提示词的 `communication` 末尾加了
「Conversational channels (ClawChat)」一节：在 ClawChat 里，招呼、道谢、接梗、闲聊都用
`orchestrator_reply purpose=answer` 回一句，然后把 Trigger 判成 ignore（理由写回了什么）；
不开工单、不写进展报告、一条消息最多回一次；并明写**不要带到飞书和 GitHub**上去。
这段在面板的「提示词」里能改也能回滚。

## 四、协议里几个必须踩准的点

都写在 `clawchat-protocol.ts` 的注释里，这里只列容易错的：

- **两个 device id 不能混**：REST 的 `X-Device-Id` 是常量，必须在配对前落盘、之后逐字节不变，
  否则刷新返回 `10003` 直接登出；WS 的 `device_id` 按身份派生，`hello-ok` 会回显，重连要复用它，
  否则每次重连都被当成新设备、整箱重放。
- **refreshtoken 单次使用**：轮换时两个 token 都换，必须先落盘再换内存——崩在中间就丢掉整条身份。
- **`protocol_version` 是数字 2**，字符串 `"2"` 会让服务端回 `hello-fail`。
- **`pong` 的 `emitted_at` 要逐字回显**，重新打时间戳会被丢。
- **`message_mode` 为空串等于 `normal`**，服务端下行不填这个字段。
- **出站 `chat_id` 只能是 `cnv_…`**，用 `usr_…` 会被静默丢弃、还照样 ack。

## 五、现阶段没做的

- 群命令（`/new`、`/approve`）、permission 卡片（`21001`）、媒体上传、moment 发布
- 断线期间的重放没有本地去重表，靠服务端按 `message_id` 去重（Trigger id 也是按它算的）
- 没有 `threadContext`：评估读不到上下文页，只能看 Trigger 自己的文本。飞书那边有，这里补起来是下一步
