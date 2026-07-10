#!/usr/bin/env bash
#
# save-load-test.sh — 存读档系统端到端测试
#
# 测试 cycle 1-2: dumpNamespace / clearNamespace / restoreNamespace
#
# 前置条件: Nocturne Memory 运行在 127.0.0.1:8233
#
# 用法:
#   bash tests/save-load-test.sh

set -uo pipefail

PI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$1"; }

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    green "  ✅ PASS: $desc"
    ((PASS++))
  else
    red "  ❌ FAIL: $desc"
    echo "     Expected: $expected"
    echo "     Actual:   $actual"
    ((FAIL++))
  fi
}

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    green "  ✅ PASS: $desc"
    ((PASS++))
  else
    red "  ❌ FAIL: $desc"
    echo "     Expected to contain: $needle"
    echo "     Actual: ${haystack:0:200}"
    ((FAIL++))
  fi
}

# ══════════════════════════════════════════════════════════════════
# 前置检查
# ══════════════════════════════════════════════════════════════════

check_prerequisites() {
  echo "═══ 前置检查 ═══"
  if ! curl -sf http://127.0.0.1:8233/health > /dev/null 2>&1; then
    red "  ❌ Nocturne Memory 未运行，请先启动: cd nocturne_memory && python backend/main.py"
    exit 1
  fi
  green "  ✅ Nocturne Memory 运行中"
}

# ══════════════════════════════════════════════════════════════════
# 准备测试数据
# ══════════════════════════════════════════════════════════════════

TEST_NS="__test_save_load"

create_test_data() {
  echo ""
  echo "═══ 准备测试数据 (namespace: ${TEST_NS}) ═══"

  # 清空可能残留的测试数据
  cleanup_test_data 2>/dev/null

  # 创建分类节点: identity + relationships
  curl -sf -X POST "http://127.0.0.1:8233/api/browse/node?namespace=${TEST_NS}" \
    -H "Content-Type: application/json" \
    -d '{"parent_path":"","content":"","priority":0,"title":"identity","domain":"core","disclosure":"public"}' \
    > /dev/null && echo "  创建: identity (分类)"

  curl -sf -X POST "http://127.0.0.1:8233/api/browse/node?namespace=${TEST_NS}" \
    -H "Content-Type: application/json" \
    -d '{"parent_path":"","content":"","priority":0,"title":"relationships","domain":"core","disclosure":"public"}' \
    > /dev/null && echo "  创建: relationships (分类)"

  # 创建子节点
  curl -sf -X POST "http://127.0.0.1:8233/api/browse/node?namespace=${TEST_NS}" \
    -H "Content-Type: application/json" \
    -d '{"parent_path":"identity","content":"【self】我是测试角色","priority":10,"title":"self","domain":"core","disclosure":"public"}' \
    > /dev/null && echo "  创建: identity/self"

  curl -sf -X POST "http://127.0.0.1:8233/api/browse/node?namespace=${TEST_NS}" \
    -H "Content-Type: application/json" \
    -d '{"parent_path":"relationships","content":"【张三】一个朋友","priority":6,"title":"zhang_san","domain":"core","disclosure":"public"}' \
    > /dev/null && echo "  创建: relationships/zhang_san"

  curl -sf -X POST "http://127.0.0.1:8233/api/browse/node?namespace=${TEST_NS}" \
    -H "Content-Type: application/json" \
    -d '{"parent_path":"relationships","content":"【李四】另一个朋友","priority":4,"title":"li_si","domain":"core","disclosure":"public"}' \
    > /dev/null && echo "  创建: relationships/li_si"

  # 创建孙子节点
  curl -sf -X POST "http://127.0.0.1:8233/api/browse/node?namespace=${TEST_NS}" \
    -H "Content-Type: application/json" \
    -d '{"parent_path":"relationships/zhang_san","content":"【备注】张三喜欢喝茶","priority":3,"title":"notes","domain":"core","disclosure":"public"}' \
    > /dev/null && echo "  创建: relationships/zhang_san/notes"

  green "  ✅ 测试数据创建完成"
}

cleanup_test_data() {
  # 递归删除顶层分类节点
  for cat in identity relationships; do
    curl -sf -X DELETE "http://127.0.0.1:8233/api/browse/node?namespace=${TEST_NS}&domain=core&path=${cat}" \
      > /dev/null 2>&1 || true
  done
}

# ══════════════════════════════════════════════════════════════════
# 测试: dumpNamespace — 递归导出所有节点
# ══════════════════════════════════════════════════════════════════

test_dump_namespace() {
  echo ""
  echo "═══ 测试: dumpNamespace ═══"

  # 直接用 node 运行 TypeScript（通过 tsx / ts-node / 或直接解析）
  # 这里用 node --experimental-strip-types 直接跑 TS
  local dump_json
  dump_json=$(cd "$PI_DIR" && node --experimental-strip-types --input-type=module -e "
    import { dumpNamespace } from './.pi/extensions/runtime/save-load.ts';
    dumpNamespace('${TEST_NS}').then(d => console.log(JSON.stringify(d)));
  " 2>/dev/null)

  if [[ -z "$dump_json" ]]; then
    red "  ❌ dumpNamespace 调用失败"
    ((FAIL++))
    return
  fi

  # 验证节点数量（应有 6 个：identity/self + relationships/zhang_san + relationships/li_si + relationships/zhang_san/notes + identity + relationships）
  local node_count
  node_count=$(echo "$dump_json" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['nodes']))" 2>/dev/null)
  assert_eq "导出节点数" "6" "$node_count"

  # 验证包含关键内容
  assert_contains "导出含 self" "identity/self" "$dump_json"
  assert_contains "导出含 zhang_san" "relationships/zhang_san" "$dump_json"
  assert_contains "导出含 li_si" "relationships/li_si" "$dump_json"
  assert_contains "导出含孙子节点" "relationships/zhang_san/notes" "$dump_json"
  assert_contains "导出含张三的备注" "张三喜欢喝茶" "$dump_json"
  assert_contains "含 priority=10" "10" "$dump_json"
  assert_contains "含 namespace" "${TEST_NS}" "$dump_json"
  assert_contains "含 exportedAt" "exportedAt" "$dump_json"

  # 保存 dump 供后续测试使用
  echo "$dump_json" > /tmp/save-load-test-dump.json
  green "  ✅ dump 已保存到 /tmp/save-load-test-dump.json"
}

# ══════════════════════════════════════════════════════════════════
# 测试: clearNamespace — 清空 namespace
# ══════════════════════════════════════════════════════════════════

test_clear_namespace() {
  echo ""
  echo "═══ 测试: clearNamespace ═══"

  cd "$PI_DIR" && node --experimental-strip-types --input-type=module -e "
    import { clearNamespace } from './.pi/extensions/runtime/save-load.ts';
    clearNamespace('${TEST_NS}').then(() => {
      // 验证已清空
      fetch('http://127.0.0.1:8233/api/browse/node?namespace=${TEST_NS}&domain=core&path=')
        .then(r => r.json())
        .then(data => {
          const count = data.children ? data.children.length : -1;
          console.log('CHILDREN_COUNT=' + count);
        });
    });
  " 2>/dev/null | grep CHILDREN_COUNT

  local children_after
  children_after=$(curl -sf "http://127.0.0.1:8233/api/browse/node?namespace=${TEST_NS}&domain=core&path=" \
    | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('children', [])))" 2>/dev/null)

  assert_eq "清空后子节点数" "0" "$children_after"
}

# ══════════════════════════════════════════════════════════════════
# 测试: restoreNamespace — 完全覆盖恢复
# ══════════════════════════════════════════════════════════════════

test_restore_namespace() {
  echo ""
  echo "═══ 测试: restoreNamespace ═══"

  cd "$PI_DIR" && node --experimental-strip-types --input-type=module -e "
    import { restoreNamespace } from './.pi/extensions/runtime/save-load.ts';
    const fs = await import('node:fs');
    const dump = JSON.parse(fs.readFileSync('/tmp/save-load-test-dump.json', 'utf-8'));
    restoreNamespace('${TEST_NS}', dump).then(count => {
      console.log('RESTORED_COUNT=' + count);
    });
  " 2>/dev/null | grep RESTORED_COUNT

  # 验证恢复后的节点数
  local restored_json
  restored_json=$(curl -sf "http://127.0.0.1:8233/api/browse/node?namespace=${TEST_NS}&domain=core&path=" \
    | python3 -c "
import json,sys
data = json.load(sys.stdin)
children = data.get('children', [])
# 递归计算所有节点
def count_all(path, domain):
    import urllib.request
    url = f'http://127.0.0.1:8233/api/browse/node?namespace=${TEST_NS}&domain={domain}&path={path}'
    try:
        with urllib.request.urlopen(url) as resp:
            d = json.loads(resp.read())
            total = 1 if d.get('node',{}).get('content') else 0
            for c in d.get('children', []):
                total += count_all(c['path'], c['domain'])
            return total
    except:
        return 0

# 算根节点下的所有内容
total = sum(count_all(c['path'], c['domain']) for c in children)
print(total)
" 2>/dev/null)

  assert_eq "恢复后总节点数" "6" "$restored_json"

  # 验证内容完整
  local self_content
  self_content=$(curl -sf "http://127.0.0.1:8233/api/browse/node?namespace=${TEST_NS}&domain=core&path=identity/self" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('node',{}).get('content',''))" 2>/dev/null)
  assert_contains "self 内容恢复" "我是测试角色" "$self_content"

  local notes_content
  notes_content=$(curl -sf "http://127.0.0.1:8233/api/browse/node?namespace=${TEST_NS}&domain=core&path=relationships/zhang_san/notes" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('node',{}).get('content',''))" 2>/dev/null)
  assert_contains "孙子节点内容恢复" "张三喜欢喝茶" "$notes_content"
}

# ══════════════════════════════════════════════════════════════════
# 清理
# ══════════════════════════════════════════════════════════════════

cleanup() {
  cleanup_test_data
  rm -f /tmp/save-load-test-dump.json
}

# ══════════════════════════════════════════════════════════════════
# 主流程
# ══════════════════════════════════════════════════════════════════

main() {
  echo "=========================================="
  echo "  存读档系统测试"
  echo "=========================================="

  check_prerequisites
  create_test_data
  test_dump_namespace
  test_clear_namespace
  test_restore_namespace
  cleanup

  echo ""
  echo "=========================================="
  echo "  测试结果"
  echo "=========================================="
  green "  通过: $PASS"
  red "  失败: $FAIL"

  if [[ $FAIL -eq 0 ]]; then
    green "  🎉 全部通过!"
    return 0
  else
    red "  ❌ 有 $FAIL 个测试失败"
    return 1
  fi
}

main "$@"
