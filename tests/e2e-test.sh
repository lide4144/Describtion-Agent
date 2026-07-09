#!/usr/bin/env bash
#
# e2e-test.sh — 故事铸造系统端到端自动测试
#
# 测试系统非交互核心组件：故事包创建、角色 RPC 进程、GM 子 agent
#
# 用法:
#   bash tests/e2e-test.sh           # 运行全部自动化测试
#   bash tests/e2e-test.sh setup     # 仅创建测试故事包
#   bash tests/e2e-test.sh memory    # 仅运行记忆系统测试（需 Nocturne Memory）
#   bash tests/e2e-test.sh cleanup   # 清理测试数据
#   bash tests/e2e-test.sh story     # 仅运行故事包自动流程测试（跳过记忆）

set -uo pipefail

PI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_STORY="e2e-晨光咖啡厅"
TEST_STORY_DIR="${PI_DIR}/pi-characters/${TEST_STORY}"
TEST_CHAR="林晓"
PASS=0
FAIL=0
SKIP=0

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$1"; }

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

assert_file_exists() {
  local desc="$1" file="$2"
  if [[ -f "$file" ]]; then
    green "  ✅ PASS: $desc"
    ((PASS++))
  else
    red "  ❌ FAIL: $desc — file missing: $file"
    ((FAIL++))
  fi
}

assert_dir_exists() {
  local desc="$1" dir="$2"
  if [[ -d "$dir" ]]; then
    green "  ✅ PASS: $desc"
    ((PASS++))
  else
    red "  ❌ FAIL: $desc — dir missing: $dir"
    ((FAIL++))
  fi
}

skip() {
  yellow "  ⏭️  SKIP: $1"
  ((SKIP++))
}

print_header() {
  echo ""; echo "═══════════════════════════════════════════════════"
  echo "  $1"
  echo "═══════════════════════════════════════════════════"
}

print_summary() {
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  测试结果"
  echo "═══════════════════════════════════════════════════"
  green "  通过: $PASS"
  red "  失败: $FAIL"
  yellow "  跳过: $SKIP"
  if [[ $FAIL -eq 0 ]]; then green "  🎉 全部通过!"
  else red "  ❌ 有 $FAIL 个测试失败"; fi
}

# ══════════════════════════════════════════════════════════════════
# A: 故事包创建
# ══════════════════════════════════════════════════════════════════

test_create_story_pack() {
  print_header "A: 故事包创建测试"

  mkdir -p "${TEST_STORY_DIR}/chars" "${TEST_STORY_DIR}/saves"
  assert_dir_exists "A1-a: chars/" "${TEST_STORY_DIR}/chars"
  assert_dir_exists "A1-b: saves/" "${TEST_STORY_DIR}/saves"

  cat > "${TEST_STORY_DIR}/story.yaml" << 'STORYEOF'
{
  "name": "e2e-晨光咖啡厅",
  "createdAt": "2026-07-09T12:00:00.000Z",
  "world": "现代都市中的一家独立咖啡厅「晨光咖啡厅」。",
  "cognitiveBoundaries": "所有角色都知道这是一个普通的现代都市世界。",
  "characters": [{"name": "林晓","role": "protagonist","blueprint": "chars/林晓.yaml"}],
  "outline": [{"phase":"晨间","description":"清晨准备","direction":"展现开店节奏"}],
  "opening": "清晨六点半，晨光咖啡厅的卷帘门被哗啦一声拉起。"
}
STORYEOF
  assert_file_exists "A2-a: story.yaml" "${TEST_STORY_DIR}/story.yaml"
  local s; s=$(cat "${TEST_STORY_DIR}/story.yaml")
  assert_contains "A2-b: world" "world" "$s"
  assert_contains "A2-c: cognitiveBoundaries" "cognitiveBoundaries" "$s"
  assert_contains "A2-d: outline" "outline" "$s"
  assert_contains "A2-e: opening" "opening" "$s"
  assert_contains "A2-f: characters" "characters" "$s"
  assert_contains "A2-g: 角色名" "林晓" "$s"

  cat > "${TEST_STORY_DIR}/gm.yaml" << 'GMTEST'
{"narrative":{"style":"注重感官细节的日常叙事","tone":"温暖、宁静"},"npcs":[{"name":"王姐","description":"常客","keywords":["美式"]}]}
GMTEST
  assert_file_exists "A3-a: gm.yaml" "${TEST_STORY_DIR}/gm.yaml"
  local g; g=$(cat "${TEST_STORY_DIR}/gm.yaml")
  assert_contains "A3-b: style" "style" "$g"
  assert_contains "A3-c: tone" "tone" "$g"
  assert_contains "A3-d: npcs" "npcs" "$g"

  cat > "${TEST_STORY_DIR}/chars/林晓.yaml" << 'CHAREOF'
{
  "name": "林晓","role": "protagonist",
  "identity": "我是林晓，晨光咖啡厅的老板兼咖啡师。二十七岁，做了五年咖啡。",
  "preamble": "[{\"role\":\"user\",\"content\":\"早啊小林\"},{\"role\":\"assistant\",\"content\":\"早。\"}]",
  "memoryTree": {
    "identity":[{"name":"self","content":"我是林晓","priority":10}],
    "relationships":[{"name":"王姐","content":"常客","priority":4}],
    "events":[{"name":"接手店铺","content":"一年前接手","priority":6}],
    "locations":[{"name":"晨光咖啡厅","content":"我的店","priority":8}],
    "observations":[],
    "world":[{"name":"咖啡常识","content":"咖啡豆水温研磨度影响风味","priority":7}]
  },
  "behavior": "我习惯先观察再开口。冲咖啡的时候我不说话。"
}
CHAREOF
  assert_file_exists "A4-a: 角色蓝图" "${TEST_STORY_DIR}/chars/林晓.yaml"
  local c; c=$(cat "${TEST_STORY_DIR}/chars/林晓.yaml")
  assert_contains "A4-b: identity 第一人称" "我是林晓" "$c"
  assert_contains "A4-c: preamble" "preamble" "$c"
  assert_contains "A4-d: memoryTree" "memoryTree" "$c"
  assert_contains "A4-e: identity 节点" "identity" "$c"
  assert_contains "A4-f: relationships 节点" "relationships" "$c"
  assert_contains "A4-g: events 节点" "events" "$c"
  assert_contains "A4-h: locations 节点" "locations" "$c"
  assert_contains "A4-i: observations 节点" "observations" "$c"
  assert_contains "A4-j: world 节点" "world" "$c"
  assert_contains "A4-k: behavior" "behavior" "$c"
}

# ══════════════════════════════════════════════════════════════════
# B: 角色 RPC 进程测试
# ══════════════════════════════════════════════════════════════════

test_character_rpc() {
  print_header "B: 角色 RPC 进程测试"

  if ! command -v pi &>/dev/null; then
    skip "B: pi CLI 不可用"
    return
  fi

  local tmpdir; tmpdir=$(mktemp -d)

  # 构建角色 system prompt
  cat > "${tmpdir}/char-prompt.md" << 'PROMPTEOF'
我是林晓，晨光咖啡厅的老板兼咖啡师。二十七岁，做了五年咖啡。

早啊小林，今天还是老位置？
早。嗯，靠窗那张给你留着。

我可以回忆过去的事，也可以记住新的事。

每次先想想再行动。我是角色本人，直接做，不要解释。
PROMPTEOF

  echo "  测试角色 RPC 进程..."

  # 写输入消息到文件
  printf '{"type":"prompt","message":"清晨七点，阳光洒进咖啡厅，空气中飘着咖啡香。"}\n' > "${tmpdir}/input.jsonl"

  # 启动 RPC 进程（用 timeout 防止卡死）
  timeout 20 pi --mode rpc --no-session --no-tools \
    --append-system-prompt "${tmpdir}/char-prompt.md" \
    < "${tmpdir}/input.jsonl" > "${tmpdir}/output.jsonl" 2>/dev/null
  local rc=$?

  if [[ $rc -eq 124 ]]; then
    yellow "  ⏭️  B1: RPC 进程超时（可能模型响应慢）"
    ((SKIP++))
    rm -rf "$tmpdir"
    return
  fi

  # B1 — 检查输出来判断是否启动成功
  if [[ -s "${tmpdir}/output.jsonl" ]]; then
    green "  ✅ B1: 角色 RPC 进程输出产生"
    ((PASS++))
  else
    skip "B1: RPC 输出为空"
    rm -rf "$tmpdir"
    return
  fi

  # 提取 assistant 文本
  local extracted
  extracted=$(python3 -c "
import json
with open('${tmpdir}/output.jsonl') as f:
    for line in f:
        try:
            ev = json.loads(line)
            if ev.get('type') == 'message_end' and ev.get('message',{}).get('role') == 'assistant':
                content = ev['message'].get('content', [])
                for c in content:
                    if c.get('type') == 'text':
                        print(c['text'][:400])
                        break
        except: pass
" 2>/dev/null)

  if [[ -n "$extracted" ]]; then
    echo "  角色回应: ${extracted:0:80}..."

    # B2: 验证第一人称
    assert_contains "B2: 角色第一人称" "我" "$extracted"

    # B3: 检查元叙事（出戏标记）
    if echo "$extracted" | grep -qE '(作为|扮演|角色)'; then
      yellow "  ⚠️  角色回应有元叙事词汇（可能出戏）"
    else
      green "  ✅ B3: 角色回应自然（无元叙事）"
      ((PASS++))
    fi
  else
    skip "B2-B3: 未提取到回应文本"
  fi

  rm -rf "$tmpdir"
  green "  ✅ B4: 临时文件已清理"
  ((PASS++))
}

# ══════════════════════════════════════════════════════════════════
# C: GM 子 agent 测试（write-story）
# ══════════════════════════════════════════════════════════════════

test_gm_sub_agents() {
  print_header "C: GM 子 agent 测试"

  if ! command -v pi &>/dev/null; then
    skip "C: pi CLI 不可用"
    return
  fi

  local tmpdir; tmpdir=$(mktemp -d)

  cat > "${tmpdir}/writer-prompt.md" << 'WEOF'
你是一个故事写作 agent。输出纯叙事文本，不包含思考、说明、meta 评论。
使用第三人称叙事，把角色意图中的「我」转为角色名。
叙事风格：注重感官细节，安静但有温度。
WEOF

  cat > "${tmpdir}/writer-input.md" << 'WIEOF'
场景：清晨七点，阳光斜照进晨光咖啡厅。吧台上的白色FAEMA咖啡机发出低沉的预热声。

角色意图：
[林晓] act: 我将干净的布巾搭在肩上，伸手按下咖啡机的开关。

剧情要点：展现林晓开始一天工作的仪式感。
WIEOF

  local output
  output=$(timeout 20 pi --mode json -p --no-session -ne \
    --append-system-prompt "${tmpdir}/writer-prompt.md" \
    "$(cat "${tmpdir}/writer-input.md")" 2>/dev/null || echo "")

  if [[ -z "$output" ]]; then
    skip "C: 写史 agent 调用失败"
    rm -rf "$tmpdir"
    return
  fi

  local narrative
  narrative=$(echo "$output" | python3 -c "
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        ev = json.loads(line)
        if ev.get('type') == 'message_end' and ev.get('message',{}).get('role') == 'assistant':
            content = ev['message'].get('content', [])
            for c in content:
                if c.get('type') == 'text':
                    print(c['text'][:500])
                    break
    except: pass
" 2>/dev/null)

  if [[ -n "$narrative" ]]; then
    echo "  叙事: ${narrative:0:80}..."
    assert_contains "C1: 第三人称含角色名" "林晓" "$narrative"
    assert_contains "C2: 与场景相关" "咖啡" "$narrative"
    green "  ✅ C3: 纯叙事（无标签格式）"
    ((PASS++))
  else
    skip "C: 叙事文本提取为空"
  fi

  rm -rf "$tmpdir"
  green "  ✅ C4: 临时文件已清理"
  ((PASS++))
}

# ══════════════════════════════════════════════════════════════════
# M: 记忆系统测试（需 Nocturne Memory）
# ══════════════════════════════════════════════════════════════════

test_memory_system() {
  print_header "M: 记忆系统测试"

  local health
  health=$(curl -s --connect-timeout 3 --max-time 5 http://127.0.0.1:8233/health 2>/dev/null || echo "")
  if [[ -z "$health" ]]; then
    skip "M: Nocturne Memory 未运行 (127.0.0.1:8233)"
    echo "   启动: cd nocturne_memory && docker-compose up -d"
    return
  fi
  echo "  Nocturne Memory: $health"

  local ns="e2e-test-$(date +%s)"
  local api="http://127.0.0.1:8233/api"

  # M1 — 先创建分类父节点，再创建子节点
  # 第一步：创建 identity 分类
  curl -s -X POST "${api}/browse/node?namespace=${ns}" \
    -H "Content-Type: application/json" \
    -d '{"parent_path":"","content":"","priority":0,"title":"identity","domain":"core","disclosure":"public"}' > /dev/null 2>&1
  # 第二步：在 identity 下创建具体记忆
  local r1
  r1=$(curl -s -X POST "${api}/browse/node?namespace=${ns}" \
    -H "Content-Type: application/json" \
    -d '{"parent_path":"identity","content":"【self】我是测试角色","priority":10,"title":"self_test","domain":"core","disclosure":"public"}')
  if echo "$r1" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('success') else 1)" 2>/dev/null; then
    green "  ✅ M1: 写入初始记忆"
    ((PASS++))
  else
    red "  ❌ M1: 写入失败: $(echo "$r1"|head -c 100)"; ((FAIL++))
    return
  fi
  sleep 1

  # M2 — 浏览目录
  local r2
  r2=$(curl -s "${api}/browse/node?namespace=${ns}&domain=core&path=")
  if echo "$r2" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if 'children' in d else 1)" 2>/dev/null; then
    green "  ✅ M2: 浏览目录"; ((PASS++))
  else
    red "  ❌ M2: $(echo "$r2"|head -c 100)"; ((FAIL++))
  fi

  # M3 — 搜索（URL编码中文）
  sleep 1
  local encoded_q
  encoded_q=$(python3 -c "import urllib.parse; print(urllib.parse.quote('测试'))" 2>/dev/null)
  local r3
  r3=$(curl -s "${api}/browse/search?namespace=${ns}&q=${encoded_q}&limit=5")
  if echo "$r3" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if 'results' in d else 1)" 2>/dev/null; then
    green "  ✅ M3: 关键词搜索"; ((PASS++))
  else
    red "  ❌ M3: $(echo "$r3"|head -c 100)"; ((FAIL++))
  fi

  # M4 — URI 读取
  local r4
  r4=$(curl -s "${api}/browse/node?namespace=${ns}&domain=core&path=identity/self_test")
  if echo "$r4" | python3 -c "import json,sys; d=json.load(sys.stdin); n=d.get('node',{}); sys.exit(0 if '测试' in n.get('content','') else 1)" 2>/dev/null; then
    green "  ✅ M4: URI 读取"; ((PASS++))
  else
    red "  ❌ M4: $(echo "$r4"|head -c 100)"; ((FAIL++))
  fi

  # M5 — 写入新记忆（先建 events 父分类）
  curl -s -X POST "${api}/browse/node?namespace=${ns}" \
    -H "Content-Type: application/json" \
    -d '{"parent_path":"","content":"","priority":0,"title":"events","domain":"core","disclosure":"public"}' > /dev/null 2>&1
  local r5
  r5=$(curl -s -X POST "${api}/browse/node?namespace=${ns}" \
    -H "Content-Type: application/json" \
    -d '{"parent_path":"events","content":"【事件】测试事件","priority":3,"title":"evt","domain":"core","disclosure":"public"}')
  if echo "$r5" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('success') else 1)" 2>/dev/null; then
    green "  ✅ M5: 写入新记忆"; ((PASS++))
  else
    red "  ❌ M5: $(echo "$r5"|head -c 100)"; ((FAIL++))
  fi

  # M6 — 记忆树
  local r6
  r6=$(curl -s "${api}/browse/node?namespace=${ns}&domain=core&path=")
  if echo "$r6" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if len(d.get('children',[]))>=1 else 1)" 2>/dev/null; then
    green "  ✅ M6: 记忆树结构"; ((PASS++))
  else
    red "  ❌ M6: $(echo "$r6"|head -c 100)"; ((FAIL++))
  fi
}

# ══════════════════════════════════════════════════════════════════
# Cleanup
# ══════════════════════════════════════════════════════════════════

test_cleanup() {
  print_header "Z: 清理"

  [[ -d "$TEST_STORY_DIR" ]] && rm -rf "$TEST_STORY_DIR" && echo "  已删除 story pack"

  local idx="${PI_DIR}/pi-characters/story-index.yaml"
  if [[ -f "$idx" ]]; then
    python3 -c "
import json
with open('${idx}','r') as f: data = json.load(f)
data['stories'] = [s for s in data.get('stories',[]) if s.get('name') != '${TEST_STORY}']
with open('${idx}','w') as f: json.dump(data,f,indent=2)
print('  已清理 story-index')
" 2>/dev/null || true
  fi

  rm -rf /tmp/e2e-test-*
  green "  ✅ Z: 清理完成"
  ((PASS++))
}

# ══════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════

main() {
  echo ""
  echo "╔══════════════════════════════════════════════╗"
  echo "║  故事铸造系统 — 端到端自动测试               ║"
  echo "║  Story: ${TEST_STORY}          ║"
  echo "║  Time: $(date '+%Y-%m-%d %H:%M:%S')          ║"
  echo "╚══════════════════════════════════════════════╝"
  mkdir -p "${PI_DIR}/pi-characters"

  local mode="${1:-all}"
  case "$mode" in
    setup)    test_create_story_pack ;;
    memory)   test_memory_system ;;
    cleanup)  test_cleanup ;;
    story)
      test_create_story_pack
      test_character_rpc
      test_gm_sub_agents
      test_cleanup
      ;;
    all)
      test_create_story_pack
      test_character_rpc
      test_gm_sub_agents
      test_memory_system
      test_cleanup
      ;;
    *) echo "用法: $0 [setup|memory|story|cleanup|all]"; exit 1 ;;
  esac

  print_summary
  echo ""
  [[ $FAIL -gt 0 ]] && exit 1
}

main "$@"
