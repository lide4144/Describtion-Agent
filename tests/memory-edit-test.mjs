/**
 * memory-edit-test.mjs — memory-edit 工具测试
 *
 * 验证 PUT /api/browse/node 更新内容和优先级的功能
 *
 * 用法: node tests/memory-edit-test.mjs
 */

const NM_BASE = 'http://127.0.0.1:8233/api';
const TEST_NS = '__test_mem_edit';

let passed = 0;
let failed = 0;

function assertEq(desc, expected, actual) {
  if (expected === actual) {
    console.log(`  ✅ PASS: ${desc}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${desc}`);
    console.log(`     Expected: ${JSON.stringify(expected)}`);
    console.log(`     Actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertContains(desc, needle, haystack) {
  if (typeof haystack === 'string' && haystack.includes(needle)) {
    console.log(`  ✅ PASS: ${desc}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${desc}`);
    console.log(`     Expected to contain: ${needle}`);
    console.log(`     Haystack: ${String(haystack).slice(0, 200)}`);
    failed++;
  }
}

async function api(method, path, params = {}, body = null) {
  const url = new URL(`${NM_BASE}${path}`);
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

async function readNodeContent(pathStr) {
  try {
    const data = await api('GET', '/browse/node', { namespace: TEST_NS, domain: 'core', path: pathStr });
    return data.node?.content || '';
  } catch {
    return '';
  }
}

async function readNodePriority(pathStr) {
  try {
    const data = await api('GET', '/browse/node', { namespace: TEST_NS, domain: 'core', path: pathStr });
    return data.node?.priority;
  } catch {
    return null;
  }
}

/**
 * memory-edit 的 HTTP 实现
 * 对应 PUT /api/browse/node?namespace=X&domain=Y&path=Z
 */
async function memoryEdit({ char, uri, content, priority }) {
  // 解析 URI: core://relationships/某人
  const m = uri.match(/^([a-z][a-z0-9_]*):\/\/(.+)$/);
  if (!m) throw new Error(`无效 URI: ${uri}`);
  const domain = m[1];
  const path = m[2];

  const body = {};
  if (content !== undefined) body.content = content;
  if (priority !== undefined) body.priority = priority;

  if (Object.keys(body).length === 0) {
    throw new Error('没有要更新的字段');
  }

  await api('PUT', '/browse/node', { namespace: char, domain, path }, body);
  return { updated: true, uri };
}

// ══════════════════════════════════════════════════════════════════

async function prepareTestData() {
  // 清理可能遗留的数据
  try {
    const root = await api('GET', '/browse/node', { namespace: TEST_NS, domain: 'core', path: '' });
    for (const child of root.children || []) {
      await deleteRecursive(TEST_NS, child.domain, child.path);
    }
  } catch { /* */ }

  // 创建测试数据
  async function safeCreate(parentPath, title, content, priority) {
    try {
      await api('POST', '/browse/node', { namespace: TEST_NS }, {
        parent_path: parentPath, content, priority, title, domain: 'core', disclosure: 'public',
      });
    } catch (e) {
      if (!e.message.includes('422')) throw e;
    }
  }

  await safeCreate('', 'test', '', 0);
  await safeCreate('test', 'node_a', '【A】原始内容 alpha', 5);
  await safeCreate('test', 'node_b', '【B】原始内容 beta', 3);
  console.log('  ✅ 测试数据已创建（3 节点）');
}

async function deleteRecursive(ns, domain, pathStr) {
  const detail = await api('GET', '/browse/node', { namespace: ns, domain, path: pathStr });
  for (const child of detail.children || []) {
    await deleteRecursive(ns, child.domain, child.path);
  }
  if (pathStr) {
    try {
      await api('DELETE', '/browse/node', { namespace: ns, domain, path: pathStr });
    } catch { /* */ }
  }
}

async function cleanup() {
  try {
    const root = await api('GET', '/browse/node', { namespace: TEST_NS, domain: 'core', path: '' });
    for (const child of root.children || []) {
      await deleteRecursive(TEST_NS, child.domain, child.path);
    }
  } catch { /* */ }
}

// ══════════════════════════════════════════════════════════════════

async function testUpdateContent() {
  console.log('\n═══ 测试: 更新内容 ═══');
  await memoryEdit({
    char: TEST_NS,
    uri: 'core://test/node_a',
    content: '【A】已更新内容 gamma',
  });
  const content = await readNodeContent('test/node_a');
  assertEq('node_a 内容已更新', '【A】已更新内容 gamma', content);
}

async function testUpdatePriority() {
  console.log('\n═══ 测试: 更新优先级 ═══');
  await memoryEdit({
    char: TEST_NS,
    uri: 'core://test/node_a',
    priority: 9,
  });
  const priority = await readNodePriority('test/node_a');
  assertEq('node_a 优先级已更新', 9, priority);
  // 内容应保持不变
  const content = await readNodeContent('test/node_a');
  assertContains('node_a 内容不变', 'gamma', content);
}

async function testUpdateBoth() {
  console.log('\n═══ 测试: 同时更新内容和优先级 ═══');
  await memoryEdit({
    char: TEST_NS,
    uri: 'core://test/node_b',
    content: '【B】全面更新 delta',
    priority: 8,
  });
  const content = await readNodeContent('test/node_b');
  assertEq('node_b 内容已更新', '【B】全面更新 delta', content);
  const priority = await readNodePriority('test/node_b');
  assertEq('node_b 优先级已更新', 8, priority);
}

async function testUpdateDifferentField() {
  console.log('\n═══ 测试: 只更新优先级不碰内容 ═══');
  // 先设内容
  await memoryEdit({
    char: TEST_NS,
    uri: 'core://test/node_a',
    content: '【A】独立测试 epsilon',
    priority: 3,
  });
  // 只更新优先级
  await memoryEdit({
    char: TEST_NS,
    uri: 'core://test/node_a',
    priority: 7,
  });
  const content = await readNodeContent('test/node_a');
  assertEq('node_a 内容未被覆盖', '【A】独立测试 epsilon', content);
  const priority = await readNodePriority('test/node_a');
  assertEq('node_a 优先级已改为 7', 7, priority);
}

async function testUriParsing() {
  console.log('\n═══ 测试: URI 解析 ═══');

  // 无效 URI
  try {
    await memoryEdit({ char: TEST_NS, uri: 'invalid-uri', content: 'x' });
    console.log('  ❌ FAIL: 无效 URI 未抛出错误');
    failed++;
  } catch (e) {
    assertContains('无效 URI 应报错', '无效 URI', e.message);
  }

  // 不同 domain
  await memoryEdit({
    char: TEST_NS,
    uri: 'core://test/node_b',
    content: '【B】测试 domain 解析',
  });
  const content = await readNodeContent('test/node_b');
  assertContains('domain 解析成功', 'domain 解析', content);
}

async function testNoFields() {
  console.log('\n═══ 测试: 无更新字段 ═══');
  try {
    await memoryEdit({ char: TEST_NS, uri: 'core://test/node_a' });
    console.log('  ❌ FAIL: 无字段未抛出错误');
    failed++;
  } catch (e) {
    assertContains('无字段应报错', '没有要更新的字段', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════

async function main() {
  console.log('==========================================');
  console.log('  memory-edit 工具测试');
  console.log('==========================================');

  // 前置检查
  try {
    await fetch(`${NM_BASE.replace('/api', '')}/health`);
    console.log('  ✅ Nocturne Memory 运行中');
  } catch {
    console.error('  ❌ Nocturne Memory 未运行');
    process.exit(1);
  }

  try {
    await prepareTestData();
    await testUpdateContent();
    await testUpdatePriority();
    await testUpdateBoth();
    await testUpdateDifferentField();
    await testUriParsing();
    await testNoFields();
  } finally {
    await cleanup();
  }

  console.log('\n==========================================');
  console.log('  测试结果');
  console.log('==========================================');
  console.log(`  ✅ 通过: ${passed}`);
  console.log(`  ❌ 失败: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('  🎉 全部通过!\n');
  }
}

main();
