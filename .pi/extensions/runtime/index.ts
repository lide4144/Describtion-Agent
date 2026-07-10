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
import { registerGmTools, initDailyState, type GmToolState } from "./gm-tools.ts";
import { saveStory, loadStory, listSaves, clearNamespace } from "./save-load.ts";

const STORIES_DIR = path.resolve(import.meta.dirname, "../../../pi-characters");
const INDEX_PATH = path.join(STORIES_DIR, "story-index.yaml");

let activeStoryName: string | null = null;
let activeCharacters: Map<string, CharacterSession> = new Map();
const gmState: GmToolState = { storyName: null, activeCharacters: new Map() };
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

/**
 * 从 pi session JSONL 文件中提取最后 N 轮对话，格式化为 GM 可读的上下文。
 * 这是纯函数，不依赖任何 pi API 或外部服务，可独立测试。
 */
function readSessionContext(sessionFilePath: string, maxPairs: number = 6): string {
  if (!fs.existsSync(sessionFilePath)) return "";
  const content = fs.readFileSync(sessionFilePath, "utf-8");
  const messages: Array<{role: string; content: string}> = [];
  for (const line of content.trim().split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message" && entry.message?.role) {
        const c = entry.message.content;
        const text = typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n")
            : "";
        if (text.trim()) messages.push({ role: entry.message.role, content: text.trim() });
      }
    } catch { /* skip malformed lines */ }
  }
  const lastPairs = messages.slice(-maxPairs * 2);
  if (lastPairs.length < 2) return "";
  let result = "\n\n## 上次会话记录\n以下是之前存档的最后几轮对话，帮你衔接上下文：\n\n";
  for (let i = 0; i < lastPairs.length; i += 2) {
    const userMsg = lastPairs[i];
    const asstMsg = lastPairs[i + 1];
    if (userMsg && userMsg.role === "user") {
      result += `用户说：${userMsg.content.slice(0, 600)}\n\n`;
      if (asstMsg && asstMsg.role === "assistant") {
        const clean = asstMsg.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        if (clean) result += `你回复：${clean.slice(0, 1200)}\n\n`;
      }
    }
  }
  return result;
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
  // GM 工具在扩展加载时注册（不是 /stories-play handler 内部），热重载后仍在
  registerGmTools(pi, gmState, STORIES_DIR);

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
      const storyName = (args || "").trim();
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

      // 清空旧记忆，从蓝图重新导入（play 就是新开始，load 才恢复）
      const charList = storyData.characters || [];
      for (const c of charList) {
        try {
          await clearNamespace(c.name);
        } catch { /* namespace 不存在时跳过 */ }
      }

      // 自动启动所有角色
      for (const c of charList) {
        try {
          await startCharacterSession(storyName, c.name, STORIES_DIR, activeCharacters);
        } catch (e: any) {
          console.error(`启动角色 ${c.name} 失败:`, e.message);
        }
      }

      // 更新 GM 工具状态（工具已在扩展加载时注册）
      gmState.storyName = storyName;
      gmState.activeCharacters = activeCharacters;

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

      // 初始化 daily state（在 gm-tools 模块内管理）
      initDailyState(storyName, storyData.outline);

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
- 输出正史给用户，story-log.md 会自动记录

## 工作流程
1. 理解用户意图后，调 new-turn 广播场景
   **重要：env 只描述当前这个瞬间，不要让角色汇报全天计划**
   ✅ "凛放下筷子看了挂钟一眼"
   ❌ "报一下今天的日程吧"
2. 阅读角色返回的原始意图（new-turn 的输出就是 [角色名] act/thought: 内容）
3. 如有冲突意图，调 judge 仲裁
4. 调 write-story（传 scene、intents=从new-turn复制的内容、direction=剧情要点、上轮叙事）→ 得到正史
5. 把正史输出给用户
6. 判断是否自动推进下一轮（参考大纲）或等待用户输入

## 自动推进
- write-story 返回后，你判断是否自动推进
- 如果场景还在推进中 → 调 new-turn 继续
- 如果到了自然停顿 → 等待用户输入
- 用户说"继续"→ 恢复推进

## 故事日志
pi-characters/${storyName}/story-log.md 由系统自动维护——每次 write-story 返回后自动追加纯叙事。
格式：
## 第N轮

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
      gmState.storyName = null;
      gmState.activeCharacters = new Map();
      isGmMode = false;
      activeStoryName = null;

      ctx.ui.notify("故事已退出", "info");
    },
  });

  // ================================================================
  // /stories-saves — 列出存档
  // ================================================================
  pi.registerCommand("stories-saves", {
    description: "列出当前故事的存档",
    handler: async (_args, ctx) => {
      if (!activeStoryName) {
        ctx.ui.notify("请先 /stories-play <故事名>", "error");
        return;
      }
      try {
        const saves = await listSaves(activeStoryName, STORIES_DIR);
        if (saves.length === 0) {
          ctx.ui.notify("当前故事没有存档", "info");
          return;
        }
        const lines = saves.map((s, i) =>
          `${i + 1}. ${s.name}  (${s.characters.join(", ")})  ${s.nodeCount}条记忆  ${s.savedAt.slice(0, 10)}`
        );
        ctx.ui.notify(`📂 存档列表 (${saves.length}):\n${lines.join("\n")}`, "info");
      } catch (e: any) {
        ctx.ui.notify(`列出存档失败: ${e.message}`, "error");
      }
    },
  });

  // ================================================================
  // /stories-save <name>
  // ================================================================
  pi.registerCommand("stories-save", {
    description: "保存存档: /stories-save <存档名>",
    handler: async (args, ctx) => {
      if (!activeStoryName) {
        ctx.ui.notify("请先 /stories-play <故事名>", "error");
        return;
      }
      const saveName = args?.trim();
      if (!saveName) {
        ctx.ui.notify("用法: /stories-save <存档名>", "error");
        return;
      }
      try {
        const summary = await saveStory({
          storyName: activeStoryName,
          saveName,
          storiesDir: STORIES_DIR,
          activeCharacters,
        });

        // 同时保存当前 pi 会话到存档目录（跨设备迁移用）
        try {
          const sessionFile = ctx.sessionManager.getSessionFile();
          if (sessionFile && fs.existsSync(sessionFile)) {
            const saveSessionPath = path.join(STORIES_DIR, activeStoryName, "saves", saveName, ".session.jsonl");
            fs.copyFileSync(sessionFile, saveSessionPath);
          }
        } catch { /* 非关键操作 */ }

        ctx.ui.notify(
          `💾 已存档: ${saveName}\n` +
          `   角色: ${summary.characters.join(", ")}\n` +
          `   记忆: ${summary.nodeCount} 条`,
          "info",
        );
      } catch (e: any) {
        ctx.ui.notify(`存档失败: ${e.message}`, "error");
      }
    },
  });

  // ================================================================
  // /stories-load <name>
  // ================================================================
  pi.registerCommand("stories-load", {
    description: "读档: /stories-load <存档名>",
    handler: async (args, ctx) => {
      if (!activeStoryName) {
        ctx.ui.notify("请先 /stories-play <故事名>", "error");
        return;
      }
      const saveName = args?.trim();
      if (!saveName) {
        ctx.ui.notify("用法: /stories-load <存档名>", "error");
        return;
      }

      // 读档需要重启角色，先通知
      ctx.ui.notify(`⏳ 正在读档: ${saveName}……`, "info");

      try {
        // 1. 停止所有当前角色 session
        await stopAllSessions(activeCharacters);
        activeCharacters.clear();

        // 2. 执行读档（恢复记忆 + story-log），不重启角色（session switch 会杀进程）
        const summary = await loadStory({
          storyName: activeStoryName,
          saveName,
          storiesDir: STORIES_DIR,
          activeCharacters,
          restartCharacter: async () => {}, // no-op，角色在 withSession 中重启
        });

        // 3. 切换 pi session 到存档中的会话文件
        const saveSessionPath = path.join(STORIES_DIR, activeStoryName, "saves", saveName, ".session.jsonl");
        const hasSession = fs.existsSync(saveSessionPath);

        if (hasSession) {
          await ctx.switchSession(saveSessionPath, {
            withSession: async (newCtx) => {
              // 重新启动角色 RPC 进程
              const storyPath = path.join(STORIES_DIR, activeStoryName!, "story.yaml");
              let charList: Array<{name: string}> = [];
              if (fs.existsSync(storyPath)) {
                try {
                  const data = JSON.parse(fs.readFileSync(storyPath, "utf-8"));
                  charList = data.characters || [];
                } catch { /* */ }
              }
              for (const c of charList) {
                try {
                  await startCharacterSession(activeStoryName!, c.name, STORIES_DIR, activeCharacters);
                } catch { /* */ }
              }
              gmState.storyName = activeStoryName;
              gmState.activeCharacters = activeCharacters;

              // 注入 GM 上下文
              const storyData = loadStoryYaml(activeStoryName!);
              const gmData = loadGmYaml(activeStoryName!);
              const worldDesc = (storyData?.world || "").slice(0, 2000);
              const gmStyle = gmData?.narrative?.style || "自然的叙事风格";
              const gmTone = gmData?.narrative?.tone || "中立";
              const outline = storyData?.outline || [];
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
              const restoredPrompt = `你是这个故事的 GM。\n\n## 世界观\n${worldDesc}\n\n## 叙事风格\n${gmStyle}\n\n## 叙事基调\n${gmTone}${outlinePrompt}`;
              await newCtx.sendMessage({
                customType: "gm-context",
                content: restoredPrompt,
                display: false,
              });
            },
          });
        }

        ctx.ui.notify(
          `📂 已读档: ${saveName}\n` +
          `   角色: ${summary.characters.join(", ")}\n` +
          `   记忆: ${summary.nodeCount} 条恢复\n` +
          `   故事日志: ${summary.storyLogRestored ? "已恢复" : "无"}` +
          (hasSession ? "\n   会话上下文: 已恢复" : ""),
          "info",
        );
      } catch (e: any) {
        ctx.ui.notify(`读档失败: ${e.message}`, "error");
        // 尝试重新启动角色（可能部分角色已恢复）
        gmState.storyName = null;
        gmState.activeCharacters = new Map();
        const storyPath = path.join(STORIES_DIR, activeStoryName, "story.yaml");
        if (fs.existsSync(storyPath)) {
          try {
            const story = JSON.parse(fs.readFileSync(storyPath, "utf-8"));
            for (const c of story.characters || []) {
              try {
                await startCharacterSession(activeStoryName, c.name, STORIES_DIR, activeCharacters);
              } catch { /* */ }
            }
          } catch { /* */ }
        }
      }
    },
  });
}
