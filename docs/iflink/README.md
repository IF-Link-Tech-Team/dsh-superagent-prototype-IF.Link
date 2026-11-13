# 把 dsh-superagent 改造成团队 Agent：IF.Link 的实践记录

这个目录不属于 dsh-superagent 原型本身，是 [IF.Link（东南大学 AI 创客社区）](https://iflink.tech/)把
它改造成**一个团队共用的 AI 同事**时留下的思考与设计记录，整理出来供其他团队参考。

代码层面的改动很小（见根目录的两个提交：GitHub Source 变为可选、工单目录名不再强制英文、
团队记忆与全文检索）。真正花时间的是"怎么让它成为一个能被团队接受、能长期活下去的同事"——
也就是这里的文档所讨论的部分。

**阅读前请明确：这里写的是我们在特定约束下的判断，不是通用最佳实践。** 很多结论依赖我们的规模
（4000 人的社区、40 人共建团队、飞书为主的工作流）和我们的失败经验（服务挂过、身份权限撞墙、
记忆写歪过）。照搬大概率不合适，拿去对照着改比较有用。

## 从哪里开始

| 想了解什么 | 读哪篇 |
|---|---|
| 整套系统现在是怎么搭起来的（继承了什么、叠了什么） | [team-agent-framework.md](team-agent-framework.md) |
| 我们要一个什么样的 Agent，需求怎么定的 | [requirements.md](requirements.md) |
| 从现有原型到目标形态，怎么排步骤、卡在过哪 | [upgrade-plan.md](upgrade-plan.md) |
| 记忆怎么设计：存什么、谁来写、怎么防止写歪 | [memory-module.md](memory-module.md) |
| 记忆的写路径后来为什么改成"只有一个写者" | [memory-architecture-v2.md](memory-architecture-v2.md) |
| 别人的记忆产品怎么做，我们借鉴了什么 | [hermes-memory-research.md](hermes-memory-research.md) |
| Agent 该在什么情况下说话、什么情况下闭嘴 | [router-prompts.md](router-prompts.md) |
| 什么请求该转成任务、什么该拒绝 | [policy-rules.md](policy-rules.md) |
| 模型挂了怎么自动换、备用链怎么在面板里拖 | [model-fallback-plan.md](model-fallback-plan.md) |
| 飞书 API 额度怎么压下来，以及一次"改了但没生效"的教训 | [feishu-quota.md](feishu-quota.md) |
| 模型 token 花在哪、为什么 router 一条会话吃掉 65% | [model-token-cost.md](model-token-cost.md) |
| 给团队里其他 Agent 的省额度清单（不分框架） | [agent-quota-guide.md](agent-quota-guide.md) |
| 想聊天又不想烧 API 额度：Agent 原生的 ClawChat 通道 | [clawchat.md](clawchat.md) |
| 怎么让它不只在被叫到时才在（心跳、定时任务、主动开口） | [heartbeat-scheduler.md](heartbeat-scheduler.md) |
| 更上游的思考：super-agent 的分层与交互 | [super-agent-design.md](super-agent-design.md) |

## 四点可能对别人有用的结论

**1. 先跑起来，再变聪明。** 升级方案把"能在群里被 @、能建工单、能回话"和"有记忆、会主动"分成了
两步且顺序不可颠倒。先打通闭环的好处是：后面每一个设计决策都有真实数据可依，而不是想象出来的场景。

**2. 记忆要小，且只能从一扇门进。** 记忆模块设了硬上限（TEAM.md 2,000 字符、PROJECTS.md 6,000 字符），
超限必须合并而不是追加；写入只走一个脚本，带写前快照、字数检查、注入扫描和变更日志。让模型自由
编辑记忆文件，很快就会得到一堆互相矛盾的过期事实。

**3. 身份边界是产品问题，不只是技术问题。** 飞书的 bot 身份有天生的能力上限（我们实测 240 个 scope
里 bot 只能用 50 个），补授权解决不了，只能换身份。而"让 Agent 用某个人的账号做事"这件事，
一旦公开就改变了团队对它的信任模型——文档里对这条边界写得比较细。

**4. "改完"不等于"生效"，要用外部指标验收，而不是用自己打印的日志。** 我们把飞书重扫改成小时级，
提交、构建、重启、自检全绿，然后以为省了 95%——实际上节奏常量的默认值单位写错了，全部退化成毫秒，
每一轮都在全量扫，比改之前还多花三成。当天晚上才从「额度又被烧完」倒推出来。教训有三条：
默认值必须有测试断言；验收指标要来自被观测对象之外（我们最后是数进程，不是看日志）；健康检查绿了不代表省钱。

## 这些文档的状态

它们写于 2026 年 11 月上旬的改造过程中，不是事后的整理稿，因此保留了当时的判断、当时的错、以及
"这里还没做"的标记。方案里标了 ✅ 的是已经落地的，⚠️ 和"未开始"的仍是计划。代码里现在有的是
记忆的读取、检索与工单快照，复盘写入与周期性 journal 只在文档里描述过。

我们另有几份文档暂不公开：内部产品路线（Personal Agent 与 Team Agent 的整合方案，尚未定型）、
以及团队记忆的真实内容（涉及成员与内部决策）。
