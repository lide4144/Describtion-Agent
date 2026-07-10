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
import * as os from "node:os";
import { Type } from "typebox";
import {
  type CharacterMap,
  startCharacterSession,
  characterAct,
  stopCharacterSession,
} from "./story-session.ts";
import { createDailyState, doDailyTick, getCurrentBlockName } from "./daily-mode.ts";
import type { DailyState } from "./daily-mode.ts";

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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "writer-"));
  const promptFile = path.join(tmpDir, "writer.md");
  fs.writeFileSync(promptFile, systemPrompt, "utf-8");

  const result = spawnSync("pi", [
    "--mode", "text", "-p", "--no-session", "-ne",
    "--append-system-prompt", promptFile,
    "写",
  ], {
    encoding: "utf-8", timeout: 120000, maxBuffer: 50 * 1024 * 1024,
  });

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }

  const output = (result.stdout || "").trim();
  return output || "(写作 agent 未输出)";
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-"));
  const pf = path.join(tmpDir, "judge.md");
  fs.writeFileSync(pf, systemPrompt, "utf-8");

  const r = spawnSync("pi", ["--mode","text","-p","--no-session","-ne","--append-system-prompt", pf, input], {
    encoding: "utf-8", timeout: 60000, maxBuffer: 10 * 1024 * 1024,
  });
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }

  return (r.stdout || "").trim() || "无冲突";
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

  // 注册 archive-scene 工具
  registerArchiveScene(pi, storyName, storiesDir);

  // 注册 fixer 工具
  registerFixer(pi, storyName, storiesDir, activeCharacters);

  // 注册每日模式工具
  registerDailyTools(pi, storyName, storiesDir, activeCharacters);
}

// 每日模式状态（模块级变量）
let _dailyState: DailyState | null = null;

export function initDailyState(storyName: string, outline?: any): void {
  _dailyState = createDailyState(storyName, outline);
}

export function getDailyState(): DailyState | null {
  return _dailyState;
}

// ═══════════════════════════════════════════════════════════════
// 每日模式工具
// ═══════════════════════════════════════════════════════════════

function registerDailyTools(
  pi: ExtensionAPI,
  storyName: string,
  storiesDir: string,
  activeCharacters: CharacterMap,
) {
  // daily-start
  pi.registerTool({
    name: "daily-start",
    label: "Daily Start",
    description: "启动每日模式。时间自动推进，角色自主行动。",
    parameters: Type.Object({
      startHour: Type.Optional(Type.Number({ description: "起始小时 (0-23)，默认 6" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!_dailyState) {
        return { content: [{ type: "text", text: "请先 /stories-play 进入故事" }], details: {}, isError: true };
      }
      if (_dailyState.active) {
        return { content: [{ type: "text", text: "每日模式已在运行" }], details: {}, isError: true };
      }

      _dailyState.active = true;
      if (params.startHour !== undefined && params.startHour >= 0 && params.startHour < 24) {
        _dailyState.currentHour = params.startHour;
      }

      const blockName = getCurrentBlockName(_dailyState.blocks, _dailyState.currentHour);
      const hourStr = String(_dailyState.currentHour).padStart(2, "0");
      const chars = Array.from(activeCharacters.keys());

      return {
        content: [{ type: "text", text: `🌅 每日模式已启动\n时间: ${hourStr}:00 (${blockName})\n角色: ${chars.join(", ")}\n用 daily-tick 推进时间` }],
        details: { type: "daily_started", hour: _dailyState.currentHour, blockName },
      };
    },
  });

  // daily-tick
  pi.registerTool({
    name: "daily-tick",
    label: "Daily Tick",
    description: "推进一小时，角色自主行动。",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (!_dailyState || !_dailyState.active) {
        return { content: [{ type: "text", text: "请先用 daily-start 启动每日模式" }], details: {}, isError: true };
      }

      const charNames = Array.from(activeCharacters.keys());
      if (charNames.length === 0) {
        return { content: [{ type: "text", text: "没有活跃角色" }], details: {}, isError: true };
      }

      try {
        const result = await doDailyTick(_dailyState, charNames, activeCharacters, storiesDir);
        _dailyState = result.state;

        const hourStr = String(result.hour).padStart(2, "0");
        const blockName = getCurrentBlockName(result.state.blocks, result.state.currentHour);

        const lines = [`⏱ ${hourStr}:00 (${blockName}) 第 ${result.state.tickCount} 轮`];
        for (const r of result.responses) {
          const s = r.action.length > 100 ? r.action.slice(0, 100) + "…" : r.action;
          lines.push(`  ${r.char}: ${s}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { type: "daily_tick", hour: result.hour, blockName, responses: result.responses },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `推进失败: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // daily-stop
  pi.registerTool({
    name: "daily-stop",
    label: "Daily Stop",
    description: "停止每日模式。",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (!_dailyState || !_dailyState.active) {
        return { content: [{ type: "text", text: "每日模式未在运行" }], details: {}, isError: true };
      }
      _dailyState.active = false;
      return {
        content: [{ type: "text", text: `🌙 每日模式已停止（共推进 ${_dailyState.tickCount} 轮）` }],
        details: { type: "daily_stopped", ticks: _dailyState.tickCount },
      };
    },
  });

  // daily-status
  pi.registerTool({
    name: "daily-status",
    label: "Daily Status",
    description: "查看每日模式当前状态。",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (!_dailyState) {
        return { content: [{ type: "text", text: "每日模式未初始化" }], details: {}, isError: true };
      }
      const hourStr = String(_dailyState.currentHour).padStart(2, "0");
      const blockName = getCurrentBlockName(_dailyState.blocks, _dailyState.currentHour);
      return {
        content: [{ type: "text", text:
          `${_dailyState.active ? "🟢 运行中" : "⚪ 已停止"}\n` +
          `时间: ${hourStr}:00 (${blockName})\n` +
          `已推进: ${_dailyState.tickCount} 轮\n` +
          `活跃角色: ${activeCharacters.size} 个`
        }],
        details: { type: "daily_status", active: _dailyState.active, hour: _dailyState.currentHour, ticks: _dailyState.tickCount },
      };
    },
  });
}

// ═══════════════════════════════════════════════════════════════
// Nocturne Memory HTTP 辅助
// ═══════════════════════════════════════════════════════════════

const NM_BASE = "http://127.0.0.1:8233/api";

async function nmPost(
  ns: string,
  parentPath: string,
  content: string,
  priority: number,
  title: string,
  domain: string,
): Promise<void> {
  const url = new URL(`${NM_BASE}/browse/node`);
  url.searchParams.set("namespace", ns);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      parent_path: parentPath, content, priority, title, domain, disclosure: "public",
    }),
  });
  if (!res.ok && res.status !== 422) { // 422 = already exists, skip
    const text = await res.text().catch(() => "");
    throw new Error(`NM POST ${domain}://${parentPath}/${title}: ${res.status} — ${text.slice(0, 150)}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// archive-scene 工具
// ═══════════════════════════════════════════════════════════════

/**
 * 注册 archive-scene 工具
 */
function registerArchiveScene(pi: ExtensionAPI, storyName: string, storiesDir: string) {
  pi.registerTool({
    name: "archive-scene",
    label: "Archive Scene",
    description: "将当前场景归档到角色的历史记忆。用 write-story 产正史后调用。",
    parameters: Type.Object({
      sceneName: Type.Optional(Type.String({ description: "场景名（如 早晨的厨房），自动生成 timestamp 前缀" })),
      summaries: Type.String({ description: "JSON 对象：角色名 → 场景摘要。如 {\"卫宫士郎\": \"我做了早饭……\", \"远坂凛\": \"我去蹭饭……\"}" }),
      narrative: Type.String({ description: "完整正史叙事文本" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const timestamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
        const safeName = params.sceneName
          ? `${timestamp}_${params.sceneName}`
          : `scene_${timestamp}`;

        let summaries: Record<string, string> = {};
        try { summaries = JSON.parse(params.summaries); } catch { /* */ }

        const charNames = Object.keys(summaries);
        if (charNames.length === 0) {
          return { content: [{ type: "text", text: "没有角色摘要，无法归档" }], details: {}, isError: true };
        }

        let archiveCount = 0;

        for (const [charName, summary] of Object.entries(summaries)) {
          // 创建分类节点 scenes（如果已存在则跳过 422）
          await nmPost(charName, "", "", 0, "scenes", "history");

          // 写入场景摘要 → history://scenes/{safeName}
          await nmPost(charName, "scenes", `【${safeName}】${summary}`, 5, safeName, "history");

          // 写入完整叙事 → history_raw://scenes/{safeName}
          await nmPost(charName, "", "", 0, "scenes", "history_raw");
          await nmPost(charName, "scenes", `【${safeName}】\n${params.narrative}`, 1, safeName, "history_raw");

          archiveCount++;
        }

        // 同步写入 story-log.md
        const logPath = path.join(storiesDir, storyName, "story-log.md");
        try {
          const roundHeader = `\n\n## ${safeName}\n\n`;
          fs.appendFileSync(logPath, roundHeader + params.narrative + "\n\n---", "utf-8");
        } catch { /* story-log.md 不可写时跳过 */ }

        return {
          content: [{ type: "text", text: `📦 场景已归档: ${safeName}\n   角色: ${charNames.join(", ")}\n   History: 写入 ${archiveCount} 个角色\n   Story-log: 已追加` }],
          details: { type: "scene_archived", sceneName: safeName, characters: charNames },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `归档失败: ${e.message}` }], details: {}, isError: true };
      }
    },
  });
}

// ═══════════════════════════════════════════════════════════════
// fixer — 日志修复工具
// ═══════════════════════════════════════════════════════════════

/**
 * 解析 story-log.md 为段落数组
 */
function parseStoryLogSections(content: string): Array<{index: number; header: string; content: string}> {
  const raw = content.replace(/\r\n/g, "\n").trim();
  if (!raw) return [];
  const sections = raw.split(/\n---\n/).map(s => s.trim()).filter(Boolean);
  return sections.map((s, i) => {
    const lines = s.split("\n");
    const headerLine = lines.find(l => l.startsWith("## "));
    const header = headerLine ? headerLine.replace(/^##\s+/, "") : `section_${i + 1}`;
    return { index: i, header, content: s };
  });
}

/**
 * 注册 fixer 工具
 */
function registerFixer(
  pi: ExtensionAPI,
  storyName: string,
  storiesDir: string,
  activeCharacters: CharacterMap,
) {
  pi.registerTool({
    name: "fixer",
    label: "Fixer",
    description: "日志修复工具。\n" +
      "  log list — 列出 story-log 段落\n" +
      "  log get <N> — 查看段落 N\n" +
      "  log edit <N> <text> — 编辑段落 N（用 | 分隔多个参数）\n" +
      "  log delete <N> — 删除段落 N\n" +
      "  nm get <uri> — 查看记忆节点原始数据\n" +
      "  nm list [char] — 列出角色的记忆\n" +
      "  nm delete <uri> — 删除记忆节点（危险！）",
    parameters: Type.Object({
      action: Type.String({ description: "操作命令: log list | log get <N> | log edit <N> | <text> | log delete <N> | nm get <uri> | nm list [char] | nm delete <uri>" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const action = params.action.trim();

      // ── log 子命令 ─────────────────────────────────────
      if (action.startsWith("log ")) {
        return handleLogAction(action, storyName, storiesDir);
      }

      // ── nm 子命令 ──────────────────────────────────────
      if (action.startsWith("nm ")) {
        return handleNmAction(action);
      }

      return { content: [{ type: "text", text: `未知操作: ${action}\n可用: log list, log get <N>, log edit <N> | <内容>, log delete <N>, nm get <uri>, nm list [char], nm delete <uri>` }], details: {}, isError: true };
    },
  });
}

/** 处理 log 子命令 */
async function handleLogAction(
  action: string,
  storyName: string,
  storiesDir: string,
): Promise<{content: Array<{type: string; text: string}>; details: any; isError?: boolean}> {
  const logPath = path.join(storiesDir, storyName, "story-log.md");
  let content = "";
  try {
    content = fs.readFileSync(logPath, "utf-8");
  } catch {
    return { content: [{ type: "text", text: "story-log.md 不存在或不可读" }], details: {}, isError: true };
  }

  const parts = action.split(" ");
  const sub = parts[1]; // list | get | edit | delete

  if (sub === "list") {
    const sections = parseStoryLogSections(content);
    if (sections.length === 0) {
      return { content: [{ type: "text", text: "story-log 为空" }], details: {} };
    }
    const lines = sections.map(s => `${s.index}. ${s.header}`);
    return { content: [{ type: "text", text: `📋 story-log (${sections.length} 段):\n${lines.join("\n")}` }], details: { type: "fixer_log_list", count: sections.length } };
  }

  if (sub === "get") {
    const idx = parseInt(parts[2], 10);
    if (isNaN(idx)) return { content: [{ type: "text", text: "用法: fixer({ action: 'log get <N>' })" }], details: {}, isError: true };
    const sections = parseStoryLogSections(content);
    if (idx < 0 || idx >= sections.length) {
      return { content: [{ type: "text", text: `段落 ${idx} 不存在（共 ${sections.length} 段）` }], details: {}, isError: true };
    }
    return { content: [{ type: "text", text: `## 段落 ${idx}: ${sections[idx].header}\n\n${sections[idx].content}` }], details: { type: "fixer_log_get", index: idx } };
  }

  if (sub === "edit") {
    const idx = parseInt(parts[2], 10);
    if (isNaN(idx)) return { content: [{ type: "text", text: "用法: fixer({ action: 'log edit <N> | <新内容>' })" }], details: {}, isError: true };
    // 用 | 分隔内容和索引
    const pipeIdx = action.indexOf("|");
    if (pipeIdx === -1) return { content: [{ type: "text", text: "请用 | 分隔段落号和内容，如: fixer({ action: 'log edit 0 | ## 新标题\n\n新内容' })" }], details: {}, isError: true };
    const newText = action.slice(pipeIdx + 1).trim();

    const sections = parseStoryLogSections(content);
    if (idx < 0 || idx >= sections.length) {
      return { content: [{ type: "text", text: `段落 ${idx} 不存在（共 ${sections.length} 段）` }], details: {}, isError: true };
    }
    sections[idx] = { ...sections[idx], content: newText };
    const newContent = sections.map(s => s.content).join("\n\n---\n\n");
    fs.writeFileSync(logPath, newContent, "utf-8");
    return { content: [{ type: "text", text: `✅ 段落 ${idx} 已更新` }], details: { type: "fixer_log_edit", index: idx } };
  }

  if (sub === "delete") {
    const idx = parseInt(parts[2], 10);
    if (isNaN(idx)) return { content: [{ type: "text", text: "用法: fixer({ action: 'log delete <N>' })" }], details: {}, isError: true };
    const sections = parseStoryLogSections(content);
    if (idx < 0 || idx >= sections.length) {
      return { content: [{ type: "text", text: `段落 ${idx} 不存在（共 ${sections.length} 段）` }], details: {}, isError: true };
    }
    sections.splice(idx, 1);
    if (sections.length === 0) {
      fs.writeFileSync(logPath, "", "utf-8");
    } else {
      fs.writeFileSync(logPath, sections.map(s => s.content).join("\n\n---\n\n"), "utf-8");
    }
    return { content: [{ type: "text", text: `✅ 段落 ${idx} 已删除` }], details: { type: "fixer_log_delete", index: idx } };
  }

  return { content: [{ type: "text", text: `未知 log 子命令: ${sub}（可用: list, get, edit, delete）` }], details: {}, isError: true };
}

/** 处理 nm 子命令 */
async function handleNmAction(
  action: string,
): Promise<{content: Array<{type: string; text: string}>; details: any; isError?: boolean}> {
  const parts = action.split(" ");
  const sub = parts[1]; // get | list | delete

  if (sub === "get") {
    const uri = parts.slice(2).join(" ");
    if (!uri) return { content: [{ type: "text", text: "用法: fixer({ action: 'nm get core://relationships/某人' })" }], details: {}, isError: true };
    const m = uri.match(/^([a-z][a-z0-9_]*):\/\/(.+)$/);
    if (!m) return { content: [{ type: "text", text: `无效 URI: ${uri}` }], details: {}, isError: true };
    const domain = m[1];
    const path = m[2];

    try {
      const url = new URL(`${NM_BASE}/browse/node`);
      url.searchParams.set("namespace", "");
      url.searchParams.set("domain", domain);
      url.searchParams.set("path", path);
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const node = data.node || {};
      const lines = [
        `📄 ${node.uri}`,
        `   内容: ${(node.content || "(空)").slice(0, 500)}`,
        `   优先级: ${node.priority}`,
        `   域名: ${node.domain}`,
        `   路径: ${node.path}`,
        `   创建时间: ${node.created_at || "N/A"}`,
        `   是否虚拟: ${node.is_virtual}`,
      ];
      if (data.children?.length > 0) {
        lines.push(`   子节点: ${data.children.map((c: any) => c.uri).join(", ")}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: { type: "fixer_nm_get", uri } };
    } catch (e: any) {
      return { content: [{ type: "text", text: `读取失败: ${e.message}` }], details: {}, isError: true };
    }
  }

  if (sub === "list") {
    const charName = parts.slice(2).join(" ") || "";
    try {
      const url = new URL(`${NM_BASE}/browse/node`);
      url.searchParams.set("namespace", charName);
      url.searchParams.set("domain", "core");
      url.searchParams.set("path", "");
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items = (data.children || []).map((c: any) => `${c.uri} (p=${c.priority})`);
      return { content: [{ type: "text", text: `📋 ${charName || "(current)"} 的记忆:\n${items.join("\n") || "(空)"}` }], details: { type: "fixer_nm_list", char: charName } };
    } catch (e: any) {
      return { content: [{ type: "text", text: `列表失败: ${e.message}` }], details: {}, isError: true };
    }
  }

  if (sub === "delete") {
    const uri = parts.slice(2).join(" ");
    if (!uri) return { content: [{ type: "text", text: "用法: fixer({ action: 'nm delete core://...' })" }], details: {}, isError: true };
    const m = uri.match(/^([a-z][a-z0-9_]*):\/\/(.+)$/);
    if (!m) return { content: [{ type: "text", text: `无效 URI: ${uri}` }], details: {}, isError: true };
    const domain = m[1], path = m[2];

    try {
      // 递归删除子节点
      async function rmRecursive(p: string): Promise<void> {
        try {
          const url = new URL(`${NM_BASE}/browse/node`);
          url.searchParams.set("namespace", "");
          url.searchParams.set("domain", domain);
          url.searchParams.set("path", p);
          const res = await fetch(url.toString());
          if (res.ok) {
            const data = await res.json();
            for (const child of data.children || []) {
              await rmRecursive(child.path);
            }
          }
        } catch { /* */ }
        // 删除自身
        try {
          const delUrl = new URL(`${NM_BASE}/browse/node`);
          delUrl.searchParams.set("namespace", "");
          delUrl.searchParams.set("domain", domain);
          delUrl.searchParams.set("path", p);
          await fetch(delUrl.toString(), { method: "DELETE" });
        } catch { /* */ }
      }
      await rmRecursive(path);
      return { content: [{ type: "text", text: `✅ 已删除: ${uri}` }], details: { type: "fixer_nm_delete", uri } };
    } catch (e: any) {
      return { content: [{ type: "text", text: `删除失败: ${e.message}` }], details: {}, isError: true };
    }
  }

  return { content: [{ type: "text", text: `未知 nm 子命令: ${sub}（可用: get, list, delete）` }], details: {}, isError: true };
}

function inferResponseType(r: string): "act" | "thought" | "wait" {
  const l = r.toLowerCase();
  if (l.includes("wait") || r.trim() === "") return "wait";
  const hasD = r.includes("「");
  const hasA = /\*.*\*/.test(r) || r.includes("）") || r.includes(")");
  if (!hasD && !hasA) return "thought";
  return "act";
}
