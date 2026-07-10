/**
 * daily-mode-test.mjs — 每日模式引擎测试
 *
 * 测试时间块、env 生成、日志记录等纯函数
 *
 * 用法: node tests/daily-mode-test.mjs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let passed = 0;
let failed = 0;

function assertEq(desc, expected, actual) {
  const ok = expected === actual;
  console.log(`  ${ok ? '✅' : '❌'} ${ok ? 'PASS' : 'FAIL'}: ${desc}`);
  if (!ok) { console.log(`     Expected: ${JSON.stringify(expected)}\n     Actual:   ${JSON.stringify(actual)}`); failed++; }
  else passed++;
}

function assertContains(desc, needle, haystack) {
  const ok = typeof haystack === 'string' && haystack.includes(needle);
  console.log(`  ${ok ? '✅' : '❌'} ${ok ? 'PASS' : 'FAIL'}: ${desc}`);
  if (!ok) { console.log(`     Expected to contain: ${needle}\n     Haystack: ${String(haystack).slice(0, 200)}`); failed++; }
  else passed++;
}

function assertOk(desc, value) {
  const ok = !!value;
  console.log(`  ${ok ? '✅' : '❌'} ${ok ? 'PASS' : 'FAIL'}: ${desc}`);
  if (!ok) { console.log(`     Value: ${String(value)}`); failed++; }
  else passed++;
}

// ══════════════════════════════════════════════════════════════════
// Daily Mode 引擎（纯函数部分）
// ══════════════════════════════════════════════════════════════════

/** 时间块定义 */
class TimeBlock {
  constructor(name, startHour, endHour, envTemplate) {
    this.name = name;
    this.startHour = startHour; // 包含
    this.endHour = endHour;     // 不包含
    this.envTemplate = envTemplate;
  }
  /** 判断当前小时是否在这个块内（支持跨天如 22-4） */
  contains(hour) {
    if (this.startHour <= this.endHour) {
      return hour >= this.startHour && hour < this.endHour;
    } else {
      // 跨天：如 22 ≤ hour 或 hour < 4
      return hour >= this.startHour || hour < this.endHour;
    }
  }
}

/** 默认时间块（从故事大纲生成，或 fallback） */
function getDefaultTimeBlocks() {
  return [
    new TimeBlock('黎明', 4, 6, '天还没有完全亮透，窗外传来依稀的鸟鸣。'),
    new TimeBlock('早晨', 6, 9, '清晨的阳光透过窗户洒进来，空气清新。'),
    new TimeBlock('午前', 9, 12, '上午的时光安静而从容，适合专注做事。'),
    new TimeBlock('中午', 12, 13, '正午的阳光明媚，到了吃午饭的时间。'),
    new TimeBlock('午后', 13, 17, '午后的时间缓缓流淌，阳光斜照。'),
    new TimeBlock('傍晚', 17, 19, '天色渐晚，夕阳光线温柔地铺满地面。'),
    new TimeBlock('夜间', 19, 22, '夜色降临，灯火从窗户透出温暖的光。'),
    new TimeBlock('深夜', 22, 4, '夜深了，万籁俱寂。'),
  ];
}

/** 从 story.yaml outline 生成时间块 */
function timeBlocksFromOutline(outline) {
  if (!outline || !Array.isArray(outline) || outline.length === 0) return null;

  const timeMap = {
    '黎明': [4, 6], '早晨': [6, 9], '晨间': [6, 9],
    '午前': [9, 12], '上午': [9, 12],
    '中午': [12, 13], '正午': [12, 13],
    '午后': [13, 17], '下午': [13, 17],
    '放学后': [15, 18],
    '傍晚': [17, 19], '黄昏': [17, 19],
    '夜间': [19, 22], '晚上': [19, 22], '晚间': [19, 22],
    '深夜': [22, 4], '午夜': [22, 4],
  };

  const blocks = [];
  for (const phase of outline) {
    const name = phase.phase;
    const range = timeMap[name];
    if (range) {
      blocks.push(new TimeBlock(name, range[0], range[1],
        phase.direction || `${name}的时光安静流逝。`));
    }
  }
  return blocks.length > 0 ? blocks.sort((a, b) => a.startHour - b.startHour) : null;
}

/** 生成当前时间块的环境描述 */
function generateEnv(blocks, currentHour, charName) {
  const block = blocks.find(b => b.contains(currentHour));
  if (!block) return `现在是 ${currentHour}:00，${charName}在过着自己的日常生活。`;

  const hourStr = String(currentHour).padStart(2, '0');
  const env = block.envTemplate;
  // 替换模板变量
  let result = env.replace(/\{hour\}/g, hourStr).replace(/\{char\}/g, charName);
  // 如果在块开头，加上时间提示
  if (currentHour === block.startHour) {
    result = `${hourStr}:00 — ${result}`;
  }
  return result;
}

/** 获取当前时间块名 */
function getCurrentBlockName(blocks, hour) {
  const block = blocks.find(b => b.contains(hour));
  return block ? block.name : '日常';
}

/** 推进时间到下一个小时 */
function advanceTime(currentHour, blocks) {
  const next = (currentHour + 1) % 24;
  const isNewDay = next === 0;

  const currentBlock = blocks.find(b => b.contains(currentHour));
  const nextBlock = blocks.find(b => b.contains(next));
  
  // 跨天（23→0）或换了块名 → isNewBlock
  const isNewBlock = isNewDay || (currentBlock && nextBlock && currentBlock.name !== nextBlock.name);

  return { hour: next, blockName: nextBlock ? nextBlock.name : '日常', isNewBlock };
}

/** 记录角色 action 到 daily log */
function recordDailyAction(logEntry, charName, action, timeStr) {
  const lines = logEntry ? logEntry.split('\n') : [];
  lines.push(`[${timeStr}] ${charName}: ${action}`);
  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════

function testDefaultTimeBlocks() {
  console.log('\n═══ 测试: 默认时间块 ═══');
  const blocks = getDefaultTimeBlocks();
  assertEq('8 个时间块', 8, blocks.length);
  assertEq('第1块名', '黎明', blocks[0].name);
  assertEq('第1块起始', 4, blocks[0].startHour);
  assertEq('最后1块名', '深夜', blocks[7].name);
  assertEq('黎明 contains 4', true, blocks[0].contains(4));
  assertEq('黎明 contains 5', true, blocks[0].contains(5));
  assertEq('黎明不 contains 6', false, blocks[0].contains(6));
  assertEq('早晨 contains 7', true, blocks[1].contains(7));
}

function testTimeBlocksFromOutline() {
  console.log('\n═══ 测试: 从大纲生成时间块 ═══');

  const outline = [
    { phase: '早晨', description: '晨间准备', direction: '展现日常节奏' },
    { phase: '午前', description: '上午活动', direction: '校园日常' },
    { phase: '放学后', description: '自由时间', direction: '放松节奏' },
    { phase: '傍晚', description: '晚饭时光', direction: '家庭场景' },
  ];

  const blocks = timeBlocksFromOutline(outline);
  assertOk('大纲生成非 null', blocks);
  assertEq('大纲生成 4 块', 4, blocks.length);
  assertEq('第1块 早晨', '早晨', blocks[0].name);
  assertEq('早晨 startHour', 6, blocks[0].startHour);
  assertEq('第2块 午前', '午前', blocks[1].name);
  assertEq('第3块 放学后', '放学后', blocks[2].name);
  assertEq('放学后 startHour', 15, blocks[2].startHour);
  assertEq('第4块 傍晚', '傍晚', blocks[3].name);
  assertEq('傍晚 startHour', 17, blocks[3].startHour);

  // 空大纲
  assertEq('空大纲返回 null', null, timeBlocksFromOutline([]));
  assertEq('null 大纲返回 null', null, timeBlocksFromOutline(null));
}

function testGenerateEnv() {
  console.log('\n═══ 测试: 生成环境描述 ═══');

  const blocks = getDefaultTimeBlocks();

  const env_at_6 = generateEnv(blocks, 6, '士郎');
  assertContains('早6点含时间前缀', '06:00', env_at_6);
  assertContains('早6点含环境', '阳光', env_at_6);

  const env_at_10 = generateEnv(blocks, 10, '凛');
  assertContains('早10点含环境', '安静而从容', env_at_10);

  const env_at_2 = generateEnv(blocks, 2, '士郎');
  assertContains('凌晨2点含环境', '万籁俱寂', env_at_2);
  // 深夜块内容
}

function testGetCurrentBlockName() {
  console.log('\n═══ 测试: 获取当前块名 ═══');
  const blocks = getDefaultTimeBlocks();
  assertEq('7点是早晨', '早晨', getCurrentBlockName(blocks, 7));
  assertEq('10点是午前', '午前', getCurrentBlockName(blocks, 10));
  assertEq('23点是深夜', '深夜', getCurrentBlockName(blocks, 23));
  assertEq('2点是深夜', '深夜', getCurrentBlockName(blocks, 2));
}

function testAdvanceTime() {
  console.log('\n═══ 测试: 时间推进 ═══');
  const blocks = getDefaultTimeBlocks();

  // 同一块内推进
  const r1 = advanceTime(7, blocks);
  assertEq('7→8 是同一块', false, r1.isNewBlock);
  assertEq('7→8 是早晨', '早晨', r1.blockName);

  // 跨块推进
  const r2 = advanceTime(8, blocks);
  assertEq('8→9 是新的块', true, r2.isNewBlock);
  assertEq('8→9 是午前', '午前', r2.blockName);

  // 跨天
  const r3 = advanceTime(23, blocks);
  assertEq('23→0 是新的块', true, r3.isNewBlock);
  assertEq('23→0 是深夜', '深夜', r3.blockName);
}

function testRecordDailyAction() {
  console.log('\n═══ 测试: 记录日常行动 ═══');
  let log = '';
  log = recordDailyAction(log, '士郎', '起床洗漱', '07:00');
  assertContains('第一次记录', '07:00', log);
  assertContains('士郎起', '士郎: 起床洗漱', log);

  log = recordDailyAction(log, '凛', '来到卫宫家', '07:30');
  assertContains('第二次记录', '凛: 来到卫宫家', log);
  // 日志包含两条
  const lines = log.split('\n');
  assertEq('两条记录', 2, lines.length);
}

function testDailyLogFile() {
  console.log('\n═══ 测试: 日志文件写入 ═══');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-test-'));
  const logPath = path.join(tmpDir, 'daily-log.md');

  // 写入
  const header = '# 日常日志\n\n## 早晨\n';
  fs.writeFileSync(logPath, header, 'utf-8');

  let log = fs.readFileSync(logPath, 'utf-8');
  assertContains('初始内容', '日常日志', log);

  // 追加
  fs.appendFileSync(logPath, '- [07:00] 士郎: 起床\n', 'utf-8');
  log = fs.readFileSync(logPath, 'utf-8');
  assertContains('追加后含行动', '士郎: 起床', log);

  // 清理
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assertOk('临时目录已清理', !fs.existsSync(tmpDir));
}

// ══════════════════════════════════════════════════════════════════

function main() {
  console.log('==========================================');
  console.log('  每日模式引擎测试');
  console.log('==========================================');

  testDefaultTimeBlocks();
  testTimeBlocksFromOutline();
  testGenerateEnv();
  testGetCurrentBlockName();
  testAdvanceTime();
  testRecordDailyAction();
  testDailyLogFile();

  console.log('\n==========================================');
  console.log('  测试结果');
  console.log('==========================================');
  console.log(`  ✅ 通过: ${passed}`);
  console.log(`  ❌ 失败: ${failed}`);
  if (failed > 0) process.exit(1);
  else console.log('  🎉 全部通过!\n');
}

main();
