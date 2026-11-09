# 表情回复（Emoji reactions）

> 状态：**工作回执 + 模型挑表情已上线**；**社交反应（L1）已实现，`observe` 观察中**（2026-11-09）。
> 代码：`src/core/replies.ts`、`src/app/marks.ts`、`src/sources/feishu-channel.ts`、`src/feishu-emojis.ts`。

## 为什么做这件事

团队 Agent 的价值是"少占注意力、多给结果"，所以它说话很少——754 次研判里 642 次是 ignore。但"不说话"不等于"不在场"：一个真人同事看到你干成了事，会点个头、鼓个掌，这不是打扰，是**存在感**。

关键的成本判断：**一个表情的成本是一个像素，不是一段注意力**。因此表情可以用比发言宽松得多的标准来发。

---

## 一、已实现

### 1. 工作回执（mark）

| 时机 | 效果 |
|---|---|
| 明确请求被接单（`@` 或私聊，`strength: explicit`） | 在那条消息上贴表情，排在文字确认之前 |
| 工单接下的一条追问（扇出或 attach） | 在**追问的那条消息**上贴 |
| 工单结束 `completed` / `merged` | 每条标记消息：删掉旧表情 → 贴 `DONE` |
| 工单结束 `stopped` / `dropped` / `closed` | 删掉标记，不留痕 |
| 结束的工单被追问唤醒 | 每条标记消息：删 `DONE` → 贴回处理中 |
| 推断接单（群里没人 @，它自己判断） | **不贴**（没人问它，表情会像插话） |

实现要点：

- 工单上记 `marks: string[]`（它接下并标记过的消息），所以"全部一起变"是查得到的，不是猜的；
- 每次标记的 id 由 trigger 派生（`key('react', triggerId)`），幂等，重启不重复；
- **失败只试一次**：贴不上就记 `failed` 放弃，绝不把排队在后面的文字回复挡住；
- 回执里存下了实际贴出的 `emoji`，面板与排查都看得到。

### 2. 表情由模型挑

- 词表：飞书全部 **182 个表情**，每个带中文语义和"是否适合工作场合"（`src/feishu-emojis.ts`）；
- 模型：Cloudflare Workers AI 的 `clef-flash`（决策模型，System One 协议），一次请求、一个 `choice` 问题；
- 输入：消息原文、工单标题与范围、**本轮研判的 decision 与理由**、线程最近 5 条；
- 输出：`{ emoji, tone, confidence }`；返回不在 182 个白名单里的值一律拒绝；
- 成本：约 4k 输入 token/次，免费额度（10k neurons/天 ≈ 120 万 token）约可跑 300 次/天；
- 兜底：没配账号 → `paused`；超时（4 s）/失败/非法值 → 静默回退固定 `OnIt`；`marks` health 记录最后一次选择。

### 3. 配置与运维

```bash
# 服务读取（systemd EnvironmentFile，600 权限，不进仓库）
~/.dsh/feishu-marks.env
  CLOUDFLARE_ACCOUNT_ID=...
  CLOUDFLARE_WORKERS_AI_API_KEY=...
```

```bash
# 看最近贴了什么
python3 - <<'EOF'
import json, sqlite3
c = sqlite3.connect('file:/home/iflinkteam/.dsh/state/superagent/orchestrator.sqlite?mode=ro', uri=True)
for (v,) in c.execute("select value from outbox"):
    d = json.loads(v)
    if d['kind'] == 'reaction': print(d.get('reaction'), d['status'], d.get('emoji') or '(Channel 默认)', d['channel']['address']['messageId'])
EOF
```

`GET state` 的 `health.marks` 会写"Picked <表情> for <trigger id>; <tokens>"。

---

## 二、TODO

### L1 社交反应（已实现，`observe` 观察中）

**已落地**：第五种 Decision `react`（带 `score` + `intent`）、`policy.gestures.mode`（off/observe/auto）、
预算与冷却（`src/app/gestures.ts`：同一人 30 分钟、每群每小时 2 个）、MarkPicker 按 intent 收窄表情池、
`colleague-gesture` 规则已写入线上 Policy（`mode: observe`）。

**待做**：面板展示 `react` 与拒绝原因（现在只在决策列表里看得到流水）；观察期结束后切 `auto`。

**判定方式**：不再用"命中/不命中规则"，改成给每条消息打 **0–5 社交分** + 一个 **intent**，与现有研判同一次调用完成。

| 分 | 什么样 | 处理 |
|---|---|---|
| 5 | 情绪高光：报喜、突破、翻车名场面、被夸、离谱需求 | 立刻贴 |
| 4 | 有社交意味：道谢、加油、共情、接梗、自嘲、告别、深夜加班 | 立刻贴 |
| 3 | 略有味道：日常进度、有人答完了、轻微吐槽 | 预算富余才贴 |
| 2 | 普通闲聊、信息同步 | 不贴 |
| 1 | 机器人/CI 通知 | 不贴 |
| 0 | 严肃、敏感、涉及钱/人事、隐私 | 永不贴 |

**intent（12 个）**：`celebrate` 报喜 · `applause` 夸赞 · `laugh` 好笑 · `comfort` 共情 · `hype` 加油 · `respect` 敬重 · `surprise` 惊讶 · `tease` 打趣 · `aww` 可爱 · `ouch` 翻车 · `thanks` 致意 · `agree` 认同。

**`agree` 的三条硬条件**（避免廉价附和）：① 消息里是一个观点或判断，不是事实同步；② 该判断与已确认的事实一致，能说出依据；③ 不是情绪化表态、不站队、不评价人。说不出依据就不给。

**关于它自己的聊天**（第五类，单列）：

| 群里在说 | intent | 例 |
|---|---|---|
| 夸它、谢它 | `thanks` / `aww` | `THANKS` `ROSE` `FINGERHEART` |
| 拿它开玩笑、怼它 | `tease` / `ouch` | `SMIRK` `WINK` `SWEAT` |
| 吐槽它做错了 | `ouch`（真有活要修则走工作，不走表情） | `SWEAT` `FACEPALM` |
| 别人在夸它、替它说话 | `respect` | `SALUTE` `HIGHFIVE` |
| 打听它是谁/接的什么模型 | `surprise` | `GLANCE` `EYES` `THINKING` |
| 把它和别的 AI 同事比、踩一捧一 | **不反应** | — |

护栏：不给自己贴、不刷好感（同线程每天 ≤1 次自指反应）、不抢功劳（功劳是别人的就给 `respect`）、不评价别的 AI 同事。

**节奏**：

- 每群每 **8 条消息**最多 1 个反应（热闹的群自然多露面）；
- 同一个人 30 分钟内不连贴；同一条消息只贴一次；同一个表情同群一天不超 2 次（逼它换花样）；
- 凌晨 1:00–7:00 不贴；
- **互斥**：自己发的、其他 bot 的、正在做的工单线程、明确 @ 它要干活的，都不走社交反应；有活 → 工作回执，没活有情绪 → 社交表情，都不是 → 安静。

**架构落点**（第五种 Decision）：

```
Eval 研判（同一次调用）
  → Decision: react { score, intent }
     → 预算/冷却通过 → Outbox 排 reaction(gesture) → MarkPicker 按 intent 挑表情
     → 不通过 → ignore(gestureBudget / gestureObserved)，面板可见
```

### L2 接梗一句话（暂不做）

在 L1 之上，极偶尔回一句 3–12 字的话（如"这需求我先笑一会儿"）。它是真发言，风险高一个量级，所以单独开关、单独 observe，每群 2 小时最多 1 句，只在 5 分场景。

### 其它待办

- [ ] 表情使用统计进面板（每天每群多少、最常用的 intent）；
- [ ] 群里回一句"别贴这个"能被记住（接进记忆/Skill 的复盘闭环）；
- [ ] GitHub 的 mark（`+1` / `eyes`）：接口留了 `react`，kind 还没实现。
