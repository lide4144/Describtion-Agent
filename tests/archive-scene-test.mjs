/**
 * archive-scene-test.mjs — archive-scene 工具测试
 *
 * 验证：
 *   1. history / history_raw 域可写入
 *   2. fetchBootMemories 包含 history 域内容
 *   3. archive-scene 工具函数产出正确的节点结构
 *
 * 用法: node tests/archive-scene-test.mjs
 */

const NM_BASE = 'http://127.0.0.1:8233/api';
const TEST_NS = '__test_archive';

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

/** 递归删除 */
async function deleteRecursive(ns, domain, pathStr) {
  try {
    const detail = await api('GET', '/browse/node', { namespace: ns, domain, path: pathStr });
    for (const child of detail.children || []) {
      await deleteRecursive(ns, child.domain, child.path);
    }
    if (pathStr) {
      await api('DELETE', '/browse/node', { namespace: ns, domain, path: pathStr });
    }
  } catch { /* */ }
}

async function cleanupNs() {
  for (const domain of ['core', 'history', 'history_raw']) {
    try {
      const root = await api('GET', '/browse/node', { namespace: TEST_NS, domain, path: '' });
      for (const child of root.children || []) {
        await deleteRecursive(TEST_NS, child.domain, child.path);
      }
    } catch { /* */ }
  }
}

// ══════════════════════════════════════════════════════════════════
// archive-scene 的实现（将集成到 gm-tools.ts）
// ══════════════════════════════════════════════════════════════════

/** 为单个角色归档场景到 history 域 */
async function archiveSceneForCharacter({ char, sceneName, summary, narrative }) {
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  const safeName = sceneName || `scene_${timestamp}`;

  // 1. 创建分类节点 scenes（如果不存在则跳过 422）
  try {
    await api('POST', '/browse/node', { namespace: char }, {
      parent_path: '', content: '', priority: 0, title: 'scenes',
      domain: 'history', disclosure: 'public',
    });
  } catch { /* 已存在 */ }

  // 2. 写入场景摘要 → history://scenes/{safeName}
  await api('POST', '/browse/node', { namespace: char }, {
    parent_path: 'scenes', content: `【${safeName}】${summary}`,
    priority: 5, title: safeName,
    domain: 'history', disclosure: 'public',
  });

  // 3. 写入完整叙事 → history_raw://scenes/{safeName}
  try {
    await api('POST', '/browse/node', { namespace: char }, {
      parent_path: '', content: '', priority: 0, title: 'scenes',
      domain: 'history_raw', disclosure: 'public',
    });
  } catch { /* 已存在 */ }

  await api('POST', '/browse/node', { namespace: char }, {
    parent_path: 'scenes', content: `【${safeName}】\n${narrative}`,
    priority: 1, title: safeName,
    domain: 'history_raw', disclosure: 'public',
  });

  return { char, sceneName: safeName };
}

/** 读取 history 域的场景摘要列表（供 fetchBootMemories 使用） */
async function fetchHistoryMemories(charName) {
  try {
    const root = await api('GET', '/browse/node', { namespace: charName, domain: 'history', path: '' });
    const parts = [];

    for (const child of root.children || []) {
      // 分类节点（如 scenes）—— 读取其子节点
      const detail = await api('GET', '/browse/node', { namespace: charName, domain: child.domain, path: child.path });
      for (const sub of detail.children || []) {
        try {
          const subDetail = await api('GET', '/browse/node', { namespace: charName, domain: sub.domain, path: sub.path });
          if (subDetail.node?.content) {
            parts.push(subDetail.node.content.slice(0, 300));
          }
        } catch { /* */ }
      }
      // 如果分类节点自身有内容，也加上
      if (detail.node?.content) {
        parts.push(detail.node.content.slice(0, 300));
      }
    }

    return parts.length > 0 ? `## 最近的事\n\n${parts.join('\n')}` : '';
  } catch {
    return '';
  }
}

// ══════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════

async function testDomainsExist() {
  console.log('\n═══ 测试: domains 可用 ═══');

  const data = await api('GET', '/browse/domains');
  const domains = data.map(d => d.domain);
  assertContains('history 域已注册', 'history', JSON.stringify(domains));
  assertContains('history_raw 域已注册', 'history_raw', JSON.stringify(domains));
}

async function testWriteHistoryDomain() {
  console.log('\n═══ 测试: 写入 history 域 ═══');

  await archiveSceneForCharacter({
    char: TEST_NS,
    sceneName: 'test_scene_1',
    summary: '士郎在厨房做早饭，凛来蹭饭。两人聊了关于学校的事。',
    narrative: '清晨六点，卫宫家的厨房亮起暖黄的灯光……完整叙事……',
  });

  // 验证 history 域可读
  const historyRoot = await api('GET', '/browse/node', {
    namespace: TEST_NS, domain: 'history', path: '',
  });
  assertEq('history 域根节点可访问', true, !!historyRoot.node);
  assertContains('history 有 scenes 子节点', 'scenes', JSON.stringify(historyRoot.children.map(c => c.path)));

  // 验证场景内容
  const sceneDetail = await api('GET', '/browse/node', {
    namespace: TEST_NS, domain: 'history', path: 'scenes/test_scene_1',
  });
  assertContains('场景摘要内容', '士郎在厨房做早饭', sceneDetail.node?.content || '');
  assertEq('场景摘要优先级=5', 5, sceneDetail.node?.priority);
}

async function testWriteHistoryRawDomain() {
  console.log('\n═══ 测试: 写入 history_raw 域 ═══');

  const rawRoot = await api('GET', '/browse/node', {
    namespace: TEST_NS, domain: 'history_raw', path: '',
  });
  assertEq('history_raw 域根节点可访问', true, !!rawRoot.node);
  assertContains('history_raw 有 scenes 子节点', 'scenes', JSON.stringify(rawRoot.children.map(c => c.path)));

  const sceneDetail = await api('GET', '/browse/node', {
    namespace: TEST_NS, domain: 'history_raw', path: 'scenes/test_scene_1',
  });
  assertContains('完整叙事内容', '清晨六点', sceneDetail.node?.content || '');
  assertEq('history_raw 优先级=1', 1, sceneDetail.node?.priority);
}

async function testFetchHistoryMemories() {
  console.log('\n═══ 测试: fetchHistoryMemories ═══');

  const result = await fetchHistoryMemories(TEST_NS);
  assertContains('包含"最近的事"标题', '最近的事', result);
  assertContains('包含场景摘要', '士郎在厨房做早饭', result);
  assertContains('包含场景名', 'test_scene_1', result);
}

async function testMultipleScenes() {
  console.log('\n═══ 测试: 多个场景归档 ═══');

  await archiveSceneForCharacter({
    char: TEST_NS,
    sceneName: 'test_scene_2',
    summary: '放学后士郎和凛在商店街偶遇，一起去买了晚饭的食材。',
    narrative: '下午四点半，夕阳斜照在商店街的石板路上……',
  });

  const result = await fetchHistoryMemories(TEST_NS);
  assertContains('包含场景1', 'test_scene_1', result);
  assertContains('包含场景2', 'test_scene_2', result);
  assertContains('包含场景2摘要', '放学后', result);
}

async function testCrossCharacterIsolation() {
  console.log('\n═══ 测试: 角色间隔离 ═══');

  // 为角色 A 归档
  await archiveSceneForCharacter({
    char: TEST_NS,
    sceneName: 'char_a_scene',
    summary: '角色A的独有场景',
    narrative: '只有角色A看到的叙事',
  });

  const result = await fetchHistoryMemories(TEST_NS);
  assertContains('角色A能看到自己的场景', '角色A的独有场景', result);

  // 另一个角色 B（用不同 namespace）不应看到 A 的
  const resultB = await fetchHistoryMemories('__test_archive_other');
  // 没有归档过，结果应为空
  assertEq('角色B的 history 为空', '', resultB);
}

// ══════════════════════════════════════════════════════════════════

async function main() {
  console.log('==========================================');
  console.log('  archive-scene 工具测试');
  console.log('==========================================');

  try {
    await fetch(`${NM_BASE.replace('/api', '')}/health`);
    console.log('  ✅ Nocturne Memory 运行中');
  } catch {
    console.error('  ❌ Nocturne Memory 未运行');
    process.exit(1);
  }

  try {
    await cleanupNs();
    await testDomainsExist();
    await testWriteHistoryDomain();
    await testWriteHistoryRawDomain();
    await testFetchHistoryMemories();
    await testMultipleScenes();
    await testCrossCharacterIsolation();
  } finally {
    await cleanupNs();
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
