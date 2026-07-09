/**
 * Runtime Extension — 故事启动器 + GM 交互模式
 *
 * 职责：
 *   /stories list / play / stop / save / load / saves
 *   启动角色 AgentSession，提供 GM 工具集
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { type CharacterSession, startCharacterSession, stopCharacterSession, stopAllSessions } from "./story-session.ts";
import { registerGmTools } from "./gm-tools.ts";

const STORIES_DIR = path.resolve(import.meta.dirname, "../../../pi-characters");
const INDEX_PATH = path.join(STORIES_DIR, "story-index.yaml");

let activeStoryName: string | null = null;
let activeCharacters: Map<string, CharacterSession> = new Map();
let isGmMode = false;

interface StoryIndex {
  stories: Array<{
    name: string;
    path: string;
    created: string;
    lastPlayed: string;
    status: string;
    description: string;
  }>;
}

function loadIndex(): StoryIndex {
  if (!fs.existsSync(INDEX_PATH)) return { stories: [] };
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
  } catch {
    return { stories: [] };
  }
}

function loadStoryYaml(storyName: string): any {
  const storyPath = path.join(STORIES_DIR, storyName, "story.yaml");
  if (!fs.existsSync(storyPath)) return null;
  return JSON.parse(fs.readFileSync(storyPath, "utf-8"));
}

function loadGmYaml(storyName: string): any {
  const gmPath = path.join(STORIES_DIR, storyName, "gm.yaml");
  if (!fs.existsSync(gmPath)) return null;
  return JSON.parse(fs.readFileSync(gmPath, "utf-8"));
}

export default function (pi: ExtensionAPI) {
  // ================================================================
  // /stories — 显示帮助
  // ================================================================
  pi.registerCommand("stories", {
    description: "故事管理命令",
    handler: async (_args, ctx) => {
      ctx.ui.notify("可用命令:\n  /stories-list\n  /stories-play <故事名>\n  /stories-stop\n  /stories-save <存档名>\n  /stories-load <存档名>\n  /stories-saves", "info");
    },
  });

  // ================================================================
  // /stories-list
  // ================================================================
  pi.registerCommand("stories-list", {
    description: "列出所有故事包",
    handler: async (_args, ctx) => {
      const index = loadIndex();
      if (index.stories.length === 0) {
        ctx.ui.notify("没有找到故事包。先用铸造师创建一个吧。", "info");
        return;
      }
      const lines = index.stories.map((s, i) => {
        const status = s.status === "in_progress" ? "▶ 进行中" : s.status === "completed" ? "✓ 已完成" : "○ 未开始";
        return `${i + 1}. ${s.name}  ${status}`;
      });
      ctx.ui.notify(`📚 已有 ${index.stories.length} 个故事包:\n${lines.join("\n")}`, "info");
    },
  });

  // ================================================================
  // /stories play <name>
  // ================================================================
  pi.registerCommand("stories-play", {
    description: "进入故事的 GM 模式",
    handler: async (args, ctx) => {
      const storyName = args?.trim();
      if (!storyName) {
        ctx.ui.notify("用法: /stories play <故事名>", "error");
        return;
      }

      const storyData = loadStoryYaml(storyName);
      if (!storyData) {
        ctx.ui.notify(`故事包 "${storyName}" 不存在。可用: /stories list`, "error");
        return;
      }

      const gmData = loadGmYaml(storyName);

      if (isGmMode && activeStoryName) {
        await stopAllSessions(activeCharacters);
        activeCharacters.clear();
      }

      activeStoryName = storyName;
      isGmMode = true;

      // 自动启动所有角色
      const charList = storyData.characters || [];
      for (const c of charList) {
        try {
          await startCharacterSession(storyName, c.name, STORIES_DIR, activeCharacters);
        } catch (e: any) {
          console.error(`启动角色 ${c.name} 失败:`, e.message);
        }
      }

      // 注册 GM 工具
      registerGmTools(pi, storyName, activeCharacters, STORIES_DIR);

      // 构造 GM 系统提示 — 注入世界观、大纲、叙事风格
      const worldDesc = (storyData.world || "").slice(0, 2000);
      const gmStyle = gmData?.narrative?.style || "自然的叙事风格";
      const gmTone = gmData?.narrative?.tone || "中立";

      // 注入大纲
      const outline = storyData.outline || [];
      let outlinePrompt = "";
      if (outline.length > 0) {
        outlinePrompt = "\n## 故事大纲\n";
        for (const phase of outline) {
          outlinePrompt += `- ${phase.phase}：${phase.description}\n`;
          outlinePrompt += `  方向：${phase.direction}\n`;
          if (phase.scenes?.length) {
            outlinePrompt += `  场景：${phase.scenes.join(" → ")}\n`;
          }
        }
      }

      // 注入开场白
      const opening = storyData.opening || "";

      const gmSystemPrompt = `你是这个故事的 GM（Game Master）。你是用户体验故事的窗口。

## 世界观
${worldDesc}

## 叙事风格
${gmStyle}

## 叙事基调
${gmTone}${outlinePrompt}

## 你的职责
- 用户只跟你对话，你负责推进故事
- 用 start-char 启动角色（已自动启动）
- 用 new-turn 广播场景给角色，收集原始意图（不做叙事）
- 如果多个角色意图有冲突，用 judge 工具仲裁
- 用 write-story 工具产出正史叙事（纯叙事，不含思考/计划）
- 用 observe 查看角色状态（不触发推理）
- 用户是隐形的——角色不知道用户存在
- 输出正史给用户，用 story-log.md 记录

## 工作流程
1. 理解用户意图后，调 new-turn 广播场景
   **重要：env 只描述当前这个瞬间，不要让角色汇报全天计划**
   ✅ "凛放下筷子看了挂钟一眼"
   ❌ "报一下今天的日程吧"
2. 阅读角色返回的原始意图（new-turn 的输出就是 [角色名] act/thought: 内容）
3. 如有冲突意图，调 judge 仲裁
4. 调 write-story（传 scene、intents=从new-turn复制的内容、direction=剧情要点、上轮叙事）→ 得到正史
5. 把正史输出给用户
6. 用 write 工具把纯叙事追加到 story-log.md（格式：## 第X轮\n\n叙事内容\n\n---）
7. 判断是否自动推进下一轮（参考大纲）或等待用户输入

## 自动推进
- write-story 返回后，你判断是否自动推进
- 如果场景还在推进中 → 调 new-turn 继续
- 如果到了自然停顿 → 等待用户输入
- 用户说"继续"→ 恢复推进

## 故事日志
story-log.md 只记录**净化版正史**——只有 write-story 输出的纯叙事，不包含工具调用过程、思考过程、错误信息。
格式：
## 第X轮

叙事内容（纯文本，不加标题）

---`;

      // 注入 GM 系统提示到当前会话
      pi.sendMessage({
        customType: "gm-context",
        content: gmSystemPrompt,
        display: false,
      });

      // 构造 GM 欢迎信息
      const charNames = charList.map((c: any) => c.name).join(", ");
      let welcomeMsg = `📖 进入故事：${storyName}\n` +
        `🌍 ${storyData.world?.slice(0, 100) || ""}...\n` +
        `🎭 角色已就绪：${charNames || "（无角色）"}\n`;

      if (opening) {
        welcomeMsg += `\n📜 开场白：${opening}\n\n要开始吗？`;
      } else {
        welcomeMsg += `\n你现在是 GM。随时可以开始推进故事。`;
      }

      ctx.ui.notify(welcomeMsg, "info");
    },
  });

  // ================================================================
  // /stories stop
  // ================================================================
  pi.registerCommand("stories-stop", {
    description: "退出当前故事",
    handler: async (_args, ctx) => {
      if (!isGmMode || !activeStoryName) {
        ctx.ui.notify("当前没有正在游玩的故事", "info");
        return;
      }

      // 停止所有角色 session
      await stopAllSessions(activeCharacters);
      activeCharacters.clear();
      isGmMode = false;
      activeStoryName = null;

      ctx.ui.notify("故事已退出", "info");
    },
  });

  // ================================================================
  // /stories saves — 列出存档
  // ================================================================
  pi.registerCommand("stories-saves", {
    description: "列出当前故事的存档",
    handler: async (_args, ctx) => {
      if (!activeStoryName) {
        ctx.ui.notify("请先 /stories-play <故事名>", "error");
        return;
      }
      ctx.ui.notify("存档功能待实现", "info");
    },
  });

  // ================================================================
  // /stories-save <name>
  // ================================================================
  pi.registerCommand("stories-save", {
    description: "保存存档",
    handler: async (_args, ctx) => {
      if (!activeStoryName) {
        ctx.ui.notify("请先 /stories-play <故事名>", "error");
        return;
      }
      ctx.ui.notify("存档功能待实现", "info");
    },
  });

  // ================================================================
  // /stories-load <name>
  // ================================================================
  pi.registerCommand("stories-load", {
    description: "读档",
    handler: async (_args, ctx) => {
      if (!activeStoryName) {
        ctx.ui.notify("请先 /stories-play <故事名>", "error");
        return;
      }
      ctx.ui.notify("读档功能待实现", "info");
    },
  });
}
