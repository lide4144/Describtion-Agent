# GM 工具可靠性 + 故事包跨设备会话迁移

Status: ready-for-agent

## Problem Statement

### GM 工具可靠性

当编剧（GM）在故事中推进剧情时，`write-story` 工具经常出现两种情况：

1. **卡住不动**：工具调用后长时间无响应，用户只能等待或放弃当前操作
2. **静默失败**：工具返回 `"(写作 agent 未输出)"`，没有任何错误信息，GM 和用户都不知道到底出了什么问题——是模型超时？provider 限流？配置错误？还是 prompt 太长？

这些问题在复杂场景（多角色同时行动、大量意图文本）时尤为频繁。首次调用可能正常，后续调用随着场景复杂度增加逐渐恶化。每次失败都意味着几十秒的等待后得到一个空结果，GM 被迫重试，叙事节奏被完全打断。

### 故事包跨设备迁移

用户可能在多台设备上使用同一组故事包。当前架构中，角色蓝图的记忆（通过 Nocturne Memory 的存读档机制）可以跨设备迁移——但 GM 的对话上下文只存在当前设备的 pi session 文件中。

当用户将故事包从设备 A 拷贝到设备 B 时：

| 数据 | 可迁移？ |
|------|---------|
| 角色蓝图（chars/*.yaml） | ✅ 故事包内 |
| GM 配置（gm.yaml） | ✅ 故事包内 |
| 正史叙事（story-log.md） | ✅ 故事包内 |
| 角色记忆（saves/*/charMemory/） | ✅ 通过 `/stories-save` |
| **GM 的对话上下文** | ❌ 存在设备 A 的 pi session 中 |

这意味着在设备 B 上 `/stories-play` + `/stories-load` 后，GM 对之前和用户聊了什么一无所知。用户需要重新交代上下文，GM 也接不上之前的叙事节奏。

## Solution

### 问题一：子进程错误诊断

`write-story` 和 `judge` 工具都通过 `spawnSync("pi", ...)` 启动独立的写作/判定子进程。当前代码只检查 `result.stdout`（子进程的标准输出），完全不检查 `result.error`、`result.status`、`result.signal`、`result.stderr`。

当子进程因任何原因（provider 限流、模型加载失败、参数错误）退出码非零时，`stdout` 为空，函数静默返回 `"(写作 agent 未输出)"`，真实错误信息被丢弃在 stderr 中。

修复：在返回结果前依次检查 `result.error`、`result.status`、`result.signal`，失败时返回包含 stderr 内容的错误信息。

### 问题二：角色意图收集并发过高

`new-turn` 工具通过 `Promise.all` 同时向所有活跃角色（10+ 个）的 RPC 进程发送推理请求。这会在瞬间打爆 provider 的并发限制，导致大多数请求超时或排队，最终拖慢整个 new-turn。

修复：改为分批并发，每批最多 3 个角色，避免 provider 过载。

同时将 `characterAct` 的超时从 30 秒缩减到 20 秒，避免单个慢角色拖长整轮等待。

### 问题三：会话文件随存档保存与加载

将 pi session 纳入故事的存读档体系：

- `/stories-save <name>`：除了已有的角色记忆导出 + story-log 复制之外，额外把**当前 pi session 文件**复制到 `saves/{saveName}/.session.jsonl`
- `/stories-load <name>`：在恢复角色记忆和 story-log 之后，读取保存的 `.session.jsonl`，提取**最后 6 轮对话**，格式化为"用户说 / GM 回复"的纯文本上下文，并注入到 GM 的 system prompt 中

这样 cross-device 迁移流程是：

```
设备 A: /stories-save my-save     → 记忆 + 会话都存了
         cp -r pi-characters/某故事 /U盘

设备 B: cp -r /U盘/某故事 pi-characters/
         /stories-play 某故事       → 全新开始
         /stories-load my-save     → 恢复记忆 + 恢复会话上下文
         （GM 有上次对话记录，可以继续推进）
```

`/stories-play` 保持纯净——总是新开始，不自动导入任何会话文件。`/stories-load` 是加载已存档对话的唯一入口。

## User Stories

1. As a GM user (编剧), when `write-story` fails, I want to see the actual error message (e.g., "provider rate limited", "model unavailable"), so that I know what went wrong and can take appropriate action instead of wondering why the output is empty.

2. As a GM user, when `write-story` succeeds, I want the tool to complete within a predictable time rather than getting stuck indefinitely, so that the story narrative flows smoothly.

3. As a GM user, when I call `new-turn` with 10+ characters, I want the tool to complete within a reasonable time (not 30+ seconds), so that the story pacing doesn't suffer.

4. As a user of the system, when a character's RPC process is slow to respond, I want a timely timeout rather than waiting 30 seconds, so that the overall interaction doesn't stall on a single slow character.

5. As a user who plays stories across multiple devices, I want `/stories-save` to include the GM's conversation context, so that I can transfer the full story state (memory + conversation) between devices.

6. As a user who loads a save on a new device, I want `/stories-load` to restore the GM's conversation context, so that the GM remembers what we discussed before and can continue the story without me re-explaining everything.

7. As a story system user, I want `/stories-play` to always start a fresh session (no automatic context injection), so that the distinction between "new game" and "load game" is clear and I can decide when to restore context.

8. As a developer, I want the session context extraction logic to be a pure testable function, so that I can verify its correctness with static fixtures without running pi or Nocturne Memory.

## Implementation Decisions

### 1. `runWriter` 和 `runJudge` 的错误检查

在两个函数的 `spawnSync` 结果后，按顺序检查：

1. `result.error` — 进程启动失败（如 pi 不在 PATH），返回 `"(写作 agent 进程错误: {message})"`
2. `result.status !== 0` — 退出码非零，返回 `"(写作 agent 退出码 {n}: {stderr})"`（stderr 截取 500 字）
3. `result.signal` — 被信号终止，返回 `"(写作 agent 被信号 {signal} 终止)"`

所有检查在删除临时文件之后进行。原本的 `(result.stdout || "").trim()` 兜底保留。

### 2. `new-turn` 分批处理

将 `Promise.all(targets.map(...))` 改为按 `BATCH_SIZE = 3` 分批：

```
for (i = 0; i < targets.length; i += 3)
  await Promise.all(batch.map(...))
```

每批内并发，批次间串行。总时间 = 每批的最长响应时间 × 批次数（约 3-4 批），而非所有角色的最长响应时间。

### 3. `characterAct` 超时缩短

`timeoutMs` 默认值从 `30000` 改为 `20000`（20 秒）。

### 4. session 随 save/load 体系迁移

- `/stories-save` 扩展：在 `saveStory()` 完成后，获取 `ctx.sessionManager.getSessionFile()`，复制到 `saves/{saveName}/.session.jsonl`
- `/stories-load` 扩展：在 `loadStory()` 完成后，检查 `saves/{saveName}/.session.jsonl`，如果存在则调用 `readSessionContext()` 提取对话上下文，通过 `pi.sendMessage({ customType: "gm-context", ... })` 注入到 GM 的 system prompt

### 5. `readSessionContext` 纯函数

```typescript
function readSessionContext(sessionFilePath: string, maxPairs: number = 6): string
```

- 只依赖 `fs.existsSync` 和 `fs.readFileSync`
- 不依赖 pi API、Nocturne Memory、异步 I/O
- 返回格式化上下文，或空字符串（文件不存在 / 消息不足）

从 session JSONL 中提取 `type === "message"` 且含 `message.role` 的条目，过滤出 text 类型的内容，取最后 `maxPairs` 轮 user/assistant 对话对，拼接为：

```

## 上次会话记录

用户说：{user content}
GM 回复：{assistant content, 去掉 <think> 标签}
...
```

### 6. 设计约束

- `/stories-play` 不读取 `.session.jsonl`，保持纯净新开始
- `/stories-stop` 不导出 session 文件——迁移是用户通过 save/load 主动触发的，不是 stop 自动触发
- session 文件体积较大（可能数百 KB 到数 MB），仅在用户主动 save 时复制，不放在自动流程中

## Testing Decisions

### 测试原则

- 只测外部行为，不测实现细节
- 纯函数优先：能用静态 fixture 测试的逻辑，不启动运行时

### 测试 seam

**唯一新增的 seam：`readSessionContext` 纯函数。**

测试方式：

```
tests/session-context-test.mjs
├── 用静态 JSONL fixture 验证提取逻辑
│   ├── 正常的 session 文件 → 返回正确格式的上下文
│   ├── 只有 1 条消息的 session → 返回空字符串（不足 2 条）
│   ├── 不存在的文件 → 返回空字符串
│   └── 含 <think> 标签的 assistant 回复 → 标签被剥离
└── 无需 Nocturne Memory、无需 pi 子进程
```

Fixture 文件位置：`tests/fixtures/session-sample.jsonl`。从一个真实的 pi session 文件中摘录前几行（session header + 几条 message），编辑为可控的测试数据。

### 不需单独测试的部分

| 改动 | 覆盖方式 |
|------|---------|
| `runWriter` / `runJudge` 错误检查 | 防御性代码，难以 mock `spawnSync` 形成有意义的测试。通过 e2e-test.sh 的 `test_gm_sub_agents` 覆盖正常路径 |
| `new-turn` 分批处理 (BATCH_SIZE) | 逻辑在并发 Promise 内部，mock 10+ RPC 进程得不偿失。通过现有 `test_character_rpc` + `test_gm_sub_agents` 覆盖 |
| `characterAct` 超时 30s→20s | 纯参数调整，通过 e2e-test.sh 覆盖 |
| stories-save session 导出 | 需要 pi 运行时环境，手动 E2E 验证 |
| stories-load session 导入 | 需要 pi 运行时环境，手动 E2E 验证 |

### 先例

- `tests/save-load-test.mjs`：直接 import `save-load.ts` 模块，用 clean/restore namespace 测试 Nocturne Memory 的存读档逻辑。本测试采用相同的模式——import 运行时模块，验证纯逻辑。
- `tests/e2e-test.sh` 的 `test_create_story_pack` 部分用 fixture 数据（静态文件）测试故事包创建的格式完整性。

## Out of Scope

- **角色 RPC 进程的资源管理**：不涉及如何限制角色进程的 CPU/内存使用、或如何优雅地暂停/恢复角色。这些是独立的性能优化项。
- **Nocturne Memory 跨设备同步**：记忆的跨设备迁移已由 `saveStory`/`loadStory` 的 charMemory 导出/导入机制覆盖。不在此 spec 范围内。
- **增量存档**：当前 `/stories-save` 是全量存档。增量存档或自动定期存档不在本次范围内。
- **GM 会话的精确还原**：当前方案只注入最后 6 轮对话的文本摘要，不还原工具调用、thinking block 或模型状态。精确的 session 还原需要 pi 的 session 切换机制（`ctx.switchSession`），因工具注册和扩展上下文会在切换后丢失，暂不实现。
- **session 文件清理**：.session.jsonl 随 save 保留。不涉及自动清理老旧存档或 session 文件压缩。

## Further Notes

- `readSessionContext` 中 `maxPairs=6` 的取值依据：pi 的上下文窗口通常容纳数千 token，6 轮对话（约 600+600+1200+1200 = ~3600 chars）足够让 GM 理解前情，又不会挤占系统 prompt 空间。
- session JSONL 格式：第一行是 `{"type":"session"}` 的 session header，后续各行是各种事件条目。`type === "message"` 且含 `message.role` 的是对话消息。assistant 消息可能在 `content` 数组中有多种类型（text、thinking、tool_call），只提取 `type === "text"` 的片段。
- 用户已在对话中确认 `/stories-play` 只做新开始，不做自动会话恢复。
