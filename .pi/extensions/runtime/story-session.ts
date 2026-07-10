/**
 * Story Session — 角色会话管理
 *
 * 每个角色启动一个持久的 pi RPC 子进程，避免每次 new-turn 冷启动。
 * 角色进程在 startCharacterSession 时启动，stopCharacterSession 时终止。
 * 通过 stdin/stdout JSONL 通信（pi RPC 协议）。
 *
 * Nocturne Memory 集成：
 * - 启动时导入 blueprint memoryTree 到角色的 Nocturne namespace
 * - system prompt 注入 boot 记忆
 * - pi RPC 子进程加载 memory-tools 扩展，角色可调用 recall/memorize 工具
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { createInterface } from "node:readline";
import { initCharacterMemory, fetchBootMemories } from "../memory-tools/index.ts";

/** 相对于本文件的 memory-tools 扩展路径 */
const MEMORY_TOOLS_EXT = path.resolve(import.meta.dirname, "../memory-tools/index.ts");

export interface CharacterSession {
  name: string;
  blueprint: any;
  lastResponse: string;
  promptFile: string;
  /** session 文件路径（含 preamble 注入），无 preamble 时为 undefined */
  sessionFile?: string;
  /** RPC 子进程 */
  proc: ChildProcess;
  /** 等待中的 response promise */
  pendingResponse: ((text: string) => void) | null;
}

export type CharacterMap = Map<string, CharacterSession>;

function loadBlueprint(storyDir: string, charName: string): any | null {
  const storyPath = path.join(storyDir, "story.yaml");
  if (fs.existsSync(storyPath)) {
    try {
      const story = JSON.parse(fs.readFileSync(storyPath, "utf-8"));
      const entry = (story.characters || []).find((c: any) => c.name === charName);
      if (entry?.blueprint) {
        const bpPath = path.join(storyDir, entry.blueprint);
        if (fs.existsSync(bpPath)) return JSON.parse(fs.readFileSync(bpPath, "utf-8"));
      }
    } catch { /* */ }
  }
  const directPath = path.join(storyDir, "chars", `${charName}.yaml`);
  if (fs.existsSync(directPath)) {
    try { return JSON.parse(fs.readFileSync(directPath, "utf-8")); } catch { /* */ }
  }
  return null;
}

/**
 * 解析 preamble JSON 字符串为 {role, content}[]
 */
function parsePreamble(preambleJson: any): Array<{role: string; content: string}> {
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

/** 生成 8 字符十六进制 ID */
function shortId(): string {
  return crypto.randomBytes(4).toString("hex");
}

/**
 * 生成 session 文件内容（JSONL 行数组），含 preamble 对话对
 */
function buildSessionLines(
  preamblePairs: Array<{role: string; content: string}>,
  cwd: string,
): string[] {
  const lines: string[] = [];
  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Session header
  lines.push(JSON.stringify({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: now,
    cwd,
  }));

  // Preamble 消息对
  let parentId: string | null = null;
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

/**
 * 写入 session 文件，返回文件路径
 */
function writeSessionFile(sessionDir: string, lines: string[]): string {
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, "preamble.jsonl");
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  return filePath;
}

/**
 * 构建 system prompt（不含 preamble——preamble 通过 session 文件注入）
 */
function buildSystemPrompt(blueprint: any, bootMemoriesText?: string): string {
  const parts: string[] = [];
  if (blueprint.identity) parts.push(blueprint.identity);
  if (blueprint.behavior) parts.push(`\n${blueprint.behavior}`);

  // 注入 Nocturne Memory boot 记忆（比静态 memoryTree 更完整）
  if (bootMemoriesText) {
    parts.push("\n" + bootMemoriesText);
  } else if (blueprint.memoryTree) {
    // 降级：如果没有 Nocturne Memory，用 blueprint 的静态 memoryTree
    const tree = typeof blueprint.memoryTree === "string"
      ? JSON.parse(blueprint.memoryTree)
      : blueprint.memoryTree;
    parts.push("\n我记得的：");
    for (const [, nodes] of Object.entries(tree)) {
      if (Array.isArray(nodes)) {
        for (const node of nodes as Array<any>) {
          if (node.content) parts.push(`- ${node.content}`);
        }
      }
    }
  }

  // 记忆工具说明（自然语言风格）
  parts.push(`
## 我能用的能力

我可以回忆过去的事：
  recall({ char: '我的名字', query: '关键词' })  — 搜索记忆
  recall({ char: '我的名字', uri: 'core://relationships/某人' })  — 读取某段具体记忆
  recall({ char: '我的名字' })  — 浏览记忆目录

我可以记住新的事：
  memorize({ char: '我的名字', content: '要记住的内容', path: '存放路径', priority: 重要程度 })  
  — 路径如 relationships/远坂凛 或 events/今天发生的事
  — 重要程度 0-10，越重要数字越大

我可以浏览记忆结构：
  memory-tree({ char: '我的名字' })  
  memory-tree({ char: '我的名字', path: 'relationships' })

每次做完一件事、说过一段话之后，想想刚才的事值不值得记住。
用 memorize 记下来——这是你唯一能留到以后的东西。
系统会帮你自动记录基本行为，但你的视角和感受只有你自己能写。
不用记每件小事——但如果你觉得某件事、某句话、某个瞬间对你重要，就记下来。`);

  parts.push(`
角色规则：act（用「」说对白，动作不用引号）、thought（*内心想法*）、wait（等待）。
每次先 <think> 再行动。你是角色本人，直接做，不要解释。`);
  return parts.join("\n\n");
}

/**
 * 启动一个角色的持久 RPC 进程
 */
export async function startCharacterSession(
  storyName: string,
  charName: string,
  storiesDir: string,
  charMap: CharacterMap,
): Promise<CharacterSession> {
  const storyDir = path.join(storiesDir, storyName);
  const blueprint = loadBlueprint(storyDir, charName);
  if (!blueprint) throw new Error(`找不到角色蓝图: ${charName}`);

  // 如果已有 session 且进程存活，直接返回
  const existing = charMap.get(charName);
  if (existing && existing.proc.exitCode === null) return existing;
  // 清理已退出的进程
  if (existing) {
    try { existing.proc.kill(); } catch { /* */ }
    charMap.delete(charName);
  }

  // ── 初始化 Nocturne Memory ──────────────────────────────
  if (blueprint.memoryTree) {
    const treeObj = typeof blueprint.memoryTree === "string"
      ? JSON.parse(blueprint.memoryTree)
      : blueprint.memoryTree;
    try {
      await initCharacterMemory(charName, treeObj);
    } catch (e: any) {
      console.warn(`[NM] 初始化角色 ${charName} 记忆失败: ${e.message}`);
    }
  }

  // ── 获取 boot 记忆 ───────────────────────────────────────
  let bootMemoriesText: string | undefined;
  try {
    bootMemoriesText = await fetchBootMemories(charName);
  } catch { /* Nocturne Memory 不可用 */ }

  // ── 解析 preamble ────────────────────────────────────────
  const preamblePairs = parsePreamble(blueprint.preamble);

  // ── 构建 system prompt（不含 preamble 文本） ────────────
  const systemPrompt = buildSystemPrompt(blueprint, bootMemoriesText);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `char-${charName}-`));
  const promptFile = path.join(tmpDir, "system.md");
  fs.writeFileSync(promptFile, systemPrompt, "utf-8");

  // ── 如果有 preamble，创建 session 文件注入真实对话对 ────
  let sessionFile: string | undefined;
  if (preamblePairs.length >= 2) {
    const sessionDir = path.join(tmpDir, "session");
    const lines = buildSessionLines(preamblePairs, process.cwd());
    sessionFile = writeSessionFile(sessionDir, lines);
  }

  // ── 构造 pi 启动参数 ──────────────────────────────────────
  const piArgs: string[] = [
    "--mode", "rpc",
    "-e", MEMORY_TOOLS_EXT,
    "--no-tools",
    "--tools", "recall,memorize,memory-edit,memory-tree",
    "--append-system-prompt", promptFile,
  ];
  if (sessionFile) {
    piArgs.push("--session", sessionFile);
    // 用 --name 做标识方便调试
    piArgs.push("--name", `char:${charName}`);
  } else {
    piArgs.push("--no-session");
  }

  // ── spawn pi RPC 进程（加载 memory-tools 扩展） ──────────
  const proc = spawn("pi", piArgs, {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });

  const session: CharacterSession = {
    name: charName,
    blueprint,
    lastResponse: "",
    promptFile,
    sessionFile,
    proc,
    pendingResponse: null,
  };

  // 处理 RPC 输出事件
  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line: string) => {
    try {
      const event = JSON.parse(line);
      // 关注 message_end 事件（助手的完整响应）
      if (event.type === "message_end" && event.message?.role === "assistant") {
        // 提取文本内容
        const text = event.message.content
          ?.filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n") || "";
        const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        if (cleaned && session.pendingResponse) {
          session.lastResponse = cleaned;
          session.pendingResponse(cleaned);
          session.pendingResponse = null;
        }
      }
      // RPC 首个响应是 ready 确认
      if (event.type === "response" && event.command === "prompt") {
        // prompt 被接受，等待消息事件
      }
    } catch { /* JSON parse error, ignore */ }
  });

  proc.on("error", () => {
    if (session.pendingResponse) {
      session.pendingResponse("(角色进程异常)");
      session.pendingResponse = null;
    }
  });

  charMap.set(charName, session);
  return session;
}

/**
 * 向角色发送 env 并获取响应（通过持久 RPC 进程）
 */
export function characterAct(
  charSession: CharacterSession,
  envContent: string,
  timeoutMs: number = 20000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!charSession.proc.stdin?.writable) {
      reject(new Error(`角色 ${charSession.name} 的进程不可写`));
      return;
    }

    charSession.pendingResponse = resolve;

    // 通过 RPC 协议发送 prompt
    const rpcMsg = JSON.stringify({ type: "prompt", message: envContent }) + "\n";
    charSession.proc.stdin.write(rpcMsg);

    // 超时
    setTimeout(() => {
      if (charSession.pendingResponse) {
        charSession.pendingResponse = null;
        reject(new Error(`角色 ${charSession.name} 响应超时`));
      }
    }, timeoutMs);
  });
}

export function stopCharacterSession(charSession: CharacterSession): void {
  try {
    charSession.proc.kill();
    const tmpDir = path.dirname(charSession.promptFile);
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch { /* */ }
}

export function stopAllSessions(charMap: CharacterMap): void {
  for (const [, s] of charMap) stopCharacterSession(s);
}
