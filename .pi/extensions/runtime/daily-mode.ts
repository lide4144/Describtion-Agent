/**
 * Daily Mode — 角色自主日常生活模式
 *
 * 时间推进 → 自动 env 广播 → 角色自主行动 → 日志记录
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CharacterMap } from "./story-session.ts";
import { characterAct } from "./story-session.ts";

// ════════════════════════════════════════════════════════════════════════════
// 时间块
// ════════════════════════════════════════════════════════════════════════════

export interface TimeBlock {
  name: string;
  startHour: number;
  endHour: number;
  envTemplate: string;
}

/** 判断小时是否在时间块内（支持跨天如 22-4） */
export function blockContains(block: TimeBlock, hour: number): boolean {
  if (block.startHour <= block.endHour) {
    return hour >= block.startHour && hour < block.endHour;
  }
  return hour >= block.startHour || hour < block.endHour;
}

/** 默认时间块 */
export const DEFAULT_BLOCKS: TimeBlock[] = [
  { name: "黎明", startHour: 4, endHour: 6, envTemplate: "天还没有完全亮透，窗外传来依稀的鸟鸣。" },
  { name: "早晨", startHour: 6, endHour: 9, envTemplate: "清晨的阳光透过窗户洒进来，空气清新。" },
  { name: "午前", startHour: 9, endHour: 12, envTemplate: "上午的时光安静而从容，适合专注做事。" },
  { name: "中午", startHour: 12, endHour: 13, envTemplate: "正午的阳光明媚，到了吃午饭的时间。" },
  { name: "午后", startHour: 13, endHour: 17, envTemplate: "午后的时间缓缓流淌，阳光斜照。" },
  { name: "傍晚", startHour: 17, endHour: 19, envTemplate: "天色渐晚，夕阳光线温柔地铺满地面。" },
  { name: "夜间", startHour: 19, endHour: 22, envTemplate: "夜色降临，灯火从窗户透出温暖的光。" },
  { name: "深夜", startHour: 22, endHour: 4, envTemplate: "夜深了，万籁俱寂。" },
];

/**
 * 从故事大纲生成时间块
 */
export function timeBlocksFromOutline(outline?: Array<{phase: string; direction?: string}>): TimeBlock[] | null {
  if (!outline || outline.length === 0) return null;

  const timeMap: Record<string, [number, number]> = {
    "黎明": [4, 6], "早晨": [6, 9], "晨间": [6, 9],
    "午前": [9, 12], "上午": [9, 12],
    "中午": [12, 13], "正午": [12, 13],
    "午后": [13, 17], "下午": [13, 17],
    "放学后": [15, 18],
    "傍晚": [17, 19], "黄昏": [17, 19],
    "夜间": [19, 22], "晚上": [19, 22], "晚间": [19, 22],
    "深夜": [22, 4], "午夜": [22, 4],
  };

  const blocks: TimeBlock[] = [];
  for (const phase of outline) {
    const range = timeMap[phase.phase];
    if (range) {
      blocks.push({
        name: phase.phase,
        startHour: range[0],
        endHour: range[1],
        envTemplate: phase.direction || `${phase.phase}的时光安静流逝。`,
      });
    }
  }
  return blocks.length > 0 ? blocks.sort((a, b) => a.startHour - b.startHour) : null;
}

/** 生成当前小时的环境描述 */
export function generateEnv(blocks: TimeBlock[], currentHour: number, charName: string): string {
  const block = blocks.find(b => blockContains(b, currentHour));
  if (!block) return `现在是 ${currentHour}:00，${charName}在过着自己的日常生活。`;

  const hourStr = String(currentHour).padStart(2, "0");
  let result = block.envTemplate
    .replace(/\{hour\}/g, hourStr)
    .replace(/\{char\}/g, charName);

  if (currentHour === block.startHour) {
    result = `${hourStr}:00 — ${result}`;
  }
  return result;
}

/** 获取当前块名 */
export function getCurrentBlockName(blocks: TimeBlock[], hour: number): string {
  const block = blocks.find(b => blockContains(b, hour));
  return block ? block.name : "日常";
}

/** 推进时间 */
export function advanceTime(currentHour: number, blocks: TimeBlock[]): { hour: number; blockName: string; isNewBlock: boolean } {
  const next = (currentHour + 1) % 24;
  const isNewDay = next === 0;

  const currentBlock = blocks.find(b => blockContains(b, currentHour));
  const nextBlock = blocks.find(b => blockContains(b, next));

  const isNewBlock = isNewDay || (currentBlock && nextBlock && currentBlock.name !== nextBlock.name);

  return { hour: next, blockName: nextBlock ? nextBlock.name : "日常", isNewBlock };
}

// ════════════════════════════════════════════════════════════════════════════
// Daily Mode 状态管理
// ════════════════════════════════════════════════════════════════════════════

export interface DailyState {
  active: boolean;
  storyName: string;
  currentHour: number;
  tickCount: number;
  blocks: TimeBlock[];
  /** 当天已推进的轮次日志 */
  dailyLog: string;
}

/**
 * 创建初始每日状态
 */
export function createDailyState(storyName: string, outline?: Array<{phase: string; direction?: string}>): DailyState {
  const blocks = timeBlocksFromOutline(outline) || DEFAULT_BLOCKS;
  return {
    active: false,
    storyName,
    currentHour: 6, // 默认从早晨开始
    tickCount: 0,
    blocks,
    dailyLog: "",
  };
}

/**
 * 执行一次 tick：推进时间，返回要给角色发送的 env
 */
export function executeTick(state: DailyState): {
  state: DailyState;
  hour: number;
  blockName: string;
  isNewBlock: boolean;
  env: string;
} {
  const { hour, blockName, isNewBlock } = advanceTime(state.currentHour, state.blocks);
  const charPlaceholder = "{char}"; // 调用时替换为具体角色名
  const env = generateEnv(state.blocks, hour, charPlaceholder);

  return {
    state: {
      ...state,
      currentHour: hour,
      tickCount: state.tickCount + 1,
    },
    hour,
    blockName,
    isNewBlock,
    env,
  };
}

/**
 * 执行一次完整的 daily tick（对所有角色广播 env + 收集响应）
 */
export async function doDailyTick(
  state: DailyState,
  charNames: string[],
  charMap: CharacterMap,
  storiesDir: string,
): Promise<{state: DailyState; responses: Array<{char: string; action: string}>; logEntry: string}> {
  const tick = executeTick(state);
  const timeStr = String(tick.hour).padStart(2, "0");

  // 如果开启了新的块，写块标题
  let logEntry = "";
  if (tick.isNewBlock) {
    logEntry += `\n## ${tick.blockName} (${timeStr}:00)\n`;
  }

  // 广播给所有角色
  const responses: Array<{char: string; action: string}> = [];
  for (const name of charNames) {
    const session = charMap.get(name);
    if (!session) continue;

    // 用角色名替换 {char} 占位符
    const env = tick.env.replace(/\{char\}/g, name);
    try {
      const action = await characterAct(session, env);
      responses.push({ char: name, action });
      logEntry += `- [${timeStr}:00] ${name}: ${action.slice(0, 200)}\n`;
    } catch (e: any) {
      responses.push({ char: name, action: `(无响应: ${e.message})` });
      logEntry += `- [${timeStr}:00] ${name}: (无响应)\n`;
    }
  }

  // 追加到 daily-log.md
  const logPath = path.join(storiesDir, state.storyName, "daily-log.md");
  try {
    fs.appendFileSync(logPath, logEntry, "utf-8");
  } catch { /* */ }

  return {
    state: tick.state,
    responses,
    logEntry,
  };
}
