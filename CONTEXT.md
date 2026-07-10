# 故事铸造系统 (Story Foundry System)

一个理解任意故事文本、生成可运行的 AI 故事包的系统。系统代码和数据完全解耦——代码只负责铸造和运行，所有可变部分（角色蓝图、GM 配置、世界观、存档）都在**故事包**中。

## 架构总览

```
不变层（系统代码 / pi extensions）
├── 铸造师 (Founder) extension    ← 创建故事包
├── 运行时引擎 (Runtime) extension ← 加载故事包、驱动 GM + 角色
└── 启动器 (Launcher)             ← 故事选择、切换、存档管理

可变层（数据 / 故事包）
└── pi-characters/
    ├── {story-name}/
    │   ├── story.yaml       ← 共享世界观 + 角色名单
    │   ├── gm.yaml          ← GM 叙事风格 + NPC 配置
    │   ├── story-log.md     ← GM 书写的正史叙事
    │   ├── chars/
    │   │   ├── 卫宫士郎.yaml   ← 角色蓝图（铸造师产出）
    │   │   └── user.yaml     ← 用户自角色（可选，铸造师产出）
    │   └── saves/            ← 运行时存档（pi session + 记忆快照）
    └── story-index.yaml      ← 所有故事的注册表
```

## 交互流

```
用户（你）
  │  只跟 GM 对话
  ▼
GM（AI agent，加载 gm.yaml 启动）
  │  理解用户意图 → new-turn 广播场景 → write-story 产正史
  │  呈现叙事 → 判断推进或等待
  ▼
角色(s) RPC 进程
  │  recall/memorize/memory-tree（自主管理记忆）
  │  不知道自己被「观看」，认为生活就是生活
  ▼
用户（可选：给 GM 微调意见）
  │  "这个方向不错，但让凛晚点再出现"
  ▼
GM 调整策略 → 继续推进
```

**你（用户）在叙事中是隐形的上帝**——角色不知道你的存在。你只通过 GM 间接影响故事。

## 核心概念

**故事包 (Story Pack)**:
一个自包含的故事数据目录。包含共享世界观、所有角色的蓝图、GM 配置、运行时的存档记录。系统代码无需知道故事内容——它只负责加载故事包并提供运行时服务。

**铸造师 (Founder)**:
系统层 AI agent。接收用户的任意输入（角色卡、小说、一句话概念、SillyTavern PNG/JSON），通过 Grilling 追问逐步完善理解，产出完整的故事包。支持多轮迭代——铸造师可以读取故事包的运行时状态，对比初始设计，调整角色或 GM 配置。

**GM (Game Master)**:
管理层 AI agent。用户的唯一交互界面。负责理解用户意图、布置场景、发出环境旁白、扮演 NPC、管理场景起止、归档场景。GM 对角色**适度知情**——知道角色的公开状态和内心倾向，但不替角色行动、感受、产生想法。GM 的注意力有焦点，一次只能聚焦在一个角色或一个地点上。

**角色 (Character)**:
故事包内的一个 AI agent。拥有独立的记忆 namespace、第一人称身份认同、自主的行动循环。不知道自己活在作品中。不能直接访问其他角色的内部状态或记忆。认知隔离是架构层保证的。
_Avoid_: 角色卡、人设、AI 助手

**NPC (Non-Player Character)**:
由 GM 扮演的临时角色。没有独立的记忆 namespace，行为由主要角色对它的记忆驱动。

**用户自角色 (Self-Character / User Agent)**:
可选的用户化身。在铸造阶段由铸造师根据用户意愿创建，作为故事包内的一个普通角色蓝图（存放在 `chars/user.yaml`）。用户通过**潜意识式指令**影响它——用户告诉 GM 希望自角色怎么行动，GM 通过环境信号或对话引导自角色，但自角色最终是否执行由其自主决定。用户也可以用话术说服自角色。
_Avoid_: Avatar、分身

**用户 (User)**:
系统外的人（你）。在铸造模式下与铸造师对话，提供故事材料。在游玩模式下只与 GM 对话。在叙事中是隐形的——角色不知道你的存在。
_Avoid_: 玩家、叙事者

## 故事包结构

```
pi-characters/{story-name}/
│
├── story.yaml
│     故事元信息 + 共享世界观
│     name: 故事名称
│     world: 角色普遍知道的世界设定（供 GM 和所有角色共享）
│     characters: 角色名单 + 各自对应的蓝图文件
│       - name: "卫宫士郎"
│         blueprint: chars/卫宫士郎.yaml
│         role: protagonist
│       - name: "user"
│         blueprint: chars/user.yaml   （可选）
│         role: self
│     cognitiveBoundaries:
│       common: "所有角色都知道的信息"
│
├── gm.yaml
│     GM 的叙事风格 + NPC 配置
│     narrative:
│       style: "细腻的环境描写，注意感官细节"
│       tone: "温暖但有张力"
│     npcs:
│       - name: "藤村大河"
│         keywords: ["藤姐", "老师"]
│     sceneDefaults:
│       time: "day"
│
├── story-log.md         ← GM 每次 write-story 后追加的净化版正史
│
├── chars/
│     每个角色的独立蓝图（铸造师产出）
│     ├── 卫宫士郎.yaml
│     │   identity: "我是卫宫士郎……"（第一人称身份声明）
│     │   preamble: [{user: ..., assistant: ...}]（破限对话）
│     │   memoryTree: {identity/relationships/events/locations/world}
│     │   behavior: "我怎么做……"（自然语言行为指引）
│     │   toolOverrides: {...}（工具说明覆盖，可选）
│     │   thinkingFormat: {enabled, template}
│     │
│     └── user.yaml
│         自角色的蓝图，格式与其他角色相同
│         铸造阶段可选创建
│
└── saves/
      运行时写入，非铸造师产出
      ├── {save-name}/          ← 命名存档目录
      │   ├── charMemory/       ← 每个角色的记忆快照
      │   ├── story-log.md      ← 正史备份
      │   └── .session.jsonl    ← pi 会话文件（跨设备迁移用）
      ├── save-index.yaml       ← 存档清单
      └── ...

story-index.yaml（故事注册表）
stories:
  - name: "卫宫士郎-日常沙盒"
    path: "卫宫士郎-日常沙盒"
    created: "2026-07-09"
    lastPlayed: "2026-07-10"
    status: in_progress
    description: "卫宫士郎的日常校园生活"
```

## 启动器 + 存读档

```
/stories list         ← 列出 story-index.yaml 中所有故事
/stories play <name>  ← 进入故事
                         ├── 加载故事包
                         ├── 创建/切换到该故事的 pi session（上下文隔离）
                         ├── 切换到该故事的 Nocturne Memory namespace
                         ├── 启动 GM agent
                         ├── 检查存档：
                         │   ├── 有 → GM: "上次我们讲到……要继续吗？"
                         │   └── 无 → GM: "新的故事开始了，你想从哪里开始？"
                         └── 进入 GM 对话模式

/stories save <name>  ← 保存到命名存档
                         ├── 暂停所有 agent（GM + 所有角色）
                         ├── 扩展: 导出所有角色的记忆树到 charMemory/
                         ├── 扩展: 备份 story-log.md
                         ├── 扩展: 复制当前 pi session 到 .session.jsonl
                         └── 通知用户已保存

/stories load <name>  ← 读档
                         ├── 扩展: 恢复所有角色的记忆树
                         ├── 扩展: 恢复 story-log.md
                         ├── 扩展: 从 .session.jsonl 提取最后 6 轮对话
                         │        注入到 GM 的 system prompt
                         ├── 重启角色 session
                         └── 通知用户已恢复

/stories saves       ← 列出当前故事的所有存档标签
/stories stop        ← 停止角色进程 + 退出（不自动 save）

跨设备迁移流程：
  设备 A: /stories save checkpoint
           cp -r pi-characters/某故事 /U盘
  设备 B: cp -r /U盘/某故事 pi-characters/
          /stories play 某故事          → 全新开始
          /stories load checkpoint   → 恢复记忆 + 会话上下文
```

**上下文隔离的实现**：
- pi session 隔离：每个故事使用独立的 `.jsonl` session 文件
- 记忆隔离：每个故事使用独立的 Nocturne Memory namespace
- agent 实例隔离：切换故事时销毁当前故事的 GM + 角色 agent 池，创建新的

## 铸造过程

用户输入原始材料 → 铸造师阅读并理解 → 铸造师通过 Grilling 追问模糊之处 → 用户回答（逐轮） → 铸造师产出完整故事包（story.yaml + gm.yaml + chars/ 每个角色的蓝图）

**Grilling 的五轮追问策略**：
1. 基本信息（名字、年龄、世界类型）
2. 性格核心（底色、动机、恐惧）
3. 关系和背景（人际纽带、塑造经历）
4. 行为风格（说话方式、习惯、禁忌）
5. 深度验证（冲突场景推演、不会做的事）

**可选步骤**：
- 用户自角色创建：如果用户希望有自己的角色化身，铸造师额外创建一个 `chars/user.yaml`
- GM 风格讨论：铸造师询问用户希望的叙事风格

## 认知与身份

**认知隔离 (Cognitive Isolation)**:
每个角色的知识严格限定于其个人经历、观察和记忆。角色 A 无法访问角色 B 的记忆或内部状态。同一个实体（人、地点、物品）在不同角色的记忆中可以有完全不同的内容。这是架构层保证的。
_Avoid_: 信息共享、统一知识库

**第一人称改写 (First-Person Rewriting)**:
所有角色的设定、知识、记忆，都以角色本人的第一人称认知来写。由铸造师在铸造阶段完成改写。

**破限注入 (Boundary-Breaking Injection)**:
在身份声明和上下文指令之间嵌入一段 user/assistant 对话，让模型在启动时就以第一人称「成为」角色。

## 交互模式

**铸造模式 (Founding Mode)**:
用户与铸造师对话，产出故事包。

**GM 模式 (Gameplay Mode)**:
用户与 GM 对话，GM 驱动故事推进。用户只跟 GM 交互，不直接与角色对话。

**舞台模式 (Stage Mode)**:
GM 安排的场景，多个角色在共享场景中实时共存，配有环境旁白、打断机制、自主行动循环。

**日常模式 (Daily Mode)**:
GM 驱动的子模式，时间自动推进，角色自主行动。GM 退后观察，不精控叙事。
可与舞台模式随时切换：白天用 daily 让角色生活，关键场景切舞台精控。
  *已实现*：`/daily start` / `stop` / `status` / `tick`

## 记忆系统

**core**:
角色自写的记忆域名。按 priority（0-10）区分重要程度。是角色唯一能通过 `recall` 搜索的域。priority 是动态的，通过 maintenance 域调整。

**history**:
GM 写的场景归档域名。

**history_raw**:
完整互动日志，不注入角色。

**maintenance**:
记忆维护审计域，记录角色动态调整记忆的过程（节点移动、合并、优先级变化）。第一人称呈现为「我记得上次整理过这一段」。

## 工具（铸造师侧）

`import-tavern` — 导入 SillyTavern 角色卡
`save-story` — 保存完整故事包（story.yaml + gm.yaml + chars/）
`grill` — Grilling 追问
`load-story` — 读取已有故事包用于迭代

## 工具（运行时侧）

**GM 工具**（已实现）：`new-turn`、`write-story`、`judge`、`start-char`、`observe`、`stop-char`、`console`、`archive-scene`、`fixer`、`daily-start`、`daily-tick`、`daily-stop`、`daily-status`

**角色工具**（已实现）：`recall`（回忆）、`memorize`（记住）、`memory-tree`（浏览记忆树）、`memory-edit`（编辑已有记忆）

**启动器工具**（已实现）：`stories-list`、`stories-play`、`stories-stop`、`stories-save`、`stories-load`、`stories-saves`
