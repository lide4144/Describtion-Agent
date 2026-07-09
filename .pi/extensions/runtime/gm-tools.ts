/**
 * GM Tools — GM 模式下注册给当前 session 的工具集
 *
 * new-turn:     广播 env + 收集角色意图（原始，无叙事）
 * judge:        多角色冲突时仲裁（可选）
 * write-story:  根据意图+方向+文风产出正史
 * start-char:   启动角色 AgentSession
 * observe:      查看角色最新状态
 * stop-char:    停止角色 session
 * console:      维护操作
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
 * 写作 agent：根据意图 + 方向 + 文风，输出纯叙事
 */
function runWriter(
  scene: string,
  intents: Array<{ char: string; type: string; content: string }>,
  direction: string,
  previousNarrative: string,
  style: string,
  judgment: string,
): string {
  const systemPrompt = `你是一个故事**写作 agent**。你的职责只有一个：根据素材写出优美的叙事。

## 规则
- 输出纯叙事文本，不包含思考、说明、meta 评论
- 使用第三人称叙事
- 把角色意图中的「我」转为角色名
- 严格按 direction 的要点推进，不要擅自添加剧情发展
- 保持与上一轮叙事的衔接

## 叙事风格
${style || "自然的平实叙事"}

## 上一轮叙事
${previousNarrative.slice(0, 2000) || "（开头）"}

## 当前场景
${scene}

## 剧情要点
${direction || "按角色意图自然推进"}

## 角色意图
${intents.map(i => `[${i.char}] ${i.type}: ${i.content}`).join("\n")}

${judgment ? `## 冲突仲裁\n${judgment}` : ""}

请输出叙事。`;

  const tmpDir = fs.mkdtempSync("/tmp/writer-");
  const promptFile = path.join(tmpDir, "writer.md");
  fs.writeFileSync(promptFile, systemPrompt, "utf-8");

  const result = spawnSync("pi", [
    "--mode", "json", "-p", "--no-session",
    "--append-system-prompt", promptFile,
    "写",
  ], {
    encoding: "utf-8", timeout: 30000, maxBuffer: 10 * 1024 * 1024,
  });

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }

  const lines = (result.stdout || "").split("\n").filter(Boolean);
  let lastText = "";
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        const t = (ev.message.content || [])
          .filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
        if (t) lastText = t;
      }
    } catch { /* */ }
  }
  return lastText.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || "(写作 agent 未输出)";
}

/**
 * 判定 agent：只做冲突仲裁，不写叙事
 */
function runJudge(
  scene: string,
  intents: Array<{ char: string; type: string; content: string }>,
  storyName: string,
  storiesDir: string,
  activeCharacters: CharacterMap,
): string {
  const storyDir = path.join(storiesDir, storyName);
  let worldDesc = "";
  const storyPath = path.join(storyDir, "story.yaml");
  if (fs.existsSync(storyPath)) {
    try { worldDesc = (JSON.parse(fs.readFileSync(storyPath, "utf-8")).world || "").slice(0, 1000); } catch { /* */ }
  }

  const charSummaries: string[] = [];
  for (const [name, s] of activeCharacters) {
    const bp = s.blueprint;
    const id = bp?.identity?.slice(0, 200) || "";
    const bh = bp?.behavior?.slice(0, 200) || "";
    charSummaries.push(`${name}: ${id} ${bh}`);
  }

  const systemPrompt = `你是一个故事**判定 agent**。职责：阅读角色意图，识别冲突，按性格判决。

## 世界观
${worldDesc}

## 角色性格参考
${charSummaries.join("\n")}

## 规则
1. 判断角色意图之间有无冲突（A想挽留B想离开，C想阻止A等）
2. 有冲突时：按角色性格判定谁成立
3. 无冲突时：输出"无冲突"
4. 只输出结构化的仲裁结果，不写叙事`;

  const input = `## 场景\n${scene}\n\n## 角色意图\n${intents.map(i => `[${i.char}] ${i.type}: ${i.content}`).join("\n")}`;

  const tmpDir = fs.mkdtempSync("/tmp/judge-");
  const pf = path.join(tmpDir, "judge.md");
  fs.writeFileSync(pf, systemPrompt, "utf-8");

  const r = spawnSync("pi", ["--mode","json","-p","--no-session","--append-system-prompt", pf, input], {
    encoding: "utf-8", timeout: 30000, maxBuffer: 10 * 1024 * 1024,
  });
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }

  const lines = (r.stdout || "").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        const t = (ev.message.content || [])
          .filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
        if (t) return t;
      }
    } catch { /* */ }
  }
  return "无冲突";
}

export function registerGmTools(
  pi: ExtensionAPI,
  storyName: string,
  activeCharacters: CharacterMap,
  storiesDir: string,
) {
  // ================================================================
  // Tool: new-turn — 广播 + 收集角色意图（原始）
  // ================================================================
  pi.registerTool({
    name: "new-turn",
    label: "New Turn",
    description: "广播新回合到角色，收集每个角色的原始意图（act/thought/wait）。不写叙事，不做仲裁。",
    promptSnippet: "广播新回合并收集角色意图",
    parameters: Type.Object({
      content: Type.String({ description: "环境叙事内容——角色感知到的信息" }),
      targets: Type.Optional(Type.Array(Type.String(), {
        description: "指定接收的角色名列表。为空则发给所有活跃角色。",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (activeCharacters.size === 0) {
        return { content: [{ type: "text", text: "没有活跃角色。请先用 start-char 启动角色。" }], details: {}, isError: true };
      }

      const targets = params.targets && params.targets.length > 0
        ? params.targets
        : Array.from(activeCharacters.keys());

      // 并发收集意图
      const results: Array<{ char: string; type: string; content: string }> = [];
      await Promise.all(targets.map(async (name) => {
        const s = activeCharacters.get(name);
        if (!s) { results.push({ char: name, type: "error", content: "未启动" }); return; }
        try {
          const r = await characterAct(s, params.content);
          results.push({ char: name, type: inferResponseType(r), content: r });
        } catch (e: any) {
          results.push({ char: name, type: "error", content: e.message });
        }
      }));

      return {
        content: [{ type: "text", text: results.map(r =>
          `[${r.char}] ${r.type}: ${r.content.slice(0, 2000)}`).join("\n\n") }],
        details: { type: "raw_intents", storyName, intents: results },
      };
    },
  });

  // ================================================================
  // Tool: judge — 冲突仲裁
  // ================================================================
  pi.registerTool({
    name: "judge",
    label: "Judge",
    description: "对多角色意图进行冲突仲裁。通常在 new-turn 返回有冲突意图时调用。无冲突时输出'无冲突'。",
    parameters: Type.Object({
      scene: Type.String({ description: "当前场景描述" }),
      intents: Type.String({ description: "角色意图文本（可从 new-turn 结果复制）" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const intents = params.intents.split("\n").filter(Boolean).map(line => {
        const m = line.match(/^\[(.+?)\]\s*(\w+):\s*(.+)/);
        if (m) return { char: m[1], type: m[2], content: m[3] };
        return { char: "?", type: "?", content: line };
      });

      const result = runJudge(params.scene, intents, storyName, storiesDir, activeCharacters);
      return {
        content: [{ type: "text", text: result }],
        details: { type: "judgment", result },
      };
    },
  });

  // ================================================================
  // Tool: write-story — 写正史
  // ================================================================
  pi.registerTool({
    name: "write-story",
    label: "Write Story",
    description: "根据角色意图 + 方向 + 文风，写出正史叙事。在 new-turn 拿到意图后（和/或 judge 后）调用。",
    promptSnippet: "根据意图和方向写出正史叙事",
    parameters: Type.Object({
      scene: Type.String({ description: "当前场景描述" }),
      intents: Type.String({ description: "角色意图文本（从 new-turn 结果复制）" }),
      direction: Type.String({ description: "剧情要点——结构化列出本轮要推进的内容" }),
      previousNarrative: Type.Optional(Type.String({ description: "上一轮完整叙事，用于衔接" })),
      judgment: Type.Optional(Type.String({ description: "冲突仲裁结果（如有）" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const storyDir = path.join(storiesDir, storyName);
      let style = "";
      const gmPath = path.join(storyDir, "gm.yaml");
      if (fs.existsSync(gmPath)) {
        try { style = JSON.parse(fs.readFileSync(gmPath, "utf-8")).narrative?.style || ""; } catch { /* */ }
      }

      // 解析意图文本
      const intentLines: Array<{ char: string; type: string; content: string }> = [];
      for (const line of params.intents.split("\n").filter(Boolean)) {
        const m = line.match(/^\[(.+?)\]\s*(\w+):\s*(.+)/);
        if (m) intentLines.push({ char: m[1], type: m[2], content: m[3] });
      }

      // 上一轮叙事
      let prevNarrative = "";
      const logPath = path.join(storyDir, "story-log.md");
      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, "utf-8");
        const sections = content.split("\n## ");
        if (sections.length > 1) {
          prevNarrative = sections[sections.length - 1].replace(/^第\d+轮\n/, "").trim().slice(0, 2000);
        }
      }
      if (params.previousNarrative) prevNarrative = params.previousNarrative;

      const narrative = runWriter(
        params.scene,
        intentLines,
        params.direction,
        prevNarrative,
        style,
        params.judgment || "",
      );

      return {
        content: [{ type: "text", text: narrative }],
        details: { type: "narrative", narrative, style },
      };
    },
  });

  // ================================================================
  // Tool: start-char
  // ================================================================
  pi.registerTool({
    name: "start-char",
    label: "Start Character",
    description: "启动故事的某个角色。",
    parameters: Type.Object({ name: Type.String({ description: "角色名" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        await startCharacterSession(storyName, params.name, storiesDir, activeCharacters);
        return { content: [{ type: "text", text: `角色 "${params.name}" 已启动` }], details: { type: "char_started", name: params.name } };
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
    description: "查看角色的最新状态（最近一次响应）。只读，不触发推理。",
    parameters: Type.Object({ char: Type.String({ description: "角色名" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const s = activeCharacters.get(params.char);
      if (!s) return { content: [{ type: "text", text: `角色 "${params.char}" 未启动` }], details: {}, isError: true };
      return {
        content: [{ type: "text", text: `📋 ${params.char}\n\n最近: ${s.lastResponse || "（暂无活动）"}` }],
        details: { type: "char_observed", name: params.char, lastResponse: s.lastResponse },
      };
    },
  });

  // ================================================================
  // Tool: stop-char
  // ================================================================
  pi.registerTool({
    name: "stop-char",
    label: "Stop Character",
    description: "停止某个角色。",
    parameters: Type.Object({ name: Type.String({ description: "角色名" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const s = activeCharacters.get(params.name);
      if (!s) return { content: [{ type: "text", text: `角色 "${params.name}" 未启动` }], details: {}, isError: true };
      stopCharacterSession(s);
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
    parameters: Type.Object({ action: Type.String({ description: "list | status" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (params.action === "list") {
        const chars = Array.from(activeCharacters.keys());
        if (chars.length === 0) return { content: [{ type: "text", text: "没有活跃角色" }], details: {} };
        return { content: [{ type: "text", text: `活跃角色 (${chars.length}):\n${chars.map(c => `  - ${c}`).join("\n")}` }], details: {} };
      }
      if (params.action === "status") {
        return { content: [{ type: "text", text: `故事: ${storyName}\n活跃角色: ${activeCharacters.size}` }], details: {} };
      }
      return { content: [{ type: "text", text: `未知操作: ${params.action}` }], details: {}, isError: true };
    },
  });
}

function inferResponseType(r: string): "act" | "thought" | "wait" {
  const l = r.toLowerCase();
  if (l.includes("wait") || r.trim() === "") return "wait";
  const hasD = r.includes("「");
  const hasA = /\*.*\*/.test(r) || r.includes("）") || r.includes(")");
  if (!hasD && !hasA) return "thought";
  return "act";
}
