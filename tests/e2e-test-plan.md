# 端到端测试计划 (E2E Test Plan)

覆盖当前系统所有已实现功能的端到端测试。测试分为**自动化测试**（通过脚本验证核心组件可独立运行）和**手动测试**（在 pi chat 中验证交互流程）。

---

## 测试故事：晨光咖啡厅

一个最小化的故事包，包含：
- 1 名主角（咖啡师）
- 简单的世界观（现代都市咖啡厅）
- 1 个 NPC（常客）
- 1 个场景大纲（开店 → 接待 → 闭店）

---

## 第一部分：自动化测试

运行方式：
```bash
bash tests/e2e-test.sh
```

### 测试项

| # | 测试项 | 验证点 | 自动化 |
|---|--------|--------|--------|
| A1 | 故事包目录创建 | `pi-characters/e2e-晨光咖啡厅/` 存在，含 `chars/` `saves/` 子目录 | ✅ |
| A2 | story.yaml 完整性 | 含 world、cognitiveBoundaries、outline、opening、characters 字段 | ✅ |
| A3 | gm.yaml 完整性 | 含 narrative.style、narrative.tone、npcs 字段 | ✅ |
| A4 | 角色蓝图完整性 | 含 identity（第一人称）、preamble（对话对）、memoryTree（6 根节点）、behavior | ✅ |
| A5 | 角色 RPC 进程启动 | `pi --mode rpc` 子进程存活，能接收 env 输入并返回响应 | ✅ |
| A6 | 角色身份声明 | 响应内容使用第一人称（"我"），不出现"作为角色/扮演"等元叙事 | ✅ |
| A7 | 角色 act 工具调用 | 角色能通过 RPC 调用 act 工具输出对话/动作 | ✅ |
| A8 | memory-tools 扩展加载 | 角色 RPC 进程加载了 memory-tools 扩展 | ✅ |
| A9 | 角色进程停止 | 进程被杀，临时目录清理 | ✅ |
| A10 | 故事包清理 | 测试完成后删除整个测试故事包目录 | ✅ |

### 前置条件
- `pi` CLI 可用（`which pi`）
- Nocturne Memory **不要求**运行（有 fallback）

---

## 第二部分：手动测试

在 pi chat 中逐步执行，验证交互流程。

### 前置条件
- 已运行 `bash tests/e2e-test.sh setup` 创建了测试故事包
- 在项目根目录下启动 pi

### 测试流程

#### T1：铸造师模式 — 读取已有故事包进行迭代

```bash
# 启动 pi（加载所有扩展）
cd /home/lide/Describtion-Agent
pi
```

在 pi chat 中执行：

```
/founder 我想看看之前创建的故事包"晨光咖啡厅"，检查一下角色设定是否合理
```

**预期行为**：
- 铸造师读取 `pi-characters/e2e-晨光咖啡厅/` 下的文件
- 识别出角色"林晓"的 identity 是第一人称
- 给出 Grilling 追问或确认

#### T2：故事列表

```
/stories list
```

**预期行为**：
- 列出故事包列表，包含"晨光咖啡厅"
- 状态为 `○ 未开始`

#### T3：进入故事 — GM 模式

```
/stories play 晨光咖啡厅
```

**预期行为**：
- 显示"📖 进入故事：晨光咖啡厅"
- 显示世界观摘要
- 显示"🎭 角色已就绪：林晓"
- 显示开场白（如有）
- 左上角出现 GM 工具列表

#### T4：GM 工具 — new-turn（广播场景给角色）

```
# 在 GM 对话中，使用 new-turn 工具
new-turn({
  content: "清晨七点，阳光透过咖啡厅的落地窗斜斜地洒进来。\n吧台上的咖啡机正发出低沉的预热声。\n门外传来第一班电车的铃声。"
})
```

**预期行为**：
- 输出格式：`[林晓] act/thought: <角色响应内容>`
- 角色响应使用第一人称
- 内容与场景相关（比如对早晨的感受、准备开店等）

#### T5：GM 工具 — observe（查看角色状态）

```
observe({ char: "林晓" })
```

**预期行为**：
- 显示"📋 林晓"
- 显示最近一次响应的摘要

#### T6：GM 工具 — write-story（产出正史）

```
write-story({
  scene: "清晨七点，阳光透过咖啡厅的落地窗斜斜地洒进来。吧台上的咖啡机正发出低沉的预热声。",
  intents: "[林晓] act: 我拉开卷帘门，深吸了一口清晨的空气。新的一天开始了。我转身走回吧台，按下咖啡机的开关。",
  direction: "林晓开始一天的工作准备，展现他对咖啡厅的熟悉和责任感"
})
```

**预期行为**：
- 输出第三人称的叙事文本
- 叙事优美流畅，不包含思考过程或元评论
- 正确将角色的"我"转为角色名

#### T7：GM 工具 — console

```
console({ action: "list" })
console({ action: "status" })
```

**预期行为**：
- `list` 显示活跃角色列表（含"林晓"）
- `status` 显示当前故事名和活跃角色数

#### T8：退出故事

```
/stories stop
```

**预期行为**：
- 显示"故事已退出"
- 角色进程被终止

#### T9：重新进入并验证状态

```
/stories play 晨光咖啡厅
```

**预期行为**：
- 角色重新启动
- 没有遗留的上次会话状态（干净启动）

---

## 第三部分：记忆系统测试

需要 Nocturne Memory 在 `127.0.0.1:8233` 运行。如果未运行则跳过。

### 前置条件
```bash
cd /home/lide/Describtion-Agent/nocturne_memory
docker-compose up -d
# 等待几秒后验证
curl http://127.0.0.1:8233/health
```

### 自动测试

运行：
```bash
bash tests/e2e-test.sh memory
```

| # | 测试项 | 验证点 |
|---|--------|--------|
| M1 | 初始记忆导入 | 角色启动时 blueprint memoryTree 被导入 Nocturne Memory |
| M2 | recall（无参浏览） | 返回记忆目录，含 identity/relationships 等根节点 |
| M3 | recall（关键词搜索） | 返回匹配结果 |
| M4 | recall（URI 读取） | 返回指定节点的完整内容 |
| M5 | memorize | 写入新记忆成功，返回 URI |
| M6 | memory-tree | 显示记忆树结构 |

### 手动记忆验证

进入 GM 模式后，观察角色响应中是否包含记忆内容：

```
# 步骤：
# 1. /stories play 晨光咖啡厅
# 2. 多次 new-turn 互动，让角色积累一些"经历"
# 3. 查看角色响应中是否有回忆或记住的迹象
```

**预期行为**：
- 角色在对话中可能主动 recall 记忆
- 新的事件被角色 memorize

---

## 第四部分：清理

```bash
bash tests/e2e-test.sh cleanup
```

删除整个测试故事包。

---

## 测试通过标准

| 级别 | 标准 |
|------|------|
| 🔴 P0 | A1-A10（自动化核心流程）全部通过 |
| 🟡 P1 | T1-T9（手动 GM 交互）全部可按步骤执行且有预期结果 |
| 🟢 P2 | M1-M6（记忆系统）在 Nocturne Memory 可用时全部通过 |
