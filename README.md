# Story Foundry — AI 叙事铸造系统

一个让 AI 角色真正"活过来"的交互叙事引擎。角色拥有独立的记忆、人格、认知边界，像真人一样在故事中相遇、交流、成长。

> **你用铸造师（Founder）搭舞台，用 GM（Game Master）讲故事。角色们——一群独立的 AI 灵魂——在上面过自己的生活。**

---

## 架构总览

```
┌──────────────────────────────────────────────────────────┐
│                    pi (coding agent)                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐          │
│  │  Founder  │  │  Runtime  │  │ Memory Tools │          │
│  │ Extension │  │ Extension │  │  Extension   │          │
│  └────┬─────┘  └────┬─────┘  └──────┬───────┘          │
│       │              │               │                    │
└───────┼──────────────┼───────────────┼────────────────────┘
        │              │               │
        ▼              ▼               ▼
┌──────────────┐ ┌──────────┐ ┌────────────────┐
│  Tavern 角色卡 │ │ 故事包    │ │ Nocturne Memory│
│  导入 & 解包   │ │ pi-char..│ │ 长期记忆服务器  │
└──────────────┘ └──────────┘ └────────────────┘
                          │
                          ▼
                    ┌──────────────┐
                    │  角色子进程    │
                    │ (pi RPC mode)│
                    │ 独立 Agent   │
                    └──────────────┘
```

### 分层设计

系统分两层，代码和数据**完全解耦**：

| 层 | 内容 | 位置 |
|---|---|---|
| **不变层**（系统代码） | Founder / Runtime / Memory Tools 扩展 | `.pi/extensions/` |
| **可变层**（故事数据） | 故事包（story.yaml + gm.yaml + 角色蓝图 + 存档） | `pi-characters/{story-name}/` |

---

## 核心概念

### 故事包（Story Pack）

一个自包含的故事数据目录，包含所有可变信息。系统代码无需知道故事内容——只负责加载和提供运行时服务。

```
pi-characters/{story-name}/
├── story.yaml          ← 共享世界观 + 角色名单
├── gm.yaml             ← GM 叙事风格 + NPC 配置
├── story-log.md        ← GM 书写的正史叙事
├── chars/
│   ├── 卫宫士郎.yaml   ← 角色蓝图（第一人称身份声明 + 记忆树）
│   └── user.yaml       ← 用户自角色（可选）
└── saves/              ← 运行时存档
    ├── save-index.yaml
    └── {save-name}/
        ├── charMemory/     ← 角色记忆快照
        ├── story-log.md    ← 正史备份
        └── .session.jsonl  ← pi 会话文件（跨设备迁移用）
```

**文件清单**：

- **`story.yaml`** — 故事元信息、共享世界观、角色名单、认知边界、大纲和开场白
- **`gm.yaml`** — GM 的叙事风格、叙事基调、NPC 列表
- **`chars/*.yaml`** — 每个角色的完整蓝图（identity + preamble + memoryTree + behavior）
- **`story-log.md`** — GM 每次 `write-story` 后追加的净化版正史

### GM（Game Master）

用户唯一交互的 AI agent。职责：
- 理解用户意图，布置场景
- 广播环境（`new-turn`）给角色，收集原始意图
- 多角色意图冲突时仲裁（`judge`）
- 输出正史叙事（`write-story`）给用户并写入 `story-log.md`
- 扮演 NPC（无独立记忆 namespace）
- 判断自动推进或等待用户输入

> 用户是"隐形的上帝"——角色不知道你的存在。你只跟 GM 对话。

#### write-story 可靠性

`write-story` 通过 `spawnSync("pi", ...)` 启动独立子进程来生成叙事。针对实战中遇到的卡死和静默失败问题：

- **子进程错误诊断**：当子进程因 provider 限流、模型异常等退出码非零时，`stderr` 内容会被捕获并返回给 GM（如 `"(写作 agent 退出码 1: Error: ...)"`），不再静默返回 `"(写作 agent 未输出)"`
- **分批收集意图**：`new-turn` 一次最多向 3 个角色并发发送请求（BATCH_SIZE=3），避免 10+ 角色同时推理打爆 provider
- **RPC 超时优化**：角色进程等待超时从 30s 降至 20s

### 角色（Character）

故事包内的一个独立 AI agent。核心特性：
- **第一人称身份认同**：所有设定均以"我"的视角撰写
- **独立记忆 namespace**：通过 Nocturne Memory 存储，认知隔离由架构保证
- **自主行动循环**：角色不知道自己活在作品中
- **不可知他人**：不能直接访问其他角色的内部状态或记忆

### NPC（Non-Player Character）

由 GM 扮演的临时角色。没有独立记忆 namespace，行为由主要角色对它的记忆驱动。当多个角色对同一 NPC 有矛盾记忆时，GM 主动利用矛盾深化叙事。

### 认知隔离（Cognitive Isolation）

每个角色的知识严格限定于其个人经历。角色 A 无法访问角色 B 的记忆。同一个实体在不同角色的记忆中可以有不同的内容。这是**架构层保证的**，不是约定。

### 第一人称改写（First-Person Rewriting）

所有角色的设定、知识、记忆都以角色本人的第一人称认知来写。由铸造师在铸造阶段完成改写。

### 破限注入（Boundary-Breaking Injection）

在身份声明和上下文指令之间嵌入一段 user/assistant 对话，让模型在启动时以第一人称"成为"角色——不是"扮演"角色，而是**就是**角色。

---

## 交互模式

### 铸造模式（Founding Mode）

用户与**铸造师**对话，输入原始材料（角色卡、小说、一句话概念、SillyTavern PNG/JSON），铸造师通过 Grilling 追问逐步完善理解，产出完整故事包。

**Grilling 五轮追问策略**：
1. 基本信息（名字、年龄、世界类型）
2. 性格核心（底色、动机、恐惧）
3. 关系和背景（人际纽带、塑造经历）
4. 行为风格（说话方式、习惯、禁忌）
5. 深度验证（冲突场景推演、不会做的事）

### GM 模式（Gameplay Mode）

用户与 **GM** 对话，GM 驱动故事推进。启动命令：
- `/stories play <故事名>` — 进入故事（全新开始）
- `/stories stop` — 退出故事
- `/stories save <存档名>` / `/stories load <存档名>` — 存读档（含会话上下文）
- `/stories list` / `/stories saves` — 查询

#### 跨设备迁移

故事包支持跨设备迁移。`/stories-save` 会自动将当前 pi 会话文件（含 GM 与用户的对话历史）保存到存档目录。在目标设备上：

```
设备 A: /stories save my-checkpoint
         cp -r pi-characters/某故事 /U盘

设备 B: cp -r /U盘/某故事 pi-characters/
         /stories play 某故事          → 全新开始
         /stories load my-checkpoint   → 恢复记忆 + 会话上下文
```

`/stories-play` 始终保持纯净——不导入任何存档的会话上下文。`/stories-load` 是恢复 GM 对话上下文的唯一入口。

### 舞台模式（Stage Mode）

GM 安排的场景，多个角色在共享场景中实时共存。角色自主行动，GM 广播环境、收集意图、仲裁冲突、输出正史。

### 日常模式（Daily Mode）

GM 驱动的子模式，时间自动推进（按时间块：黎明/早晨/午前/中午/午后/傍晚/夜间/深夜），角色自主行动。GM 退后观察，不精控叙事。

可与舞台模式随时切换：白天用 daily 让角色生活，关键场景切舞台精控。

已实现命令：`/daily start` / `stop` / `tick` / `status`

---

## 扩展一览

### 1. Founder Extension (`.pi/extensions/founder/index.ts`)

铸造师工具（注册为 pi 的内置工具 `import_tavern` / `save_story` / `save_character`）：
- **`import_tavern`** — 导入 SillyTavern 角色卡（PNG/JSON），全量解包并返回结构化摘要。支持 Character Card 和 World Book 格式，提取 MVU 变量、策略配置、EJS 模板、正则脚本等
- **`save_story`** — 保存完整故事包（story.yaml + gm.yaml + chars/）
- **`save_character`** — 保存角色蓝图到已有故事包

### 2. Runtime Extension (`.pi/extensions/runtime/`)

涵盖三个模块：

**`index.ts`** — 启动器
- 注册 `/stories-*` 命令体系
- 故事启动时：加载故事包 → 切换 Nocturne Memory namespace → 自动启动所有角色 AgentSession → 注入 GM 系统提示
- 提供上下文隔离（各自独立的 pi session + 记忆 namespace + agent 实例池）

**`gm-tools.ts`** — GM 工具集
- `new-turn` — 广播场景 env 给角色，收集原始意图
- `judge` — 多角色冲突时仲裁
- `write-story` — 根据意图 + 方向 + 文风产出纯叙事正史
- `start-char` / `stop-char` — 角色进程管理
- `observe` — 查看角色最新状态
- `console` — 维护操作
- `archive-scene` — 场景归档到 Nocturne Memory `history` 域
- `fixer` — 正史回填到角色记忆（不修改已书写的正史，仅补充角色视角）

**`story-session.ts`** — 角色会话管理
- 每个角色启动一个持久的 pi RPC 子进程，避免冷启动
- 通过 stdin/stdout JSONL 通信
- 启动时导入 blueprint memoryTree 到角色的 Nocturne namespace

**`save-load.ts`** — 存读档
- 通过 Nocturne Memory API 导出/导入 namespace
- 支持命名存档
- load 时先清空 namespace 再重建，保证无残留

**`daily-mode.ts`** — 日常模式
- 8 个默认时间块（黎明→深夜）
- 可选从故事大纲自动生成时间块
- 时间推进 + 自动 env 广播 + 日志

### 3. Memory Tools Extension (`.pi/extensions/memory-tools/index.ts`)

角色子进程的工具集（通过 pi RPC mode 加载）：
- `recall` — 搜索记忆（core 域）
- `memorize` — 创建记忆节点
- `memory-tree` — 浏览完整记忆树
- `memory-edit` — 编辑已有记忆（内容/优先级）

所有工具通过 HTTP 与 Nocturne Memory API（`http://127.0.0.1:8233/api`）通信。

---

## 记忆系统

依赖 [Nocturne Memory](https://github.com/Dataojitori/nocturne_memory) — 一个独立的 MCP 长时记忆服务器。

### 记忆域名

| 域 | 写入者 | 用途 |
|---|---|---|
| **core** | 角色自身 | 角色自写的个人记忆。priority (0-10) 区分重要程度 |
| **history** | GM | 场景归档，每轮正史的摘要 |
| **history_raw** | GM | 完整互动日志，不注入给角色 |
| **maintenance** | 系统 | 记忆维护审计，记录动态调整过程 |

### 启动流程

```
角色 session 启动
  → 初始化 Nocturne namespace
  → 导入 blueprint 中的 memoryTree
  → 读入 boot 记忆（system://boot）
  → 注入角色系统提示（含 preamble + boot + history + state）
  → 进入 RPC 循环，等待 new-turn 广播
```

---

## 启动方式

### 前置条件

| 组件 | 说明 |
|---|---|
| Python 3.10+ | Nocturne Memory 后端 |
| Node.js | pi coding agent + Dashboard 前端构建 |
| Nocturne Memory | 见 `nocturne_memory/` 子模块 |

### 启动 Nocturne Memory

```bash
cd nocturne_memory
pip install -r backend/requirements.txt
python backend/run_sse.py
# 服务器启动在 http://127.0.0.1:8233
# Dashboard: http://127.0.0.1:8233/
# API 文档:  http://127.0.0.1:8233/api/docs
```

### 启动 Story Foundry

通过 pi coding agent 加载扩展：

```bash
pi -e .pi/extensions/founder/index.ts -e .pi/extensions/runtime/index.ts
```

铸造模式下加载 founder 扩展；游玩模式下加载 runtime 扩展。

---

## 故事包注册表

故事注册表位于 `pi-characters/story-index.yaml`，格式：

```yaml
stories:
  - name: "卫宫士郎-日常沙盒"
    path: "卫宫士郎-日常沙盒"
    created: "2026-07-09"
    lastPlayed: "2026-07-10"
    status: in_progress
    description: "卫宫士郎的日常校园生活"
```

---

## 现有故事包

| 故事名 | 描述 |
|---|---|
| 测试故事 | 宁静的小村庄，周围有森林和河流 |
| test-full | 小村庄（全功能测试） |
| 卫宫家的淫乱日常 | 冬木市卫宫邸，没有圣杯战争的平行世界日常 |
| 卫宫邸的日常-晴日 | 穗群原学园周边，热闹的大家庭日常 |
| 卫宫邸-日常沙盒 | 五战后所有人奇迹般共存的沙盒世界 |
| 卫宫邸-日常轮盘 | 冬木市海滨都市，五战结束后的和平日常 |

---

## 测试

测试文件位于 `tests/` 目录：

| 文件 | 说明 |
|---|---|
| `archive-scene-test.mjs` | 场景归档功能测试 |
| `daily-mode-test.mjs` | 日常模式测试 |
| `fixer-test.mjs` | 正史回填测试 |
| `memory-edit-test.mjs` | 记忆编辑测试 |
| `preamble-test.mjs` | 破限注入测试 |
| `save-load-test.mjs` / `.sh` | 存读档测试 |
| `e2e-test.sh` / `e2e-test-plan.md` | 端到端集成测试 |
| `session-context-test.mjs`（计划中） | 会话上下文提取纯函数测试 |

---

## 架构决策记录

见 `docs/adr/`：

| ADR | 主题 |
|---|---|
| 0001 | NPC 由角色记忆驱动，而非独立 memory namespace |
| 0002 | 破限注入（Boundary-Breaking Injection） |
| 0003 | Hybrid Daily-Stage Mode |
| 0004 | Story Pack & User-GM Interaction |

---

## 技能清单

项目安装了大量来自 [mattpocock/skills](https://github.com/mattpocock/skills) 的工程技能，见 `.pi/skills/` 和 `.agents/skills/`。核心技能：

| 技能 | 用途 |
|---|---|
| `ask-matt` | 路由——问它该用什么技能 |
| `wayfinder` | 大任务分拆为探索地图 |
| `grilling` + `grill-with-docs` | 追问完善设计 + 创建 ADR |
| `domain-modeling` | 梳理领域模型和术语 |
| `research` | 调研问题并产出文档 |
| `handoff` | 生成交接文档 |
| `implement` | 按 spec 实现功能 |
| `code-review` | 审查变更 |
| `tdd` | 测试驱动开发 |

---

## 相关资源

- **Nocturne Memory**: `nocturne_memory/` 子模块，基于 MCP 的长期记忆服务器
- **Tavern Cards**: `tavern-cards/` 子模块，SillyTavern 角色卡解析工具
- **pi coding agent**: 底层 agent 框架

---

## 设计哲学

> **"作者是自恋的"** — 传统写作中，作者总是带着上帝视角。这个系统想要做到的，是把角色从作者的笔中解放出来：让每个角色成为独立的 AI 灵魂，拥有自己的记忆、认知和选择。作者退到幕后，做那个搭舞台的人。

- 代码和数据完全解耦
- 认知隔离是架构层保证的，不是约定
- 第一人称改写 + 破限注入 = 角色即本人
- 记忆是跨会话、跨模型持久化的
- 一个灵魂，任意引擎（Nocturne Memory 不绑定任何 LLM）
