# Story Foundry — 用户完整体验测试手册

本文档引导用户从零开始验证系统的所有功能。每个测试项标注了预期耗时和通过标准。

---

## 前置条件

| 组件 | 检查方法 |
|------|---------|
| Nocturne Memory | `curl http://127.0.0.1:8233/health` → 返回 `ok` |
| pi CLI | `pi --version` → 显示版本号（如 `0.80.3`） |
| 扩展加载 | `pi -e .pi/extensions/founder/index.ts -e .pi/extensions/runtime/index.ts` 能正常启动 |

> 如果 Nocturne Memory 未运行：`cd nocturne_memory && python backend/run_sse.py`

---

## 测试故事：晨光咖啡厅

整个测试使用同一个最小故事包。你不需要事先准备——手动测试第一项会帮你创建它。

```
故事名: 晨光咖啡厅
角色: 林晓（咖啡师，主角）
世界观: 现代都市中的一家独立咖啡厅
GM 风格: 注重感官细节，温暖宁静
```

---

## 1. 快速冒烟测试（~5 分钟）

快速确认系统能跑，适合每次重启后先跑一轮。

```
[ ] 1.1 启动 pi + 扩展
     pi -e .pi/extensions/founder/index.ts -e .pi/extensions/runtime/index.ts
     → 终端进入 pi 聊天界面

[ ] 1.2 列出故事
     输入: /stories list
     → 显示已有故事列表（或"没有找到故事包"）

[ ] 1.3 进入测试故事（假设已有"晨光咖啡厅"）
     输入: /stories play 晨光咖啡厅
     → 显示欢迎信息，含角色名和开场白
     → 无报错

[ ] 1.4 发送一条 GM 指令
     输入: 开始吧
     → GM 回应，调用 new-turn → write-story
     → 返回一段叙事文本

[ ] 1.5 退出故事
     输入: /stories stop
     → 显示"故事已退出"
```

**通过标准**：5 项全部 ✓，无报错。

---

## 2. 铸造师测试（~10 分钟）

验证铸造师能创建完整故事包。

```
[ ] 2.1 用铸造师创建"晨光咖啡厅"故事包
     输入（给铸造师）: 创建一个叫"晨光咖啡厅"的故事，主角是一个叫林晓的咖啡师，
                       在都市咖啡厅里的日常。风格温暖宁静。
     → 铸造师进行 Grilling 追问（1-2 轮后确认）
     → 铸造师调用 save_story + save_character
     → 输出"故事包已创建"

[ ] 2.2 验证文件结构
     在终端执行: ls -la pi-characters/晨光咖啡厅/
     → 包含: story.yaml  gm.yaml  chars/  story-log.md

[ ] 2.3 验证 story.yaml 完整性
     python3 -c "
     import json
     s = json.load(open('pi-characters/晨光咖啡厅/story.yaml'))
     assert 'world' in s
     assert 'characters' in s
     assert len(s['characters']) > 0
     assert 'outline' in s
     assert 'opening' in s
     print('✅ story.yaml 完整')
     "

[ ] 2.4 验证角色蓝图完整性
     python3 -c "
     import json, os
     chars_dir = 'pi-characters/晨光咖啡厅/chars'
     for f in os.listdir(chars_dir):
         c = json.load(open(os.path.join(chars_dir, f)))
         assert c.get('identity'), f'{f} 缺少 identity'
         assert c.get('preamble'), f'{f} 缺少 preamble'
         assert c.get('memoryTree'), f'{f} 缺少 memoryTree'
         assert c.get('behavior'), f'{f} 缺少 behavior'
     print(f'✅ {len(os.listdir(chars_dir))} 个角色蓝图完整')
     "
```

**通过标准**：故事包创建成功，文件结构完整。

---

## 3. GM 模式基本流程（~15 分钟）

验证从 play 到推进故事再到 stop 的完整链路。

```
[ ] 3.1 进入故事
     输入: /stories play 晨光咖啡厅
     → 角色已就绪的提示，无报错

[ ] 3.2 推进第一轮
     输入: 开始吧
     → GM 会调用 new-turn → write-story
     → 输出一段叙事（咖啡厅清晨的场景描写）
     → 观察：是否自动推进到下一轮

[ ] 3.3 手动触发第二轮
     输入: 来一个客人吧
     → GM 调用 new-turn（广播"一位常客推门而入"）
     → 调用 write-story 产出叙事
     → 输出包含客人出现的叙事

[ ] 3.4 验证 story-log.md 被写入
     在终端执行: cat pi-characters/晨光咖啡厅/story-log.md
     → 包含多轮叙事，每轮以 "##" 分段

[ ] 3.5 查看角色状态
     输入（使用 observe 工具——GM 会自动调用）或者等 GM 空闲时输入:
     用 observe 查看林晓的状态
     → GM 调用 observe({ char: '林晓' })
     → 返回林晓的最新响应状态

[ ] 3.6 退出
     输入: /stories stop
     → 故事已退出
```

**通过标准**：new-turn + write-story 正常产出叙事，story-log.md 有内容。

---

## 4. write-story 可靠性测试（~15 分钟）

验证 write-story 在复杂场景下的表现和错误诊断能力。

```
[ ] 4.1 正常复杂场景
     进入故事后，要求 GM 推进一个多角色场景:
     让 GM 同时安排林晓、一位熟客王姐、和新来的学徒三个人互动
     → new-turn 分批处理（一次 3 个角色以内）
     → write-story 在 60 秒内返回叙事
     → 叙事完整，不包含思考标签或元评论

[ ] 4.2 验证分批处理（仅开发者）
     在终端查看日志:
     grep -c "prompt" ~/.pi/agent/logs/*.log 2>/dev/null || echo "日志可能需要额外配置"
     → 确认 new-turn 不是一次性向所有角色发送请求

[ ] 4.3 错误诊断验证（模拟）
     如果写史子进程出错，GM 应该看到错误信息而非静默失败。
     在终端模拟错误:
     node -e "
     const { spawnSync } = require('child_process');
     const r = spawnSync('pi', ['--invalid'], { encoding: 'utf-8', timeout: 5000 });
     if (r.status !== 0) {
       const errMsg = '(写作 agent 退出码 ' + r.status + ': ' + (r.stderr || '').trim().slice(0, 100) + ')';
       console.log('错误信息示例:', errMsg);
       console.log('✅ 错误信息包含具体原因');
     }
     "
     → 输出类似: (写作 agent 退出码 1: Error: Unknown option: --invalid)
     → 不再是静默的 "(写作 agent 未输出)"

[ ] 4.4 压力测试（可选）
     连续调用 3 次 write-story（每次不同的场景方向）
     → 每次都在 60 秒内返回
     → 没有一次返回 "(写作 agent 未输出)"
```

**通过标准**：复杂场景正常输出，错误时有诊断信息而非静默失败。

---

## 5. 存读档测试（~15 分钟）

验证 save/load 的记忆和会话恢复能力。

```
[ ] 5.1 推进故事，积累内容
     进入故事，至少推进 2-3 轮，让 GM 和用户之间有来回对话
     → story-log.md 有多段内容

[ ] 5.2 保存存档
     输入: /stories save checkpoint-1
     → 显示"已存档: checkpoint-1"
     → 显示角色数和记忆条数

[ ] 5.3 验证存档文件结构
     在终端执行: ls -la pi-characters/晨光咖啡厅/saves/checkpoint-1/
     → 包含: charMemory/  story-log.md  .session.jsonl

[ ] 5.4 验证 .session.jsonl
     在终端执行: head -1 pi-characters/晨光咖啡厅/saves/checkpoint-1/.session.jsonl
     → 第一行是 {"type":"session"}

[ ] 5.5 继续推进故事，再保存第二个存档
     输入（给 GM）: 推进到中午时段
     输入: /stories save checkpoint-2
     → 第二个存档创建

[ ] 5.6 列出存档
     输入: /stories saves
     → 显示 checkpoint-1 和 checkpoint-2

[ ] 5.7 读档回到 checkpoint-1
     输入: /stories load checkpoint-1
     → 显示"已读档: checkpoint-1"
     → 角色记忆恢复 + 会话上下文恢复
     → GM syetem prompt 中包含"上次会话记录"（最后 6 轮对话）
     → GM 知道自己之前和用户聊了什么

[ ] 5.8 验证记忆恢复
     输入（给 GM）: 看看林晓还记得早上的事吗？
     → GM 通过 new-turn 询问林晓
     → 林晓应该记得之前发生的事（记忆已恢复）

[ ] 5.9 退出
     输入: /stories stop
```

**通过标准**：save 包含会话文件，load 恢复 GM 上下文，角色记忆正常。

---

## 6. 跨设备迁移模拟测试（~15 分钟）

验证故事包可以完整迁移到另一位置/设备。

```
[ ] 6.1 创建完好存档
     进入故事，推进到有一定进度的状态，保存:
     /stories save migration-test
     → 存档包含 session.jsonl

[ ] 6.2 模拟迁移：复制到临时目录
     在终端执行:
     cp -r pi-characters/晨光咖啡厅 /tmp/migrated-story

[ ] 6.3 修改被迁移副本的索引
     在终端执行:
     python3 -c "
     import json, os
     idx_path = '/tmp/migrated-story/story-index.yaml'
     if os.path.exists(idx_path):
         data = json.load(open(idx_path))
         for s in data['stories']:
             if s['name'] == '晨光咖啡厅':
                 s['path'] = '晨光咖啡厅'
         json.dump(data, open(idx_path, 'w'), indent=2, ensure_ascii=False)
         print('✅ 索引已更新')
     else:
         print('⏭️ 无单独索引文件，跳过')
     "

[ ] 6.4 退出现有故事
     输入: /stories stop

[ ] 6.5 用被迁移的副本"伪装"成新设备体验
     创建符号链接:
     ln -sfn /tmp/migrated-story pi-characters/晨光咖啡厅-migrated
     → 这只是为了在同一个设备上模拟迁移

[ ] 6.6 在新"设备"上 play（全新开始）
     输入: /stories play 晨光咖啡厅-migrated
     → 显示欢迎信息，没有之前会话的上下文
     → ✅ play 是干净的

[ ] 6.7 加载迁移过来的存档
     输入: /stories load migration-test
     → 显示"已读档: migration-test"
     → GM 恢复会话上下文，知道之前的进度

[ ] 6.8 验证可继续推进
     输入（给 GM）: 继续之前的情节
     → GM 能接上之前的叙事节奏
     → 角色记忆正常（通过 Nocturne Memory 恢复）

[ ] 6.9 清理
     在终端执行:
     rm -rf /tmp/migrated-story pi-characters/晨光咖啡厅-migrated

[ ] 6.10 回到原始故事（可选，如有需要）
     输入: /stories play 晨光咖啡厅
     输入: /stories load migration-test
     → 原始故事也能加载同一个存档
```

**通过标准**：play 保持纯净无上下文，load 恢复完整记忆 + 会话上下文，故事可继续。

---

## 7. 仲裁工具测试（~10 分钟）

验证多角色冲突时 judge 工具能正常工作。

```
[ ] 7.1 进入一个多角色故事
     使用"卫宫家的淫乱日常"或其他多角色故事:
     /stories play 卫宫家的淫乱日常

[ ] 7.2 设置一个冲突场景
     输入: 士郎想出门上学，但 Saber 想让他帮忙搬练习木桩，两人时间冲突
     → GM 调用 new-turn 收集双方意图
     → GM 调用 judge 进行仲裁
     → GM 调用 write-story 产出包含冲突解决的叙事

[ ] 7.3 验证仲裁结果
     在终端查看 GM 的回复:
     → judge 输出了结构化的仲裁结果
     → write-story 的叙事反映了仲裁后的结果
```

**通过标准**：judge 在意图冲突时输出仲裁结果，write-story 基于仲裁结果推进。

---

## 8. 记忆系统测试（~10 分钟）

验证角色的自主记忆能力。

```
[ ] 8.1 进入故事，观察角色记忆
     输入: 让角色有机会记住一些事

[ ] 8.2 验证角色通过 recall 回忆
     推进几轮后，让 GM 询问角色还记得什么
     → 角色通过 recall 搜索记忆
     → 返回正确的记忆内容

[ ] 8.3 验证角色通过 memorize 写入新记忆
     GM 安排一个值得记住的事件（如客人的喜好）
     → 角色调用 memorize 写入
     → 后续对话中角色能回忆起这个信息

[ ] 8.4 验证记忆树可浏览
     如果需要，让角色检查自己的记忆结构
     → 角色调用 memory-tree 浏览目录
```

**通过标准**：角色能独立调用记忆工具（recall/memorize/memory-tree）。

---

## 9. 修复工具测试（~10 分钟）

验证 fixer 可以检查和修复 story-log 和记忆。

```
[ ] 9.1 列出 story-log 段落
     手动触发 fixer（GM 可以在维护时使用）:
     在终端模拟: node -e "
     const fs = require('fs');
     const log = fs.readFileSync('pi-characters/晨光咖啡厅/story-log.md', 'utf-8');
     const sections = log.split('\\n---\\n');
     console.log('story-log 共', sections.length, '段');
     sections.forEach((s, i) => {
       const header = s.split('\\n').find(l => l.startsWith('## ')) || '无标题';
       console.log('  ', i, header);
     });
     "
     → 正确列出段落

[ ] 9.2 查看某段内容
     使用 fixer 工具: fixer({ action: 'log get 0' })
     → 返回第一段叙事内容

[ ] 9.3 编辑段落
     使用 fixer: fixer({ action: 'log edit 0 | ## 修正版\\n\\n修正后的内容' })
     → 段落已更新

[ ] 9.4 恢复原状
     使用 fixer: fixer({ action: 'log edit 0 | <原内容>' })
     → 恢复原始内容
```

**通过标准**：fixer 的 list/get/edit 功能正常。

---

## 10. 故障排查指南

### write-story 返回 "(写作 agent 未输出)"

**原因分析**（按可能性排序）：

| 可能原因 | 特征 | 解决方法 |
|---------|------|---------|
| Provider 限流 | 多次调用后出现，等一会恢复 | 等待 30 秒后重试，或切换到不同模型 |
| 模型加载失败 | 首次调用就失败 | 检查 `pi --list-models` 确认模型可用 |
| 参数错误 | 修改代码后出现 | 检查 `runWriter` 的参数传递和 `spawnSync` 调用 |
| 子进程被意外终止 | 系统资源不足 | 检查 `dmesg \| grep -i oom` 确认未被 OOM kill |

**诊断步骤**：
1. 查看返回的错误信息——现在是结构化错误，不再是静默的 `"(写作 agent 未输出)"`
2. 如果返回 `"(写作 agent 退出码 ...)"`，错误信息就在 stderr 中
3. 如果返回 `"(写作 agent 进程错误: ...)"`，可能是 `pi` 不在 PATH 中

### new-turn 超时慢

| 可能原因 | 解决方法 |
|---------|---------|
| 某些角色 RPC 进程已崩溃 | 重启故事（`/stories stop` 后 `/stories play`） |
| Provider 并发限制 | 减少角色数，或分批处理（当前 BATCH_SIZE=3 已缓解） |
| 某个角色的模型响应慢 | 检查该角色的 system prompt 是否过长 |

### 跨设备迁移后 GM 不记得之前的事

1. 确认 save 时 `.session.jsonl` 已生成：检查 `saves/{name}/.session.jsonl`
2. 确认 load 时显示"会话上下文: 已恢复"
3. 如果 GM 仍不记得，手动给 GM 一条提示："之前我们聊到……"

---

## 附录 A：完整通过标准速查

```
快速冒烟:  [ ] /stories list  ✓  [ ] /stories play ✓  [ ] 能对话 ✓  [ ] /stories stop ✓

铸造师:    [ ] 故事包创建 ✓  [ ] story.yaml ✓  [ ] gm.yaml ✓  [ ] chars/*.yaml ✓

GM 流程:   [ ] new-turn ✓  [ ] write-story ✓  [ ] story-log.md ✓  [ ] observe ✓

可靠性:    [ ] 复杂场景不卡死 ✓  [ ] 错误有诊断信息 ✓  [ ] 分批不超载 ✓

存读档:    [ ] save ✓  [ ] load ✓  [ ] 记忆恢复 ✓  [ ] 会话上下文恢复 ✓

迁移:      [ ] play 是干净的 ✓  [ ] load 恢复上下文 ✓  [ ] 故事可继续 ✓

仲裁:      [ ] judge ✓  [ ] 仲裁后叙事 ✓

记忆:      [ ] recall ✓  [ ] memorize ✓  [ ] memory-tree ✓

修复:      [ ] log list ✓  [ ] log get ✓  [ ] log edit ✓
```
