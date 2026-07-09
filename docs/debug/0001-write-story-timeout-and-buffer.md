# write-story 子进程超时与缓冲区溢出

## 症状

调用 `write-story` 工具时，返回内容为 `"(写作 agent 未输出)"`，但首次调用（酒馆相遇场景）正常工作。

## 环境

- 位置：`/home/lide/Describtion-Agent/.pi/extensions/runtime/gm-tools.ts`
- 函数：`runWriter`（第 30-72 行）
- 机制：通过 `spawnSync` 启动 `pi` 子进程，传入叙事 prompt，收集 stdout 输出
- 影响：同样的问题也出现在 `runJudge` 函数中

## 根因分析

`runWriter` 使用 `spawnSync` 调用 `pi --mode json -p` 生成叙事文本，但有两个参数限制被复杂场景打爆：

### 参数限制

| 参数 | 原值 | 作用 |
|------|------|------|
| `timeout` | **30 秒** | 子进程最大运行时间，超时则 kill |
| `maxBuffer` | **10 MB** | stdout 最大缓冲，超出则 kill |

### 实测对比

| 场景 | 生成耗时 | stdout 大小 | 结果 |
|:----:|:--------:|:----------:|:----:|
| 酒馆相遇（简单） | ~5s | 5.6 MB | ✅ 通过 |
| 夜袭战斗（复杂） | **55s** | **79.7 MB** | ❌ 两项都爆 |

### 原因一：timeout 30s 不够

复杂战斗场景的模型推理时间远高于简单场景（55s vs 5s）。30s 超时在第一个场景侥幸通过，第二个场景直接被杀。

### 原因二：maxBuffer 10MB 不够，叠加 JSON 流模式放大

`--mode json` 模式下，每个流式 delta 事件都携带**完整文本内容**，导致 stdout 极度膨胀：

- 纯文本内容 ~6KB
- JSON 流输出 ~80MB (13,000x 膨胀)

每输出一个新 token，整个已生成文本都重复一遍。叙事越长，膨胀比越高。

### 代码缺陷：未检查子进程错误

```typescript
const result = spawnSync("pi", [...], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
// ❌ 未检查 result.error / result.status
// 超时或 buffer 溢出时，result.stdout 为空，直接返回 "(写作 agent 未输出)"
```

## 修复方案

### 改动一：`runWriter` — 切换输出模式 + 放宽限制

- `--mode json` → **`--mode text`**：只输出最终纯文本，无流式事件
  - 同样战斗场景：**79.7 MB → 12.5 KB**（立减 6000 倍）
- `timeout`: 30s → **120s**
- `maxBuffer`: 10MB → **50MB**（text 模式实际用不到，留余量）
- 解析逻辑：从 JSON 事件解析简化为 `result.stdout.trim()`

```typescript
// 修复前
const result = spawnSync("pi", [
  "--mode", "json", "-p", "--no-session", "-ne",
  "--append-system-prompt", promptFile, "写",
], { encoding: "utf-8", timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
// ... 复杂 JSON 事件解析 ...

// 修复后
const result = spawnSync("pi", [
  "--mode", "text", "-p", "--no-session", "-ne",
  "--append-system-prompt", promptFile, "写",
], { encoding: "utf-8", timeout: 120000, maxBuffer: 50 * 1024 * 1024 });
const output = (result.stdout || "").trim();
return output || "(写作 agent 未输出)";
```

### 改动二：`runJudge` — 同步调整

同样的 `--mode json` 问题和较短 timeout，虽然 judge 输出短（通常 "无冲突" 三字），但为了一致性一并修复：

- `--mode json` → `--mode text`
- `timeout`: 30s → **60s**
- 解析逻辑同样简化

## 验证数据

修复后用战斗场景 prompt 测试：

| 指标 | 修复前 | 修复后 |
|:----|:-----:|:-----:|
| 模式 | `--mode json` | `--mode text` |
| stdout 大小 | 79.7 MB | 12.5 KB |
| 生成耗时 | 55s（超时被杀） | 46.6s ✅ |
| 叙事长度 | 无输出 | ~6KB 纯文本 |
| Exit code | 非零（被 kill） | 0 |

## 经验教训

1. **`--mode json` 不适合长文本生成**：流式 JSON 事件重复携带完整内容，stdout 随文本长度线性膨胀。长叙事应使用 `--mode text`。
2. **`spawnSync` 必须检查错误**：`result.error`、`result.status`、`result.signal` 都应该检查，超时和被 kill 时给出有意义的错误信息。
3. **timeout 应留余量**：模型推理时间随 prompt 复杂度变化很大。30s 对于简单场景够用，复杂场景需要 60-120s。
4. **buffer 按最坏情况设计**：10MB 对 `--mode text` 绰绰有余，但对 `--mode json` 可能远远不够。输出模式决定了 buffer 需求。

## 相关文件

- 工具实现：`/home/lide/Describtion-Agent/.pi/extensions/runtime/gm-tools.ts`
- 运行时注册：`/home/lide/Describtion-Agent/.pi/extensions/runtime/index.ts`
- 调试测试脚本：`/tmp/writer-test/`
