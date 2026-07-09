/**
 * Story Session — 角色会话管理
 *
 * 每个 new-turn 调用通过 spawn 一个临时 pi 子进程来获取角色响应。
 * 子进程加载角色蓝图作为 system prompt，接收 GM 的 env 作为输入。
 * 每次调用独立——角色没有持久进程。
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface CharacterSession {
  name: string;
  blueprint: any;
  lastResponse: string;
  /** prompt 文件路径（用于复用） */
  promptFile: string;
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
 * 启动角色——主要是加载蓝图并确认存在
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

  const existing = charMap.get(charName);
  if (existing) return existing;

  // 预生成 system prompt 文件
  const systemPrompt = buildSystemPrompt(blueprint);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `char-${charName}-`));
  const promptFile = path.join(tmpDir, "system.md");
  fs.writeFileSync(promptFile, systemPrompt, "utf-8");

  const session: CharacterSession = { name: charName, blueprint, lastResponse: "", promptFile };
  charMap.set(charName, session);
  return session;
}

/**
 * 向角色发送 env 并获取响应（同步子进程，单次调用）
 */
export async function characterAct(
  charSession: CharacterSession,
  envContent: string,
  timeoutMs: number = 30000,
): Promise<string> {
  const result = spawnSync("pi", [
    "--mode", "json",
    "-p",
    "--no-session",
    "--append-system-prompt", charSession.promptFile,
    envContent,
  ], {
    cwd: process.cwd(),
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });

  // 从 JSON lines 输出中提取最后一个 assistant message
  const lines = (result.stdout || "").split("\n").filter(Boolean);
  let lastText = "";

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = (event.message.content || [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
        if (text) lastText = text;
      }
    } catch { /* */ }
  }

  // 去掉 think 标签
  const cleaned = lastText.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  charSession.lastResponse = cleaned || "(无响应)";
  return charSession.lastResponse;
}

export function stopCharacterSession(charSession: CharacterSession): void {
  try { fs.rmSync(path.dirname(charSession.promptFile), { recursive: true, force: true }); } catch { /* */ }
}

export function stopAllSessions(charMap: CharacterMap): void {
  for (const [, s] of charMap) stopCharacterSession(s);
}
