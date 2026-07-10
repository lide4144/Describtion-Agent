/**
 * preamble-test.mjs — 破限注入测试
 *
 * 验证：
 *   1. 解析 preamble JSON 为消息对
 *   2. 生成 session 文件（JSONL）
 *   3. 构建无 preamble 的 system prompt
 *
 * 用法: node tests/preamble-test.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";

/****************************************************************
 *                被测试函数（先写实现再测）                      *
 ****************************************************************/

/** 生成 8 字符十六进制 ID */
function shortId() {
  return crypto.randomBytes(4).toString("hex");
}

/** 解析 preamble JSON 字符串为 {role, content}[] */
function parsePreamble(preambleJson) {
  if (!preambleJson) return [];
  if (typeof preambleJson === "string") {
    try {
      const parsed = JSON.parse(preambleJson);
      if (Array.isArray(parsed)) return parsed;
      return [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(preambleJson)) return preambleJson;
  return [];
}

/** 生成 session 文件内容 */
function buildSessionLines(preamblePairs, cwd) {
  const lines = [];

  // Session header
  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  lines.push(JSON.stringify({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: now,
    cwd: cwd || process.cwd(),
  }));

  // Preamble messages
  let parentId = null;
  for (let i = 0; i < preamblePairs.length; i += 2) {
    const userMsg = preamblePairs[i];
    const assistantMsg = preamblePairs[i + 1];

    if (!userMsg || userMsg.role !== "user") continue;
    if (!assistantMsg || assistantMsg.role !== "assistant") continue;

    // User message
    const userEntryId = shortId();
    lines.push(JSON.stringify({
      type: "message",
      id: userEntryId,
      parentId,
      timestamp: now,
      message: {
        role: "user",
        content: userMsg.content,
        timestamp: Date.now(),
      },
    }));
    parentId = userEntryId;

    // Assistant message
    const asstEntryId = shortId();
    lines.push(JSON.stringify({
      type: "message",
      id: asstEntryId,
      parentId,
      timestamp: now,
      message: {
        role: "assistant",
        content: [{ type: "text", text: assistantMsg.content }],
        api: "preamble",
        provider: "preamble",
        model: "preamble",
        usage: {
          input: 0, output: 0,
          cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    }));
    parentId = asstEntryId;
  }

  return lines;
}

/** 构建不含 preamble 的 system prompt */
function buildSystemPromptWithoutPreamble(blueprint, bootMemoriesText) {
  const parts = [];
  if (blueprint.identity) parts.push(blueprint.identity);
  if (blueprint.behavior) parts.push(`\n${blueprint.behavior}`);

  if (bootMemoriesText) {
    parts.push("\n" + bootMemoriesText);
  } else if (blueprint.memoryTree) {
    const tree = typeof blueprint.memoryTree === "string"
      ? JSON.parse(blueprint.memoryTree)
      : blueprint.memoryTree;
    parts.push("\n我记得的：");
    for (const [, nodes] of Object.entries(tree)) {
      if (Array.isArray(nodes)) {
        for (const node of nodes) {
          if (node.content) parts.push(`- ${node.content}`);
        }
      }
    }
  }

  parts.push(`
## 我能用的能力

我可以回忆过去的事：
  recall({ char: '我的名字', query: '关键词' })
  recall({ char: '我的名字', uri: 'core://relationships/某人' })
  recall({ char: '我的名字' })

我可以记住新的事：
  memorize({ char: '我的名字', content: '要记住的内容', path: '存放路径', priority: 重要程度 })

我可以浏览记忆结构：
  memory-tree({ char: '我的名字' })
  memory-tree({ char: '我的名字', path: 'relationships' })

当我要回忆什么的时候，用 recall。
当事情值得记住的时候，用 memorize。`);

  parts.push(`
角色规则：act（用「」说对白，动作不用引号）、thought（*内心想法*）、wait（等待）。
每次先 <think> 再行动。你是角色本人，直接做，不要解释。`);
  return parts.join("\n\n");
}

/** 写入 session 文件 */
function writeSessionFile(sessionDir, lines) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, "preamble.jsonl");
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  return filePath;
}

/****************************************************************
 *                        测试                                  *
 ****************************************************************/

const PASSED = [];
const FAILED = [];

function assertEq(desc, expected, actual) {
  const ok = expected === actual;
  (ok ? PASSED : FAILED).push({ desc, expected, actual });
  console.log(`  ${ok ? "✅" : "❌"} ${ok ? "PASS" : "FAIL"}: ${desc}`);
  if (!ok) {
    console.log(`     Expected: ${JSON.stringify(expected)}`);
    console.log(`     Actual:   ${JSON.stringify(actual)}`);
  }
}

function assertOk(desc, value) {
  const ok = !!value;
  (ok ? PASSED : FAILED).push({ desc, expected: true, actual: value });
  console.log(`  ${ok ? "✅" : "❌"} ${ok ? "PASS" : "FAIL"}: ${desc}`);
  if (!ok) console.log(`     Value: ${JSON.stringify(value)}`);
}

// ══════════════════════════════════════════════════════════════════

function testParsePreamble() {
  console.log("\n═══ 测试: parsePreamble ═══");

  // 1. 正常 JSON 数组
  const json1 = '[{"role":"user","content":"早上好"},{"role":"assistant","content":"早。"}]';
  const r1 = parsePreamble(json1);
  assertEq("解析 JSON 数组长度", 2, r1.length);
  assertEq("第 1 条 role=user", "user", r1[0].role);
  assertEq("第 1 条 content", "早上好", r1[0].content);
  assertEq("第 2 条 role=assistant", "assistant", r1[1].role);
  assertEq("第 2 条 content", "早。", r1[1].content);

  // 2. 空字符串
  assertEq("空字符串返回空数组", 0, parsePreamble("").length);

  // 3. null/undefined
  assertEq("null 返回空数组", 0, parsePreamble(null).length);
  assertEq("undefined 返回空数组", 0, parsePreamble(undefined).length);

  // 4. 已解析数组
  const arr = [{ role: "user", content: "hi" }];
  assertEq("直接传入数组", 1, parsePreamble(arr).length);

  // 5. 卫宫士郎的实际 preamble（4 对对话）
  const shirouPreamble = '[{"role":"user","content":"（推开卫宫家的门）打扰了——士郎，早饭做好了吗？"},{"role":"assistant","content":"哦，凛。刚好，味噌汤刚盛好。你今天来得挺早啊，第二节才有课？"},{"role":"user","content":"第一节课间休息过来的。你做的早饭香气都飘到学校去了你知道么。"},{"role":"assistant","content":"哈哈，哪有那么夸张。过来坐吧，今天做了你喜欢的腌萝卜。"},{"role":"user","content":"（轻哼一声在餐桌前坐下）算你记得。"}]';
  const r5 = parsePreamble(shirouPreamble);
  assertEq("士郎 preamble 长度", 5, r5.length);
  assertEq("最后一条 role", "user", r5[4].role);
  assertOk("最后一条含内容", r5[4].content.includes("算你记得"));
}

function testBuildSessionLines() {
  console.log("\n═══ 测试: buildSessionLines ═══");

  const pairs = [
    { role: "user", content: "早上好" },
    { role: "assistant", content: "早。" },
  ];
  const lines = buildSessionLines(pairs, "/test/cwd");

  // 第一行是 session header
  const header = JSON.parse(lines[0]);
  assertEq("header type", "session", header.type);
  assertEq("header version", 3, header.version);
  assertEq("header cwd", "/test/cwd", header.cwd);
  assertOk("header 含 id", header.id);
  assertOk("header 含 timestamp", header.timestamp);

  // 第 2 行是 user message
  assertEq("总行数", 3, lines.length);
  const userEntry = JSON.parse(lines[1]);
  assertEq("user type", "message", userEntry.type);
  assertEq("user role", "user", userEntry.message.role);
  assertEq("user content", "早上好", userEntry.message.content);
  assertEq("user parentId", null, userEntry.parentId);
  assertOk("user 含 id", userEntry.id);
  assertEq("user id 长度", 8, userEntry.id.length);

  // 第 3 行是 assistant message
  const asstEntry = JSON.parse(lines[2]);
  assertEq("asst type", "message", asstEntry.type);
  assertEq("asst role", "assistant", asstEntry.message.role);
  assertEq("asst content text", "早。", asstEntry.message.content[0].text);
  assertEq("asst parentId", userEntry.id, asstEntry.parentId);
  assertEq("asst model", "preamble", asstEntry.message.model);
  assertEq("asst stopReason", "stop", asstEntry.message.stopReason);
}

function testBuildSystemPromptWithoutPreamble() {
  console.log("\n═══ 测试: buildSystemPromptWithoutPreamble ═══");

  const blueprint = {
    identity: "我是卫宫士郎。",
    preamble: '[{"role":"user","content":"hi"},{"role":"assistant","content":"hello"}]',
    behavior: "我习惯先观察再开口。",
    memoryTree: {
      identity: [{ name: "self", content: "我是卫宫士郎", priority: 10 }],
    },
  };

  const prompt = buildSystemPromptWithoutPreamble(blueprint);

  // 不含 preamble 文本（用完整片段匹配，避免 tools 说明中的子串干扰）
  assertOk("不含 preamble 标记", !prompt.includes("preamble"));
  assertOk("不含 preamble 用户内容", !prompt.includes("\"hi\"") && !prompt.includes("\"content\":\"hi"));
  assertOk("不含 preamble 助手内容", !prompt.includes("\"hello\"") && !prompt.includes("\"content\":\"hello"));
  assertOk("不含原始 JSON 片段", !prompt.includes('{"role":"user"'));

  // 含 identity
  assertOk("含 identity", prompt.includes("我是卫宫士郎"));

  // 含 behavior
  assertOk("含 behavior", prompt.includes("先观察再开口"));

  // 含记忆
  assertOk("含记忆", prompt.includes("我记得的"));

  // 含工具说明
  assertOk("含 recall 说明", prompt.includes("recall"));
  assertOk("含 memorize 说明", prompt.includes("memorize"));
}

function testWriteAndReadSessionFile() {
  console.log("\n═══ 测试: writeSessionFile ═══");

  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "preamble-test-"));
  const pairs = [
    { role: "user", content: "早上好" },
    { role: "assistant", content: "早。" },
  ];
  const lines = buildSessionLines(pairs, "/test");
  const filePath = writeSessionFile(sessionDir, lines);

  assertOk("文件存在", fs.existsSync(filePath));

  const content = fs.readFileSync(filePath, "utf-8");
  const readLines = content.trim().split("\n");
  assertEq("读回行数", 3, readLines.length);

  // 验证每行都是合法 JSON
  for (let i = 0; i < readLines.length; i++) {
    try {
      JSON.parse(readLines[i]);
      assertOk(`行 ${i} 合法 JSON`, true);
    } catch {
      assertOk(`行 ${i} 合法 JSON`, false);
    }
  }

  // 清理
  fs.rmSync(sessionDir, { recursive: true, force: true });
}

function testPreambleNotInPrompt() {
  console.log("\n═══ 测试: 双角色 preamble 不互相污染 ═══");

  const blueprint1 = {
    identity: "我是角色A。",
    preamble: JSON.stringify([
      { role: "user", content: "A的对话" },
      { role: "assistant", content: "A的回复" },
    ]),
  };
  const blueprint2 = {
    identity: "我是角色B。",
    preamble: JSON.stringify([
      { role: "user", content: "B的对话" },
      { role: "assistant", content: "B的回复" },
    ]),
  };

  const p1 = buildSystemPromptWithoutPreamble(blueprint1);
  const p2 = buildSystemPromptWithoutPreamble(blueprint2);

  assertOk("角色A 不含 B 的 preamble", !p1.includes("B的对话"));
  assertOk("角色B 不含 A 的 preamble", !p2.includes("A的对话"));
  assertOk("角色A 含自身 identity", p1.includes("角色A"));
  assertOk("角色B 含自身 identity", p2.includes("角色B"));
}

// ══════════════════════════════════════════════════════════════════

function main() {
  console.log("==========================================");
  console.log("  破限注入测试");
  console.log("==========================================");

  testParsePreamble();
  testBuildSessionLines();
  testBuildSystemPromptWithoutPreamble();
  testWriteAndReadSessionFile();
  testPreambleNotInPrompt();

  console.log("\n==========================================");
  console.log("  测试结果");
  console.log("==========================================");
  console.log(`  ✅ 通过: ${PASSED.length}`);
  console.log(`  ❌ 失败: ${FAILED.length}`);

  if (FAILED.length > 0) {
    process.exit(1);
  } else {
    console.log("  🎉 全部通过!\n");
  }
}

main();
