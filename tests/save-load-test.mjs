/**
 * save-load-test.mjs — 存读档系统测试
 *
 * 直接测试 save-load.ts 的 dumpNamespace / clearNamespace / restoreNamespace
 *
 * 用法: node tests/save-load-test.mjs
 */

import { dumpNamespace, clearNamespace, restoreNamespace } from '../.pi/extensions/runtime/save-load.ts';

const NM_CHECK = 'http://127.0.0.1:8233/health';
const TEST_NS = '__test_save_load';

let passed = 0;
let failed = 0;

function assertEq(desc, expected, actual) {
  if (expected === actual) {
    console.log(`  ✅ PASS: ${desc}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${desc}`);
    console.log(`     Expected: ${expected}`);
    console.log(`     Actual:   ${actual}`);
    failed++;
  }
}

function assertContains(desc, needle, haystack) {
  if (haystack.includes(needle)) {
    console.log(`  ✅ PASS: ${desc}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${desc}`);
    console.log(`     Expected to contain: ${needle}`);
    console.log(`     Haystack length: ${haystack.length}`);
    failed++;
  }
}

/** 递归删除一个节点及其所有子节点 */
async function deleteNodeRecursive(ns, domain, pathStr) {
  // 先读子节点
  const detail = await api('GET', '/browse/node', { namespace: ns, domain, path: pathStr });
  // 递归删子节点
  for (const child of detail.children || []) {
    await deleteNodeRecursive(ns, child.domain, child.path);
  }
  // 删自己
  if (pathStr) {
    try {
      await api('DELETE', '/browse/node', { namespace: ns, domain, path: pathStr });
    } catch { /* 已不存在就跳过 */ }
  }
}

/** HTTP 请求封装 */
async function api(method, path, params = {}, body = null) {
  const url = new URL(`http://127.0.0.1:8233/api${path}`);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path}: ${res.status} — ${text.slice(0, 150)}`);
  }
  return res.json();
}

/** 清理测试 namespace — 递归删除所有节点 */
async function cleanupNs() {
  try {
    const root = await api('GET', '/browse/node', { namespace: TEST_NS, domain: 'core', path: '' });
    for (const child of root.children || []) {
      await deleteNodeRecursive(TEST_NS, child.domain, child.path);
    }
  } catch { /* namespace 不存在 */ }
}

/** 安全创建节点：已存在则跳过 */
async function safeCreate(parentPath, title, content, priority) {
  try {
    await api('POST', '/browse/node', { namespace: TEST_NS }, {
      parent_path: parentPath, content, priority, title, domain: 'core', disclosure: 'public',
    });
  } catch (e) {
    if (!e.message.includes('422')) throw e;
  }
}

/** 准备测试数据（6 个节点，含多层嵌套） */
async function prepareTestData() {
  await cleanupNs();
  await safeCreate('', 'identity', '', 0);
  await safeCreate('', 'relationships', '', 0);
  await safeCreate('identity', 'self', '【self】我是测试角色', 10);
  await safeCreate('relationships', 'zhang_san', '【张三】一个朋友', 6);
  await safeCreate('relationships', 'li_si', '【李四】另一个朋友', 4);
  await safeCreate('relationships/zhang_san', 'notes', '【备注】张三喜欢喝茶', 3);
  console.log('  ✅ 测试数据已创建（6 节点）');
}

/** 读取某个节点的内容 */
async function readNodeContent(pathStr) {
  try {
    const data = await api('GET', '/browse/node', { namespace: TEST_NS, domain: 'core', path: pathStr });
    return data.node?.content || '';
  } catch {
    return '';
  }
}

/** 递归统计 namespace 总节点数（计数所有非虚拟节点，含 content 为空的分类节点） */
async function countAllNodes() {
  const root = await api('GET', '/browse/node', { namespace: TEST_NS, domain: 'core', path: '' });
  let total = 0;
  for (const child of root.children || []) {
    total += await countSubNodes(child.path, child.domain);
  }
  return total;
}

async function countSubNodes(pathStr, domain) {
  try {
    const data = await api('GET', '/browse/node', { namespace: TEST_NS, domain, path: pathStr });
    // 只要不是虚拟根节点就算一个
    let count = data.node && !data.node.is_virtual ? 1 : 0;
    for (const c of data.children || []) {
      count += await countSubNodes(c.path, c.domain);
    }
    return count;
  } catch {
    return 0;
  }
}

// ══════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════

async function testDumpNamespace() {
  console.log('\n═══ 测试: dumpNamespace ═══');
  const dump = await dumpNamespace(TEST_NS);

  assertEq('导出节点数', 6, dump.nodes.length);
  assertContains('导出含 self', 'identity/self', JSON.stringify(dump.nodes.map(n => n.path)));
  assertContains('导出含 zhang_san', 'relationships/zhang_san', JSON.stringify(dump.nodes.map(n => n.path)));
  assertContains('导出含 li_si', 'relationships/li_si', JSON.stringify(dump.nodes.map(n => n.path)));
  assertContains('导出含孙子节点', 'relationships/zhang_san/notes', JSON.stringify(dump.nodes.map(n => n.path)));
  assertContains('导出含优先级=10', '10', JSON.stringify(dump.nodes.map(n => n.priority)));
  assertContains('含 exportedAt', 'exportedAt', JSON.stringify(dump));

  // 验证 content 完整
  for (const n of dump.nodes) {
    if (n.path === 'identity/self') {
      assertContains('self 内容完整', '我是测试角色', n.content);
    }
    if (n.path === 'relationships/zhang_san/notes') {
      assertContains('孙子节点内容完整', '张三喜欢喝茶', n.content);
    }
  }

  return dump;
}

async function testClearNamespace(expectCountBefore) {
  console.log('\n═══ 测试: clearNamespace ═══');

  // 确认清空前有数据
  const before = await countAllNodes();
  assertEq('清空前有数据', expectCountBefore, before);

  await clearNamespace(TEST_NS);

  const after = await countAllNodes();
  assertEq('清空后为 0', 0, after);
}

async function testRestoreNamespace(dump) {
  console.log('\n═══ 测试: restoreNamespace ═══');

  const count = await restoreNamespace(TEST_NS, dump);
  assertEq('restore 返回的节点数', dump.nodes.length, count);

  const total = await countAllNodes();
  assertEq('恢复后总节点数', dump.nodes.length, total);

  // 验证内容完整
  const selfContent = await readNodeContent('identity/self');
  assertContains('self 内容恢复', '我是测试角色', selfContent);

  const notesContent = await readNodeContent('relationships/zhang_san/notes');
  assertContains('孙子节点内容恢复', '张三喜欢喝茶', notesContent);

  // 验证优先级
  const zhangSanData = await api('GET', '/browse/node', { namespace: TEST_NS, domain: 'core', path: 'relationships/zhang_san' });
  const zhangSan = zhangSanData.node;
  assertEq('zhang_san 优先级', 6, zhangSan.priority);
}

async function testCompleteOverwrite() {
  // 重点：验证两次 restore 不会残留旧数据
  console.log('\n═══ 测试: 完全覆盖（先restore再restore不同数据） ═══');

  // 先清空
  await clearNamespace(TEST_NS);

  // 只有 2 个节点的小数据集
  const smallDump = {
    namespace: TEST_NS,
    exportedAt: new Date().toISOString(),
    nodes: [
      { path: 'test', domain: 'core', content: '【测试】只有一条', priority: 5, title: 'test' },
    ],
  };

  await restoreNamespace(TEST_NS, smallDump);
  const afterFirst = await countAllNodes();
  assertEq('第一次 restore 后节点数', 1, afterFirst);

  // 再 restore 另一个数据集
  const smallDump2 = {
    namespace: TEST_NS,
    exportedAt: new Date().toISOString(),
    nodes: [
      { path: 'alpha', domain: 'core', content: '【A】阿尔法', priority: 3, title: 'alpha' },
      { path: 'beta', domain: 'core', content: '【B】贝塔', priority: 7, title: 'beta' },
    ],
  };

  await restoreNamespace(TEST_NS, smallDump2);
  const afterSecond = await countAllNodes();
  assertEq('第二次 restore 后节点数', 2, afterSecond);
  // 验证旧数据已被完全覆盖
  const alphaContent = await readNodeContent('alpha');
  assertContains('alpha 存在', '阿尔法', alphaContent);
  const testContent = await readNodeContent('test');
  assertEq('test 已被清除', '', testContent);
}

// ══════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════

async function main() {
  console.log('==========================================');
  console.log('  存读档系统测试');
  console.log('==========================================');

  // 前置检查
  try {
    await fetch(NM_CHECK);
    console.log('  ✅ Nocturne Memory 运行中');
  } catch {
    console.error('  ❌ Nocturne Memory 未运行');
    process.exit(1);
  }

  try {
    await prepareTestData();
    const dump = await testDumpNamespace();
    await testClearNamespace(6);
    await testRestoreNamespace(dump);
    await testCompleteOverwrite();
  } finally {
    await cleanupNs();
  }

  console.log('\n==========================================');
  console.log('  测试结果');
  console.log('==========================================');
  console.log(`  ✅ 通过: ${passed}`);
  console.log(`  ❌ 失败: ${failed}`);

  if (failed > 0) {
    console.log('  ❌ 有失败项\n');
    process.exit(1);
  } else {
    console.log('  🎉 全部通过!\n');
  }
}

main();
