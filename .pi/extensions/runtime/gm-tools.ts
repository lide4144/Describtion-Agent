/**
 * GM Tools — GM 模式下注册给当前 session 的工具集
 *
 * start-char: 启动角色 AgentSession
 * new-turn:   广播 + 收集角色意图 → 判定 agent 仲裁 → 返回叙事结果
 * observe:    查看角色最新状态
 * stop-char:  停止角色 session
 * console:    维护操作
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import {
  type CharacterMap,
  startCharacterSession,
  characterAct,
  stopCharacterSession,
} from "./story-session.ts";

/**
 * 判定 agent：接收场景 + 所有角色意图，输出仲裁后的叙事
 */
function runJudgment(
  sceneContent: string,
  intents: Array<{ char: string; type: string; content: string }>,
  storyName: string,
  storiesDir: string,
  activeCharacters: CharacterMap,
): string {
  // 构造判定 agent 的 system prompt
  const storyDir = path.join(storiesDir, storyName);
  let gmStyle = "";
  let worldDesc = "";

  // 读 gm.yaml 取叙事风格
  const gmPath = path.join(storyDir, "gm.yaml");
  if (fs.existsSync(gmPath)) {
    try {
      const gm = JSON.parse(fs.readFileSync(gmPath, "utf-8"));
      gmStyle = gm.narrative?.style || "";
    } catch { /* */ }
  }

  // 读 story.yaml 取世界观
  const storyPath = path.join(storyDir, "story.yaml");
  if (fs.existsSync(storyPath)) {
    try {
      const story = JSON.parse(fs.readFileSync(storyPath, "utf-8"));
      worldDesc = (story.world || "").slice(0, 1000);
    } catch { /* */ }
  }

  // 收集角色性格摘要供判定参考
  const charSummaries: string[] = [];
  for (const [name, session] of activeCharacters) {
    const bp = session.blueprint;
    const identity = bp?.identity ? bp.identity.slice(0, 200) : "";
    const behavior = bp?.behavior ? bp.behavior.slice(0, 200) : "";
    charSummaries.push(`${name}: ${identity} ${behavior}`);
  }

  const systemPrompt = `你是一个故事**判定 agent**。你的职责是接收一个场景和所有角色的意图，进行冲突仲裁，输出连贯的叙事文本。

## 世界观
${worldDesc}

## 叙事风格
${gmStyle || "自然平实的叙述"}

## 角色性格参考
${charSummaries.join("\n")}

## 规则
1. 阅读每个角色的意图（act/thought/wait）
2. 识别冲突：比如A想挽留但B想离开，或C想阻止A
3. 根据角色性格判决——thought 内容比 act 更能反映真实意愿
4. 输出一段流畅的叙事文本，包含场景描写、动作、对白
5. 不输出思考过程，直接输出结果
6. 保持叙事连贯性，不要突兀跳转`;

  // 写 system prompt 到临时文件
  const tmpDir = fs.mkdtempSync("/tmp/judge-");
  const promptFile = path.join(tmpDir, "judge.md");
  fs.writeFileSync(promptFile, systemPrompt, "utf-8");

  // 构造输入
  const inputLines = [
    `## 场景`,
    sceneContent,
    ``,
    `## 角色意图`,
  ];
  for (const intent of intents) {
    const tag = intent.type === "act" ? "🎭" : intent.type === "thought" ? "💭" : "⏳";
    inputLines.push(`${tag} ${intent.char} (${intent.type}): ${intent.content}`);
  }
  const input = inputLines.join("\n");

  // spawn 判定 agent
  const result = spawnSync("pi", [
    "--mode", "json",
    "-p", "--no-session",
    "--append-system-prompt", promptFile,
    input,
  ], {
    cwd: process.cwd(),
    encoding: "utf-8",
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  });

  // 清理
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }

  // 提取输出
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

  return lastText.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || "(判定 agent 未输出)";
}

export function registerGmTools(
  pi: ExtensionAPI,
  storyName: string,
  activeCharacters: CharacterMap,
  storiesDir: string,
) {
  // ================================================================
  // Tool: new-turn — 广播 + 收集意图 → 判定
  // ================================================================
  pi.registerTool({
    name: "new-turn",
    label: "New Turn",
    description: "广播新回合到角色，收集意图，经判定 agent 仲裁后返回叙事结果。",
    promptSnippet: "广播新回合并收集角色意图",
    promptGuidelines: [
      "使用 new-turn 推进故事——向角色广播环境后收集意图，判定 agent 会仲裁冲突",
      "使用 targets 参数只向特定角色广播，留空则发给所有活跃角色",
    ],
    parameters: Type.Object({
      content: Type.String({ description: "环境叙事内容——角色感知到的信息" }),
      targets: Type.Optional(Type.Array(Type.String(), {
        description: "指定接收的角色名列表。为空则发给所有活跃角色。",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (activeCharacters.size === 0) {
        return {
          content: [{ type: "text", text: "没有活跃角色。请先用 start-char 启动角色。" }],
          details: {},
          isError: true,
        };
      }

      const targets = params.targets && params.targets.length > 0
        ? params.targets
        : Array.from(activeCharacters.keys());

      // 并发收集所有角色的意图
      const results: Array<{ char: string; type: string; content: string }> = [];

      await Promise.all(targets.map(async (charName) => {
        const session = activeCharacters.get(charName);
        if (!session) {
          results.push({ char: charName, type: "error", content: "未启动" });
          return;
        }
        try {
          const response = await characterAct(session, params.content);
          results.push({ char: charName, type: inferResponseType(response), content: response });
        } catch (e: any) {
          results.push({ char: charName, type: "error", content: e.message });
        }
      }));

      // 判定 agent 仲裁冲突
      const judgment = runJudgment(params.content, results, storyName, storiesDir, activeCharacters);

      return {
        content: [{ type: "text", text: judgment }],
        details: {
          type: "turn_result",
          storyName,
          rawIntents: results,
          judgment,
        },
      };
    },
  });

  // ================================================================
  // Tool: start-char
  // ================================================================
  pi.registerTool({
    name: "start-char",
    label: "Start Character",
    description: "启动故事的某个角色，读取其蓝图。角色启动后可以用 new-turn 与之交互。",
    promptSnippet: "启动一个角色",
    parameters: Type.Object({
      name: Type.String({ description: "角色名" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        await startCharacterSession(storyName, params.name, storiesDir, activeCharacters);
        return {
          content: [{ type: "text", text: `角色 "${params.name}" 已启动` }],
          details: { type: "char_started", name: params.name },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `启动失败: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ================================================================
  // Tool: observe
  // ================================================================
  pi.registerTool({
    name: "observe",
    label: "Observe Character",
    description: "查看角色的最新状态（最近一次响应）。不触发推理，只是读取已有结果。",
    parameters: Type.Object({
      char: Type.String({ description: "角色名" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const session = activeCharacters.get(params.char);
      if (!session) {
        return { content: [{ type: "text", text: `角色 "${params.char}" 未启动` }], details: {}, isError: true };
      }
      return {
        content: [{ type: "text", text: `📋 ${params.char}\n\n最近: ${session.lastResponse || "（暂无活动）"}` }],
        details: { type: "char_observed", name: params.char, lastResponse: session.lastResponse },
      };
    },
  });

  // ================================================================
  // Tool: stop-char
  // ================================================================
  pi.registerTool({
    name: "stop-char",
    label: "Stop Character",
    description: "停止某个角色的 AgentSession。",
    parameters: Type.Object({
      name: Type.String({ description: "角色名" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const session = activeCharacters.get(params.name);
      if (!session) {
        return { content: [{ type: "text", text: `角色 "${params.name}" 未启动` }], details: {}, isError: true };
      }
      stopCharacterSession(session);
      activeCharacters.delete(params.name);
      return { content: [{ type: "text", text: `角色 "${params.name}" 已停止` }], details: { type: "char_stopped", name: params.name } };
    },
  });

  // ================================================================
  // Tool: console
  // ================================================================
  pi.registerTool({
    name: "console",
    label: "GM Console",
    description: "list（列出活跃角色）| status（当前故事状态）",
    parameters: Type.Object({
      action: Type.String({ description: "list | status" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (params.action === "list") {
        const chars = Array.from(activeCharacters.keys());
        if (chars.length === 0) return { content: [{ type: "text", text: "没有活跃角色" }], details: {} };
        return { content: [{ type: "text", text: `活跃角色 (${chars.length}):\n${chars.map((c) => `  - ${c}`).join("\n")}` }], details: {} };
      }
      if (params.action === "status") {
        return { content: [{ type: "text", text: `故事: ${storyName}\n活跃角色: ${activeCharacters.size}` }], details: {} };
      }
      return { content: [{ type: "text", text: `未知操作: ${params.action}` }], details: {}, isError: true };
    },
  });
}

function inferResponseType(response: string): "act" | "thought" | "wait" {
  const lower = response.toLowerCase();
  if (lower.includes("wait") || response.trim() === "") return "wait";
  const hasDialogue = response.includes("「");
  const hasAction = /\*.*\*/.test(response) || response.includes("）") || response.includes(")");
  if (!hasDialogue && !hasAction) return "thought";
  return "act";
}
