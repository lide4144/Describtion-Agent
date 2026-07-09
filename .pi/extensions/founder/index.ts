/**
 * Founder Extension
 *
 * 铸造师：理解故事文本、Tavern 角色卡，通过 Grilling 产出角色蓝图。
 *
 * Tools:
 *   import_tavern <path> — 导入 Tavern 角色卡 (PNG/JSON)，全量解包并返回结构化摘要
 *
 * Commands:
 *   /founder <input> — 启动铸造模式
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Type } from "typebox";

const FORGE_SCRIPT = path.resolve(
  import.meta.dirname,
  "../../../tavern-cards/tavern-cards/scripts/tavern-cards-forge.mjs",
);

interface TavernCardSummary {
  /** 项目名称 */
  name: string;
  /** 角色描述 */
  description: string;
  /** 角色卡类型: charactercard 或 worldbook */
  form: string;
  /** 是否有 MVU 变量系统 */
  hasMVU: boolean;
  /** 条目统计: 类型名 → 条目数 */
  entryCounts: Record<string, number>;
  /** 策略配置摘要 */
  strategySummary: {
    constant: number;   // 常亮条目数
    selective: number;  // 关键词触发条目数
    unknown: number;
  };
  /** 是否有 EJS 模板 */
  hasEJS: boolean;
  /** 正则脚本数量 */
  regexScriptCount: number;
  /** Tavern Helper 脚本数量 */
  helperScriptCount: number;
  /** 开场白数量 */
  firstMessageCount: number;
  /** 所有条目的内容摘要 */
  entries: Array<{
    type: string;
    name: string;
    part?: string;
    strategy: string;
    keywords: string[];
    abstract: string;
    content: string;
  }>;
  /** 错误信息 */
  error?: string;
}

function unpackTavernCard(filePath: string, outputDir: string): TavernCardSummary | { error: string } {
  // 1. 调 forge unpack
  const result = spawnSync(
    process.execPath,
    [FORGE_SCRIPT, "unpack", "adhoc", "--file", filePath, "--output", outputDir],
    { encoding: "utf-8", timeout: 30000 },
  );

  if (result.status !== 0) {
    return { error: `forge unpack 失败: ${result.stderr || result.stdout || `exit code ${result.status}`}` };
  }

  // 2. 读取 state.json
  const statePath = path.join(outputDir, "tavern-cards-state.json");
  if (!fs.existsSync(statePath)) {
    return { error: "解包后未找到 tavern-cards-state.json" };
  }

  let state: any;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch (e: any) {
    return { error: `解析 state.json 失败: ${e.message}` };
  }

  // 3. 统计条目
  const entryManifest = state.entryManifest || {};
  const entryCounts: Record<string, number> = {};
  let constantCount = 0;
  let selectiveCount = 0;
  let unknownStrategy = 0;

  for (const [typeName, entries] of Object.entries(entryManifest)) {
    const typed = entries as Record<string, any>;
    entryCounts[typeName] = Object.keys(typed).length;
    for (const entry of Object.values(typed)) {
      const e = entry as any;
      if (e.strategy?.type === "constant") constantCount++;
      else if (e.strategy?.type === "selective") selectiveCount++;
      else unknownStrategy++;
    }
  }

  // 4. 检测 EJS（遍历内容文件）
  let hasEJS = false;
  const entries: TavernCardSummary["entries"] = [];

  for (const [typeName, entriesOfType] of Object.entries(entryManifest)) {
    for (const [entryName, entryData] of Object.entries(entriesOfType as Record<string, any>)) {
      const ed = entryData as any;
      let content = "";

      if (ed.path) {
        const contentPath = path.join(outputDir, ed.path);
        if (fs.existsSync(contentPath)) {
          content = fs.readFileSync(contentPath, "utf-8");
        }
      } else if (ed.contents) {
        content = (ed.contents as Array<{ content?: string; file?: string }>)
          .map((frag) => {
            if (frag.content) return frag.content;
            if (frag.file) {
              const fp = path.join(outputDir, frag.file);
              return fs.existsSync(fp) ? fs.readFileSync(fp, "utf-8") : `[missing: ${frag.file}]`;
            }
            return "";
          })
          .join("\n");
      }

      if (content.includes("<%") || content.includes("%>")) {
        hasEJS = true;
      }

      entries.push({
        type: typeName,
        name: entryName,
        part: ed.part,
        strategy: ed.strategy?.type || "none",
        keywords: ed.keywords || [],
        abstract: ed.abstract || "",
        content: content.slice(0, 2000), // 截断避免 token 爆炸
      });
    }
  }

  // 5. 检查 first_messages
  const firstMessages = state.first_messages || [];
  let firstMessageCount = firstMessages.length;

  // 6. 检查 regex_scripts
  const regexScripts = state.regex_scripts || {};
  const regexScriptCount = Object.keys(regexScripts).length;

  // 7. 检查 tavern_helper 脚本
  const helperScripts = state.extensions?.tavern_helper?.scripts || {};
  const helperScriptCount = Object.keys(helperScripts).length;

  return {
    name: state.projectName || state.worldbookName || "(unnamed)",
    description: state.description || "",
    form: state.form || "charactercard",
    hasMVU: state.mvu === true,
    entryCounts,
    strategySummary: {
      constant: constantCount,
      selective: selectiveCount,
      unknown: unknownStrategy,
    },
    hasEJS,
    regexScriptCount,
    helperScriptCount,
    firstMessageCount,
    entries,
  };
}

function formatSummary(summary: TavernCardSummary): string {
  const lines: string[] = [];
  lines.push(`# 角色卡：${summary.name}`);
  lines.push(`类型：${summary.form === "charactercard" ? "角色卡" : "世界书"}`);
  if (summary.description) lines.push(`描述：${summary.description}`);
  lines.push("");

  lines.push("## 结构总览");
  lines.push(`- MVU 变量系统：${summary.hasMVU ? "✅ 有" : "❌ 无"}`);
  lines.push(`- EJS 条件模板：${summary.hasEJS ? "✅ 有" : "❌ 无"}`);
  lines.push(`- 正则脚本：${summary.regexScriptCount} 条`);
  lines.push(`- 辅助脚本：${summary.helperScriptCount} 条`);
  lines.push(`- 开场白：${summary.firstMessageCount} 条`);
  lines.push("");

  lines.push("## 条目分布");
  for (const [type, count] of Object.entries(summary.entryCounts)) {
    lines.push(`- ${type}：${count} 条`);
  }
  lines.push("");

  lines.push("## 策略配置");
  lines.push(`- 常亮（始终注入）：${summary.strategySummary.constant} 条`);
  lines.push(`- 选择性（关键词触发）：${summary.strategySummary.selective} 条`);
  if (summary.strategySummary.unknown > 0) {
    lines.push(`- 未配置：${summary.strategySummary.unknown} 条`);
  }
  lines.push("");

  lines.push("## 条目内容");
  for (const entry of summary.entries) {
    const strategyLabel = entry.strategy === "constant" ? "🔵常亮" : entry.strategy === "selective" ? "🟢选择性" : "⚪无策略";
    const keywords = entry.keywords.length > 0 ? ` [关键词: ${entry.keywords.join(", ")}]` : "";
    const partInfo = entry.part ? ` (${entry.part})` : "";
    lines.push(`### ${entry.type}：${entry.name} ${strategyLabel}${keywords}${partInfo}`);
    if (entry.abstract) lines.push(`> ${entry.abstract}`);
    if (entry.content) {
      const contentPreview = entry.content.length > 500 ? entry.content.slice(0, 500) + "\n...(截断)" : entry.content;
      lines.push(contentPreview);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Founder system prompt, loaded from .pi/agents/founder.md
function loadFounderSystemPrompt(): string {
  const agentPath = path.resolve(import.meta.dirname, "../../agents/founder.md");
  if (fs.existsSync(agentPath)) {
    let content = fs.readFileSync(agentPath, "utf-8");
    // Strip frontmatter (YAML between --- markers)
    content = content.replace(/^---[\s\S]*?---\n?/, "");
    return content.trim();
  }
  return "";
}

export default function (pi: ExtensionAPI) {
  // ============================================================
  // Command: /founder
  // ============================================================
  pi.registerCommand("founder", {
    description: "进入铸造师模式，从故事材料中提炼角色蓝图",
    handler: async (_args, ctx) => {
      const founderPrompt = loadFounderSystemPrompt();
      if (!founderPrompt) {
        ctx.ui.notify("找不到 founder agent 定义 (.pi/agents/founder.md)", "error");
        return;
      }

      // Send a brief notification to user
      ctx.ui.notify("⚒️ 铸造师模式已激活", "info");

      // The user's text after /founder becomes the input
      // We inject a system-like message to set the context
      pi.sendMessage({
        customType: "founder-context",
        content: founderPrompt,
        display: false,
      });
    },
  });

  // ============================================================
  // Tool: import_tavern
  // ============================================================
  pi.registerTool({
    name: "import_tavern",
    label: "Import Tavern Card",
    description: "导入 SillyTavern 角色卡（PNG 或 JSON 格式），全量解包并返回结构化摘要。铸造师用此工具读取 Tavern 卡的内容。",
    parameters: Type.Object({
      path: Type.String({ description: "Tavern 角色卡的文件路径（支持 .png 或 .json）" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const filePath = path.resolve(params.path);

      if (!fs.existsSync(filePath)) {
        return {
          content: [{ type: "text", text: `文件不存在: ${filePath}` }],
          details: {},
          isError: true,
        };
      }

      // 创建临时目录用于解包
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tavern-import-"));
      let cleanTemp = true;

      try {
        const result = unpackTavernCard(filePath, tmpDir);

        if ("error" in result) {
          return {
            content: [{ type: "text", text: result.error }],
            details: {},
            isError: true,
          };
        }

        const summary = formatSummary(result);

        // 保留临时目录用于后续访问（返回路径让 LLM 可读原始文件）
        cleanTemp = false;

        return {
          content: [{ type: "text", text: summary }],
          details: {
            type: "tavern_card_summary",
            unpackDir: tmpDir,
            cardName: result.name,
            form: result.form,
            entryCount: result.entries.length,
            hasMVU: result.hasMVU,
            hasEJS: result.hasEJS,
          },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `导入失败: ${e.message}` }],
          details: {},
          isError: true,
        };
      } finally {
        // 清理临时目录
        if (cleanTemp && fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    },
  });

  // ============================================================
  // Tool: save_story — 创建故事包目录 + story.yaml + gm.yaml
  // ============================================================
  pi.registerTool({
    name: "save_story",
    label: "Save Story Pack",
    description: "创建故事包的基础目录和元信息文件（story.yaml + gm.yaml）。调用此工具后再用 save_character 逐个添加角色。",
    parameters: Type.Object({
      storyName: Type.String({ description: "故事名，将作为目录名（如 卫宫士郎-日常沙盒）" }),
      worldDescription: Type.String({ description: "共享世界观——所有角色普遍知道的世界设定" }),
      gmNarrativeStyle: Type.String({ description: "GM 的叙事风格描述（如 细腻的环境描写，注意感官细节）" }),
      gmTone: Type.String({ description: "GM 的叙事基调（如 温暖但有张力）" }),
      npcs: Type.Optional(Type.String({
        description: "NPC 列表，JSON 数组字符串，每项 {name, description, keywords}。可选。",
      })),
      cognitiveBoundaries: Type.Optional(Type.String({
        description: "认知边界——哪些信息是角色普遍知道的（字符串描述）。可选。",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const storyDir = path.resolve(
        import.meta.dirname,
        "../../../pi-characters",
        params.storyName,
      );

      try {
        // 创建目录结构
        fs.mkdirSync(path.join(storyDir, "chars"), { recursive: true });
        fs.mkdirSync(path.join(storyDir, "saves"), { recursive: true });

        // 解析 NPC 列表
        let npcs: Array<{name: string; description: string; keywords: string[]}> = [];
        if (params.npcs) {
          try { npcs = JSON.parse(params.npcs); } catch { /* ignore */ }
        }

        // ── 写入 story.yaml ──────────────────────────────────
        const storyData = {
          name: params.storyName,
          createdAt: new Date().toISOString(),
          world: params.worldDescription,
          cognitiveBoundaries: params.cognitiveBoundaries || "",
          characters: [] as Array<{name: string; role: string; blueprint: string}>,
        };
        fs.writeFileSync(
          path.join(storyDir, "story.yaml"),
          JSON.stringify(storyData, null, 2),
          "utf-8",
        );

        // ── 写入 gm.yaml ────────────────────────────────────
        const gmData = {
          narrative: {
            style: params.gmNarrativeStyle,
            tone: params.gmTone,
          },
          npcs,
          sceneDefaults: {
            time: "day",
          },
        };
        fs.writeFileSync(
          path.join(storyDir, "gm.yaml"),
          JSON.stringify(gmData, null, 2),
          "utf-8",
        );

        // ── 更新 story-index.yaml ────────────────────────────
        const indexPath = path.resolve(
          import.meta.dirname,
          "../../../pi-characters/story-index.yaml",
        );
        let index: { stories: Array<any> } = { stories: [] };
        if (fs.existsSync(indexPath)) {
          try {
            index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
          } catch { /* reset */ }
        }

        // 更新或添加
        const existingIdx = index.stories.findIndex(s => s.name === params.storyName);
        const entry = {
          name: params.storyName,
          path: params.storyName,
          created: new Date().toISOString(),
          lastPlayed: "",
          status: "created" as const,
          description: params.worldDescription.slice(0, 100),
        };
        if (existingIdx >= 0) {
          index.stories[existingIdx] = { ...index.stories[existingIdx], ...entry };
        } else {
          index.stories.push(entry);
        }
        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");

        return {
          content: [{
            type: "text",
            text: `故事包已创建：${storyDir}/
- story.yaml（世界观）
- gm.yaml（GM 配置）
- chars/（角色蓝图目录）

下一步请用 save_character 逐个添加角色。`,
          }],
          details: {
            type: "story_saved",
            path: storyDir,
            files: ["story.yaml", "gm.yaml"],
          },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `保存故事包失败: ${e.message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // ============================================================
  // Tool: save_character — 保存单个角色蓝图到故事包
  // ============================================================
  pi.registerTool({
    name: "save_character",
    label: "Save Character to Story",
    description: "将角色蓝图保存到已有故事包的 chars/ 目录。必须先调用 save_story 创建故事包。",
    parameters: Type.Object({
      storyName: Type.String({ description: "所属故事名" }),
      name: Type.String({ description: "角色名（如 卫宫士郎）" }),
      role: Type.Optional(Type.String({
        description: "角色身份：protagonist（主角）/ supporting（配角）/ self（用户自角色）/ npc",
      })),
      identity: Type.String({ description: "第一人称身份声明——'我是……'" }),
      preamble: Type.String({ description: "破限对话内容（user/assistant 对话对）" }),
      memoryTree: Type.String({ description: "初始记忆树，JSON 格式。根节点: identity, relationships, events, locations, observations, world" }),
      behavior: Type.String({ description: "行为倾向——自然语言描述角色怎么做、怎么说话" }),
      toolOverrides: Type.Optional(Type.String({
        description: "工具说明覆盖（JSON 可选字段）。可选。",
      })),
      thinkingFormat: Type.Optional(Type.String({
        description: "思考格式模板。可选，不填则使用默认模板。",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const storyDir = path.resolve(
        import.meta.dirname,
        "../../../pi-characters",
        params.storyName,
      );
      const charFile = path.join(storyDir, "chars", `${params.name}.yaml`);

      // 检查故事包是否存在
      if (!fs.existsSync(path.join(storyDir, "story.yaml"))) {
        return {
          content: [{ type: "text", text: `故事包不存在: ${storyDir}。请先调用 save_story。` }],
          details: {},
          isError: true,
        };
      }

      try {
        // 确保 chars 目录存在
        fs.mkdirSync(path.join(storyDir, "chars"), { recursive: true });

        // 角色数据
        let memoryTreeParsed: any = {};
        if (params.memoryTree) {
          try { memoryTreeParsed = JSON.parse(params.memoryTree); } catch { memoryTreeParsed = params.memoryTree; }
        }

        let toolOverridesParsed: any = undefined;
        if (params.toolOverrides) {
          try { toolOverridesParsed = JSON.parse(params.toolOverrides); } catch { /* */ }
        }

        const charData = {
          name: params.name,
          role: params.role || "protagonist",
          identity: params.identity,
          preamble: params.preamble,
          memoryTree: memoryTreeParsed,
          behavior: params.behavior,
          toolOverrides: toolOverridesParsed,
          thinkingFormat: params.thinkingFormat || "",
          createdAt: new Date().toISOString(),
        };

        fs.writeFileSync(charFile, JSON.stringify(charData, null, 2), "utf-8");

        // ── 同步更新 story.yaml 的 characters 列表 ──────────
        const storyPath = path.join(storyDir, "story.yaml");
        let storyData: any = {};
        try {
          storyData = JSON.parse(fs.readFileSync(storyPath, "utf-8"));
        } catch { /* */ }

        if (!storyData.characters) storyData.characters = [];
        const existingChar = storyData.characters.findIndex(
          (c: any) => c.name === params.name,
        );
        const charEntry = {
          name: params.name,
          role: params.role || "protagonist",
          blueprint: `chars/${params.name}.yaml`,
        };
        if (existingChar >= 0) {
          storyData.characters[existingChar] = charEntry;
        } else {
          storyData.characters.push(charEntry);
        }
        storyData.updatedAt = new Date().toISOString();
        fs.writeFileSync(storyPath, JSON.stringify(storyData, null, 2), "utf-8");

        return {
          content: [{ type: "text", text: `角色 ${params.name} 已保存到故事包 ${params.storyName} 的 ${charFile}` }],
          details: {
            type: "character_saved",
            storyName: params.storyName,
            characterName: params.name,
            path: charFile,
          },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `保存角色失败: ${e.message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });
}
