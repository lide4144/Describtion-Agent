/**
 * Story Session — 角色会话管理
 *
 * 每个角色启动一个持久的 pi RPC 子进程，避免每次 new-turn 冷启动。
 * 角色进程在 startCharacterSession 时启动，stopCharacterSession 时终止。
 * 通过 stdin/stdout JSONL 通信（pi RPC 协议）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createInterface } from "node:readline";

export interface CharacterSession {
  name: string;
  blueprint: any;
  lastResponse: string;
  promptFile: string;
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

function buildSystemPrompt(blueprint: any): string {
  const parts: string[] = [];
  if (blueprint.identity) parts.push(blueprint.identity);
  if (blueprint.preamble) parts.push(`\n${blueprint.preamble}`);
  if (blueprint.behavior) parts.push(`\n${blueprint.behavior}`);

  if (blueprint.memoryTree) {
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

  // 预生成 system prompt 文件
  const systemPrompt = buildSystemPrompt(blueprint);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `char-${charName}-`));
  const promptFile = path.join(tmpDir, "system.md");
  fs.writeFileSync(promptFile, systemPrompt, "utf-8");

  // spawn pi RPC 进程
  const proc = spawn("pi", [
    "--mode", "rpc",
    "--no-session", "-ne",
    "--append-system-prompt", promptFile,
  ], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });

  const session: CharacterSession = {
    name: charName,
    blueprint,
    lastResponse: "",
    promptFile,
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
  timeoutMs: number = 30000,
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
    fs.rmSync(path.dirname(charSession.promptFile), { recursive: true, force: true });
  } catch { /* */ }
}

export function stopAllSessions(charMap: CharacterMap): void {
  for (const [, s] of charMap) stopCharacterSession(s);
}
