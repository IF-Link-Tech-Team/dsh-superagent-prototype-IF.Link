# Hermes Agent 记忆机制调研

> 调研对象：Nous Research 的 Hermes Agent（开源，MIT）。这份笔记解释它**怎么记、记多少、谁来写、什么时候整理**，最后落到我们 Team Agent 的 P1 方案上。
> 主要来源：Hermes 官方文档（`memory` / `skills` / `curator` / `sessions` / `context-files` / `configuration` 六页），以及社区对 Hermes 与 OpenClaw 的对比实测。

---

## 一、核心结论

Hermes 的记忆不是"把聊天记录存起来"，而是四件事各司其职：

| 层 | 载体 | 容量 | 何时进入模型 |
|---|---|---|---|
| **身份与规则** | `SOUL.md`、`AGENTS.md` | 每个文件上限 20,000 字符 | 会话开始注入；子目录的 `AGENTS.md` 随读取按需注入 |
| **长期记忆** | `MEMORY.md`（事实）+ `USER.md`（偏好） | **2,200 / 1,375 字符**（约 800 / 500 token） | 会话开始时**冻结快照**注入系统提示 |
| **历史归档** | SQLite `state.db` + FTS5 | 无上限 | 不注入，靠 `session_search` 现查 |
| **程序性记忆** | `~/.hermes/skills/` 下的 SKILL.md | 目录约 3k token | 只注入目录；用到才加载全文 |

两个数字最能说明它的设计取向：**常驻记忆总共只有约 1,300 token**，而历史会话一条都不常驻。它把"必须一直在眼前"和"需要时能翻到"彻底分开。

---

## 二、记忆文件怎么用

### 1. 会话开始：冻结快照

启动时把 `MEMORY.md` 和 `USER.md` 读进系统提示，渲染成这样：

```text
══════════════════════════════════════════════
MEMORY (your personal notes) [67% — 1,474/2,200 chars]
══════════════════════════════════════════════
User's project is a Rust web service at ~/code/myapi using Axum + SQLx
§
This machine runs Ubuntu 22.04, has Docker and Podman installed
```

三个细节值得抄：

- **带用量百分比**。模型每一轮都知道自己还剩多少空间，才有动力做合并。
- **条目用 `§` 分隔**，一条一个事实，便于按条替换。
- **冻结**：会话内写入立即落盘，但**本会话的系统提示不变**，下次会话才生效。原因很实际——保住前缀缓存，也避免上下文在同一轮里变来变去。工具返回值始终展示实时状态。

### 2. 写入：只有一个 `memory` 工具

| 动作 | 作用 |
|---|---|
| `add` | 新增一条 |
| `replace` | 按 `old_text` 唯一子串定位，替换整条 |
| `remove` | 按同样方式删除 |
| ~~`read`~~ | **没有**。内容已经在系统提示里 |

没有 `read` 这件事很关键：记忆不是"去查的知识库"，而是"此刻就在眼前的事实"。

### 3. 容量满了会怎样——这是最核心的一条规则

超限时工具直接**报错并把当前所有条目甩回给模型**：

```json
{ "success": false,
  "error": "Memory at 2,100/2,200 chars. Adding this entry (250 chars) would exceed the limit. Replace or remove existing entries first.",
  "current_entries": ["..."], "usage": "2,100/2,200" }
```

模型必须自己判断哪条过时、哪两条能合并，腾出空间再写。这就是所谓的**容量倒逼提纯**：上限不是为了省 token，而是强制一次"我到底该记住什么"的判断。文档的建议是：**超过 80% 就开始整理**，别等到撞墙。

### 4. 写什么、不写什么

| 该写 | 不该写 |
|---|---|
| 用户偏好、纠正（"别用 sudo 跑 docker"） | 一次性的临时路径、调试上下文 |
| 环境事实、约定（"用 tabs，120 列"） | 能随时搜到的公共知识 |
| 做过的关键动作（"1/15 把库从 MySQL 迁到 PG"） | 大段代码、日志、表格 |
| 踩坑得到的可用做法 | `SOUL.md` / `AGENTS.md` 里已有的内容 |

另外两条工程保护：**精确重复会被拒绝**；写入前做**注入与凭据外泄扫描**（匹配提示注入、SSH 后门、不可见 Unicode 等内容直接拦掉）——因为记忆会被注入系统提示，等于半个指令通道。

---

## 三、谁来写记忆：三个触发器

这是"Review Agent"这个概念的真正来源。Hermes 里没有叫 Review Agent 的组件，但有三条同构的机制，都是**后台分叉一个 `AIAgent`**（独立 prompt 缓存，不碰当前对话）：

### 1. 周期性 nudge（记忆自省）

固定间隔扫描最近行为，自问"有什么值得长期留下"。不需要用户开口。这是它区别于普通 agent 的地方——记忆维护是 agent 自己的事，不是用户的负担。

### 2. Curator（技能维护，形同"Review Agent"）

专门维护 **agent 自己创建的技能**，防止越攒越多、互相重复。触发条件是两个门槛同时满足：

```text
距上次运行 ≥ interval_hours（默认 168 小时 = 7 天）
且  agent 空闲 ≥ min_idle_hours（默认 2 小时）
```

一次运行分两段：

| 阶段 | 谁做 | 干什么 |
|---|---|---|
| 自动迁移 | 确定性规则，无 LLM | 30 天没用 → `stale`；90 天没用 → 移入 `.archive/` |
| LLM 复审 | 一次辅助模型调用 | 逐条决定保留 / patch / 合并 / 归档 |

工程上的四个约束，比机制本身更值得学：

- **永不删除**，最狠只是归档，可恢复；
- **永不碰**内置技能和 Hub 装来的技能，只管 agent 自己写的；
- 每次真跑之前**打 tar.gz 快照**，一条 `hermes curator rollback` 就能整体回滚；
- 支持 `pin`（永久保护）、`pause`、`--dry-run`（只出报告不改动）。

### 3. Session search（按需回忆）

历史会话语料进 SQLite + FTS5，`session_search` 命中的消息再交给一个快速小模型**总结后**注入。也就是说：**历史本来不占上下文，只在被问到时花一次检索 + 一次总结的代价。**

FTS5 是关键词检索，不是语义检索。Hermes 官方也承认长尾表述会召回不到，这是它刻意接受的成本取舍（不引向量库）。

---

### 3'. 补充：周期机制是按轮次，不按日历

常有人问「它会不会每天/每周写日记」，答案是不会。Hermes **没有任何按日历触发的记忆写入**，全部由轮次或空闲事件驱动：

| 机制 | 触发条件 | 跑在哪 | 写什么 |
|---|---|---|---|
| **记忆 nudge** | 每 `nudge_interval` 轮（默认 **10**） | 后台分叉，输出 `💾 Self-improvement review:` | 最近对话里的纠正、约定、经验 → `MEMORY.md` / `USER.md` 或技能 |
| **退出 flush** | 会话结束/压缩前，且轮数 ≥ `flush_min_turns`（默认 **6**） | 同一次退出流程 | 把还没落盘的东西补写进去 |
| **技能 nudge** | 每 `creation_nudge_interval` 次工具调用（默认 **15**） | 后台分叉 | 把这次的做法沉淀成 SKILL.md |
| **Curator** | 距上次 ≥ 7 天 **且** 空闲 ≥ 2 小时 | 后台分叉 | 只维护技能（标记 stale、归档），**不碰记忆** |

配置项都在 `config.yaml` 的 `memory:` 下：

```yaml
memory:
  nudge_interval: 10      # 每 10 轮提醒一次保存记忆，想更积极就调到 5
  flush_min_turns: 6      # 不满 6 轮的会话退出时不 flush
creation_nudge_interval: 15  # 每 15 次工具调用触发一次技能回顾
```

**这套机制在消息网关场景会失效。** 官方 issue #22357（已关闭）记录：网关每条消息新建一个 `AIAgent` 对象，计数器 `_turns_since_memory` 每轮从 0 开始，`nudge_interval` 可能永远到不了——表现为「Self-improvement review 再也不出现，重要的纠正没被保存」。这说明按轮次计数的周期机制，在长期在线、多入口的 agent 上很脆。

**真正按日历写日记的是 OpenClaw，不是 Hermes**：OpenClaw 用 `memory/YYYY-MM-DD.md` 每日追加原始日志，再在夜间/压缩前合并进 `MEMORY.md`。两者常被混为一谈。

## 四、技能 = 程序性记忆

与事实记忆并列的另一半。当任务满足下面任一条件，就值得写成一个 skill：

- 复杂任务（5+ 次工具调用）成功完成；
- 踩过错、试过错，最后找到了正确路径；
- 用户纠正过它的做法；
- 发现了一条不显然的流程。

写入用 `skill_manage`，四个动作里 **`patch`（old_string → new_string）是首选**，因为只有改动部分进 token，比整篇 `edit` 便宜得多。

加载采用**渐进披露**，三级：

```text
Level 0  skills_list()             → 名称 + 描述，约 3k token
Level 1  skill_view(name)          → 全文
Level 2  skill_view(name, path)    → 具体引用文件
```

---

## 五、社区实测出来的坑

比官方文档更有用的部分：

| 坑 | 表现 | 对策 |
|---|---|---|
| **过期但可信** | 记忆里写着 v1 API，现实已 v2，agent 优先信记忆 | 每条带"最后确认时间"；把记忆当缓存而不是真相 |
| **上下文膨胀** | `MEMORY.md` 涨到 20k 字符后被**静默截断**，agent 读的是残缺版 | 索引 + 按主题分文件，主文件只留指针 |
| **无人工闸门** | 技能自动写入、无版本控制，坏做法被反复强化 | pin / lock；或改成"提议 → 人工确认" |
| **压缩吃掉关键指令** | 压缩是有损的，"先别动，等我说"这类口头约束会被摘要丢掉 | 关键约束必须落文件，不能只停在对话里 |
| **只存不维护** | 记了一堆，越用越乱 | 必须有明确维护循环（nudge / curator），不是可选项 |

---

## 六、映射到我们的 Team Agent

### 1. 怎么对应

| Hermes | 我们 P1 的落地 | 差异说明 |
|---|---|---|
| `MEMORY.md` + `USER.md`，2200/1375 字符 | `memory/TEAM.md`（团队稳定事实、协作约定）+ `memory/PROJECTS.md`（各项目现状、决策、待办、风险） | 我们是团队不是个人，`PROJECTS.md` 需要更大预算，建议 2k + 6k 字符 |
| 会话开始时冻结快照 | Router 每次请求读最新快照 | **不能照抄冻结**：我们的 Router 是常驻 Session，冻结会导致新记忆永远看不见。要每次请求重读 |
| `memory` 工具 add/replace/remove | Worker 用现有 `read` / `write` / `edit` 直接改文件 | 不需要新工具；`edit` 的字符串定位等价于 `replace` |
| 周期性 nudge（后台 fork） | 持久化 **Review Effect**，由工单完成 / 人工纠正触发 | 我们用事件触发，比固定间隔更省，也更贴合"干完一件活就复盘" |
| Curator 的技能复审 | 我们的 Skill 治理（P4） | 可整体照搬：状态机 + 干跑 + 快照回滚 + pin |
| `session_search`（FTS5 + 总结） | **要新建**：自有库上建 FTS5（trigram 分词），暴露 `orchestrator_search`；飞书原文仍走 `lark-user` | 原先只有「按 id 读 + 飞书搜原文」，缺「按关键词搜自己库里的结论」这一层 |
| 技能作为程序性记忆 | 团队 Skill（已有 31 个） | 加载机制一致，差的是"什么时候写新技能" |

### 2. 该抄的四条

1. **硬上限 + 超限报错**。写 `TEAM.md` / `PROJECTS.md` 时设定字数预算，超了必须合并而不是追加。这一条能自动逼出记忆质量。
2. **分层：常驻 vs 检索**。常驻只放"每次都要知道"的；项目细节、历史讨论靠检索。不要把群聊往记忆里搬。
3. **后台复审要能回滚**。Review Agent 改文件前打快照，保留版本；初期一律人工确认。
4. **写入前做注入扫描**。我们的记忆会被注入 Router 提示词，而 Router 有调度权——群消息里的内容若能写进记忆，等于给了一条提权路径。这条对我们比对 Hermes 更必要。

### 3. 不该抄的三条

| 不抄 | 原因 |
|---|---|
| 全自动技能自改写（无人工闸门） | 这是 Hermes 被批评最多的点；我们初期必须人工确认 |
| Honcho 一类语义用户建模 | 要额外服务和 API key，收益不明；我们的 `PEOPLE.md` 可选、且只记协作偏好 |
| FSRS 式记忆衰减算法 | 对 40 人团队是过度设计，靠"最后确认时间 + 人工校对"就够 |

---

## 七、注入方式：为什么不能塞进系统提示

Hermes 把记忆放在系统提示里，是因为它每个会话都是新的。我们的 Router 是常驻 Session，照抄会踩缓存。

**先看实测数字**（Router 最近几次请求）：

| 请求 | 新增 input | 命中缓存 | 合计 |
|---|---|---|---|
| 第 394 步 | 399 | 49,536 | 50,039 |
| 第 399 步 | 205 | 49,920 | 50,135 |
| 第 412 步 | 201 | 50,432 | 50,642 |

**99.5% 的输入走缓存。** 系统提示在整个前缀的最前面，只要它变一个字节，后面这 5 万 token 全部重新计费、重新预填充。

所以：**记忆内容一旦写进系统提示，"改一次记忆 = 废一次缓存"**。Review Agent 每完成一个工单就更新一次项目状态，一天能写十几次。

### 正确做法：记忆当资源，不当提示词

| 位置 | 放什么 | 为什么 |
|---|---|---|
| Router 系统提示 | 只放**恒定的一句指针**（"团队记忆在 memory/，做判断前先读"） | 永不变化，缓存永远命中 |
| 记忆内容 | `orchestrator_read memory/TEAM.md` 现读 | 每次都是最新；读出来是工具结果 |
| 历史堆积 | 靠已有的 `tool-result-pruner`（阈值 8192 字符）自动修剪 | 旧的记忆读取结果会被裁掉，不会越攒越多 |
| Worker | 记忆文件直接放进工单目录（和 `AGENTS.md` 一样） | Worker 每工单一个会话，缓存本来就无关 |

这套改法很小：`src/app/resources.ts` 的 `RESOURCES` 是一张声明式表，加 `memory`、`memory/<file>` 两行 + 一个读取函数即可；Router 本来就在判断前习惯性调 `orchestrator_read`（读 trigger、读 thread），多一个记忆资源是同一套动作。

### 如果一定要"每一轮都在眼前"

那也不能进系统提示，要放在**每轮尾部**——和现在的 trigger 上下文块、技能目录同一个位置（作为本轮 user turn 的附加内容）。尾部追加不改前缀，5 万缓存保住，只多算新加的 1～2k。代价是每轮都带一遍、并且会累积进历史，直到压缩。

### 顺带发现一个已经在漏钱的地方

Router 的系统提示是**每轮重新组装**的，其中 policy 段用的是"当前 settings"：

```ts
// src/app/prompts.ts:143
composePrompt(config, 'orchestrator', environmentSection(...),
  role === 'orchestrator' ? policySection(this.store.settings(), config) : undefined)
```

也就是说，**今天改了 4 次 Policy，每一次都会让下一次 Router 请求的 5 万缓存全部作废**。两个解法：把 policy 段也挪到每轮尾部，或者至少把策略修改攒成一批再落盘。

## 八、对 P1 的三条具体建议

1. **容量定死**：`TEAM.md` ≤ 2,000 字符，`PROJECTS.md` ≤ 6,000 字符。超限时 Review 必须合并或删减，不允许"先追加再说"。
2. **只在两个点触发 Review**：工单 `completed`、成员明确纠正。周期性 nudge 先不做——我们没有那么多空闲时刻，也不希望它半夜自己改团队记忆。
3. **验收不看文件、看回答**：用三个真问题测（"上次那个活动谁负责""奖品方案最后定了哪个""这个项目现在卡在哪"），答对且能说清依据，才算记忆生效。

---

## 九、来源

- Persistent Memory：https://github.com/mudrii/hermes-agent-docs/blob/main/user-guide/features/memory.md
- Skills System：https://github.com/mudrii/hermes-agent-docs/blob/main/user-guide/features/skills.md
- Curator：https://github.com/mudrii/hermes-agent-docs/blob/main/user-guide/features/curator.md
- Sessions & FTS5：https://github.com/mudrii/hermes-agent-docs/blob/main/user-guide/sessions.md
- Context Files（SOUL/AGENTS 优先级）：https://github.com/mudrii/hermes-agent-docs/blob/main/user-guide/features/context-files.md
- 配置项：https://github.com/mudrii/hermes-agent-docs/blob/main/user-guide/configuration.md
- 官方站：https://hermes-agent.nousresearch.com/docs/
