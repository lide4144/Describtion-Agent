/**
 * fixer-test.mjs — fixer GM 工具测试
 *
 * 测试 story-log.md 管理 + Nocturne Memory 紧急操作
 *
 * 用法: node tests/fixer-test.mjs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const NM_BASE = 'http://127.0.0.1:8233/api';
const TEST_NS = '__test_fixer';

let passed = 0;
let failed = 0;

function assertEq(desc, expected, actual) {
  const ok = expected === actual;
  console.log(`  ${ok ? '✅' : '❌'} ${ok ? 'PASS' : 'FAIL'}: ${desc}`);
  if (!ok) {
    console.log(`     Expected: ${JSON.stringify(expected)}`);
    console.log(`     Actual:   ${JSON.stringify(actual)}`);
    failed++;
  } else passed++;
}

function assertContains(desc, needle, haystack) {
  const ok = typeof haystack === 'string' && haystack.includes(needle);
  console.log(`  ${ok ? '✅' : '❌'} ${ok ? 'PASS' : 'FAIL'}: ${desc}`);
  if (!ok) {
    console.log(`     Expected to contain: ${needle}`);
    console.log(`     Haystack length: ${String(haystack).length}`);
    failed++;
  } else passed++;
}

function assertOk(desc, value) {
  const ok = !!value;
  console.log(`  ${ok ? '✅' : '❌'} ${ok ? 'PASS' : 'FAIL'}: ${desc}`);
  if (!ok) { console.log(`     Value: ${String(value)}`); failed++; }
  else passed++;
}

// ══════════════════════════════════════════════════════════════════
// 模拟 story-log.md 操作（fixer 的 log 子命令实现）
// ══════════════════════════════════════════════════════════════════

/** 解析 story-log.md 为段落数组 */
function parseStoryLog(content) {
  const raw = content.replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  // 按 \n---\n 分割
  const sections = raw.split(/\n---\n/).map(s => s.trim()).filter(Boolean);
  return sections.map((s, i) => {
    // 提取标题（## 开头行）
    const lines = s.split('\n');
    const headerLine = lines.find(l => l.startsWith('## '));
    const header = headerLine ? headerLine.replace(/^##\s+/, '') : `section_${i + 1}`;
    return { index: i, header, content: s };
  });
}

/** 列出日志段落 */
function logList(content) {
  const sections = parseStoryLog(content);
  return sections.map(s => `${s.index}. ${s.header}`);
}

/** 获取指定段落 */
function logGet(content, index) {
  const sections = parseStoryLog(content);
  if (index < 0 || index >= sections.length) return null;
  return sections[index];
}

/** 编辑指定段落 */
function logEdit(content, index, newText) {
  const sections = parseStoryLog(content);
  if (index < 0 || index >= sections.length) return null;
  sections[index] = { ...sections[index], content: newText };
  return sections.map(s => s.content).join('\n\n---\n\n');
}

/** 删除指定段落 */
function logDelete(content, index) {
  const sections = parseStoryLog(content);
  if (index < 0 || index >= sections.length) return null;
  sections.splice(index, 1);
  if (sections.length === 0) return '';
  return sections.map(s => s.content).join('\n\n---\n\n');
}

/** 插入段落 */
function logInsert(content, afterIndex, newText) {
  const sections = parseStoryLog(content);
  if (afterIndex < -1 || afterIndex >= sections.length) return null;
  const insertAt = afterIndex + 1;
  sections.splice(insertAt, 0, { index: insertAt, header: '', content: newText });
  return sections.map(s => s.content).join('\n\n---\n\n');
}

// ══════════════════════════════════════════════════════════════════
// Nocturne Memory 操作（fixer 的 nm 子命令实现）
// ══════════════════════════════════════════════════════════════════

async function api(method, apiPath, params = {}, body = null) {
  const url = new URL(`${NM_BASE}${apiPath}`);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${apiPath}: ${res.status} — ${text.slice(0, 150)}`);
  }
  return res.json();
}

/** 获取 Nocturne Memory 节点的原始数据 */
async function nmGet(char, uri) {
  const m = uri.match(/^([a-z][a-z0-9_]*):\/\/(.+)$/);
  if (!m) throw new Error(`无效 URI: ${uri}`);
  const domain = m[1], path = m[2];
  const data = await api('GET', '/browse/node', { namespace: char, domain, path });
  return data.node;
}

/** 删除 Nocturne Memory 节点 */
async function nmDelete(char, uri) {
  const m = uri.match(/^([a-z][a-z0-9_]*):\/\/(.+)$/);
  if (!m) throw new Error(`无效 URI: ${uri}`);
  const domain = m[1], path = m[2];
  // 需要递归删除子节点
  try {
    const detail = await api('GET', '/browse/node', { namespace: char, domain, path });
    for (const child of detail.children || []) {
      await nmDelete(char, `${child.domain}://${child.path}`);
    }
  } catch { /* */ }
  await api('DELETE', '/browse/node', { namespace: char, domain, path });
  return { deleted: true, uri };
}

/** 列出角色的记忆摘要（递归遍历子节点） */
async function nmList(char, domain = 'core') {
  const items = [];
  async function walk(pathStr) {
    const data = await api('GET', '/browse/node', { namespace: char, domain, path: pathStr });
    for (const child of data.children || []) {
      items.push({ uri: child.uri, priority: child.priority, snippet: (child.content_snippet || '').slice(0, 80) });
      await walk(child.path);
    }
  }
  await walk('');
  return items;
}

// ══════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════

function testParseStoryLog() {
  console.log('\n═══ 测试: parseStoryLog ═══');

  const log = `## 早晨的厨房

士郎在厨房里切菜。

---

## 上学的路

士郎和凛一起走在樱花道上。`;

  const sections = parseStoryLog(log);
  assertEq('段落数', 2, sections.length);
  assertEq('第1段 header', '早晨的厨房', sections[0].header);
  assertContains('第1段内容', '切菜', sections[0].content);
  assertEq('第2段 header', '上学的路', sections[1].header);
  assertContains('第2段内容', '樱花', sections[1].content);
}

function testLogList() {
  console.log('\n═══ 测试: logList ═══');

  const log = `## 场景A

内容A

---

## 场景B

内容B`;

  const list = logList(log);
  assertEq('列表长度', 2, list.length);
  assertContains('包含场景A', '场景A', list[0]);
  assertContains('包含场景B', '场景B', list[1]);
}

function testLogGet() {
  console.log('\n═══ 测试: logGet ═══');

  const log = `## 场景A

内容A

---

## 场景B

内容B`;

  const s0 = logGet(log, 0);
  assertEq('get(0) header', '场景A', s0.header);

  const s1 = logGet(log, 1);
  assertEq('get(1) header', '场景B', s1.header);

  const s99 = logGet(log, 99);
  assertEq('get(99) 越界返回 null', null, s99);
}

function testLogEdit() {
  console.log('\n═══ 测试: logEdit ═══');

  const log = `## 场景A

内容A

---

## 场景B

内容B`;

  const edited = logEdit(log, 0, '## 场景A\n\n修改后的内容');
  assertOk('编辑后非 null', edited);

  const sections = parseStoryLog(edited);
  assertEq('编辑后段落数不变', 2, sections.length);
  assertContains('第1段已修改', '修改后的内容', sections[0].content);
  assertContains('第2段未变', '内容B', sections[1].content);
}

function testLogDelete() {
  console.log('\n═══ 测试: logDelete ═══');

  const log = `## 场景A

内容A

---

## 场景B

内容B

---

## 场景C

内容C`;

  const deleted = logDelete(log, 1);
  assertOk('删除后非 null', deleted);

  const sections = parseStoryLog(deleted);
  assertEq('删除后段落数', 2, sections.length);
  assertContains('保留场景A', '场景A', sections[0].content);
  assertContains('保留场景C', '场景C', sections[1].content);
  assertOk('不包含场景B', !deleted.includes('场景B'));
}

function testLogInsert() {
  console.log('\n═══ 测试: logInsert ═══');

  const log = `## 场景A

内容A

---

## 场景C

内容C`;

  const inserted = logInsert(log, 0, '## 场景B\n\n内容B');
  assertOk('插入后非 null', inserted);

  const sections = parseStoryLog(inserted);
  assertEq('插入后段落数', 3, sections.length);
  assertContains('位置0', '场景A', sections[0].content);
  assertContains('位置1', '场景B', sections[1].content);
  assertContains('位置2', '场景C', sections[2].content);
}

function testLogEmpty() {
  console.log('\n═══ 测试: 空日志 ═══');

  assertEq('空字符串解析为[]', 0, parseStoryLog('').length);
  assertEq('只有空格的解析为[]', 0, parseStoryLog('  ').length);
}

function testDeleteLastSection() {
  console.log('\n═══ 测试: 删除唯一段落 ═══');

  const log = `## 唯一场景

内容`;

  const deleted = logDelete(log, 0);
  assertEq('唯一段落删除后为空', '', deleted);
}

// ══════════════════════════════════════════════════════════════════
// Nocturne Memory 操作测试
// ══════════════════════════════════════════════════════════════════

async function prepareNmData() {
  // 清理
  try {
    const root = await api('GET', '/browse/node', { namespace: TEST_NS, domain: 'core', path: '' });
    for (const child of root.children || []) {
      await nmDelete(TEST_NS, `core://${child.path}`);
    }
  } catch { /* */ }

  // 创建测试节点
  async function sc(parentPath, title, content, priority) {
    try {
      await api('POST', '/browse/node', { namespace: TEST_NS }, {
        parent_path: parentPath, content, priority, title, domain: 'core', disclosure: 'public',
      });
    } catch { /* */ }
  }

  await sc('', 'test', '', 0);
  await sc('test', 'alpha', '【α】阿尔法', 5);
  await sc('test', 'beta', '【β】贝塔', 3);
  console.log('  ✅ NM 测试数据已创建');
}

async function testNmGet() {
  console.log('\n═══ 测试: nmGet ═══');

  const node = await nmGet(TEST_NS, 'core://test/alpha');
  assertEq('获取 alpha 内容', '【α】阿尔法', node?.content || '');
  assertEq('alpha 优先级', 5, node?.priority);
}

async function testNmList() {
  console.log('\n═══ 测试: nmList ═══');

  const items = await nmList(TEST_NS, 'core');
  assertOk('列表不为空', items.length > 0);
  const uris = items.map(i => i.uri).join(',');
  assertContains('包含 test/alpha', 'core://test/alpha', uris);
  assertContains('包含 test/beta', 'core://test/beta', uris);
}

async function testNmDelete() {
  console.log('\n═══ 测试: nmDelete ═══');

  await nmDelete(TEST_NS, 'core://test/beta');

  try {
    await nmGet(TEST_NS, 'core://test/beta');
    console.log('  ❌ FAIL: beta 应已被删除');
    failed++;
  } catch {
    console.log('  ✅ PASS: beta 已删除');
    passed++;
  }
}

// ══════════════════════════════════════════════════════════════════

async function main() {
  console.log('==========================================');
  console.log('  fixer 工具测试');
  console.log('==========================================');

  // 单元测试（不依赖 Nocturne）
  testParseStoryLog();
  testLogList();
  testLogGet();
  testLogEdit();
  testLogDelete();
  testLogInsert();
  testLogEmpty();
  testDeleteLastSection();

  // NM 集成测试
  try {
    await fetch(`${NM_BASE.replace('/api', '')}/health`);
    console.log('  ✅ Nocturne Memory 运行中');
    await prepareNmData();
    await testNmGet();
    await testNmList();
    await testNmDelete();
  } catch (e) {
    console.log(`  ⚠️ Nocturne Memory 不可用，跳过 NM 测试: ${e.message}`);
  }

  console.log('\n==========================================');
  console.log('  测试结果');
  console.log('==========================================');
  console.log(`  ✅ 通过: ${passed}`);
  console.log(`  ❌ 失败: ${failed}`);
  if (failed > 0) process.exit(1);
  else console.log('  🎉 全部通过!\n');
}

main();
