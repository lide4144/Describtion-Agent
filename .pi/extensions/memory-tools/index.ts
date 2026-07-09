/**
 * Memory Tools Extension — 为角色子进程注册 recall / memorize / memory-tree 工具
 *
 * 加载方式: pi --mode rpc -e .pi/extensions/memory-tools/index.ts --no-tools
 *   --tools recall,memorize,memory-tree
 *
 * 所有代码内联在此文件，避免 pi 扩展加载器的 TS 模块解析问题。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ════════════════════════════════════════════════════════════════════════════
// Nocturne Memory HTTP Client (内联，不依赖外部 .ts 模块)
// ════════════════════════════════════════════════════════════════════════════

const NM_BASE = "http://127.0.0.1:8233/api";

interface BrowseResult {
  node: {
    path: string; domain: string; uri: string; name: string;
    content: string; priority: number; disclosure: string | null;
    created_at: string | null; is_virtual: boolean; node_uuid: string;
  };
  children: Array<{
    domain: string; path: string; uri: string; name: string;
    priority: number; content_snippet: string; approx_children_count: number;
  }>;
}

async function nmRequest<T>(method: string, path: string, params?: Record<string, string>, body?: unknown): Promise<T> {
  const url = new URL(`${NM_BASE}${path}`);
  if (params) for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`NM API ${method} ${path}: ${res.status} — ${text.slice(0, 150)}`);
  }
  return res.json() as Promise<T>;
}

/** 读取记忆节点 */
async function fnReadNode(namespace: string, domain: string, path: string): Promise<BrowseResult> {
  return nmRequest<BrowseResult>("GET", "/browse/node", { namespace, domain, path });
}

/** 搜索记忆 */
async function fnSearch(namespace: string, query: string, limit = 10): Promise<{ query: string; results: Array<{ domain: string; path: string; uri: string; snippet: string; priority: number }>; count: number }> {
  return nmRequest("GET", "/browse/search", { namespace, q: query, limit: String(limit) });
}

/** 创建记忆节点 */
async function fnCreateNode(namespace: string, parentPath: string, content: string, priority: number, title?: string): Promise<{ success: boolean; uri: string; memory_id: string }> {
  return nmRequest("POST", "/browse/node", { namespace }, {
    parent_path: parentPath,
    content,
    priority: Math.max(0, Math.min(10, priority)),
    title: title || undefined,
    domain: "core",
    disclosure: "public",
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

/**
 * 将任意字符串转为 ASCII-safe 的路径名。
 * 规则：非 [a-zA-Z0-9_-] 的字符替换为下划线，连续下划线合并。
 * 中文 → 取拼音首字母+下划线，或直接取 Unicode 短哈希。
 * 这里用简单方式：strip non-ASCII，如果结果为空则用 "m_"+hex(前4位codePoint)。
 */
function toSafeTitle(name: string): string {
  // 先尝试保留 ASCII 部分
  const ascii = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (ascii.length >= 2) return ascii;
  // ASCII 部分不够，用 unicode codepoint 短哈希
  let hash = "";
  for (let i = 0; i < name.length && hash.length < 12; i++) {
    const cp = name.codePointAt(i);
    if (cp && cp > 127) hash += cp.toString(36);
  }
  return hash ? `m_${hash}` : `m_${Date.now().toString(36)}`;
}

// ════════════════════════════════════════════════════════════════════════════
// Exported setup helper — 被 story-session.ts 调用
// ════════════════════════════════════════════════════════════════════════════

/**
 * 初始化角色在 Nocturne Memory 中的 namespace，导入 blueprint 的初始记忆树。
 * 在 startCharacterSession 时调用。
 */
export async function initCharacterMemory(
  charName: string,
  memoryTree: Record<string, Array<{ name: string; content: string; priority: number }>>,
): Promise<void> {
  // 检查 namespace 是否已有数据
  try {
    const root = await fnReadNode(charName, "core", "");
    if (root.children.length > 0) {
      console.log(`[NM] 角色 ${charName} 已有记忆，跳过导入`);
      return; // 已有记忆，跳过
    }
  } catch {
    // namespace 不存在或为空，继续导入
  }

  // 逐条导入记忆
  // 先创建分类父节点（如 identity, relationships），再创建子节点
  let count = 0;
  for (const [category, nodes] of Object.entries(memoryTree)) {
    if (!Array.isArray(nodes)) continue;

    // 尝试创建分类父节点（如果已存在会跳过）
    try {
      await fnCreateNode(charName, "", "", 0, category);
    } catch { /* 已存在，跳过 */ }

    // 创建子节点
    for (const node of nodes) {
      try {
        const safeTitle = toSafeTitle(node.name);
        // 在 content 前加上原始名称，便于搜索和展示
        const displayContent = `【${node.name}】${node.content}`;
        await fnCreateNode(charName, category, displayContent, node.priority, safeTitle);
        count++;
      } catch (e: any) {
        if (!e.message.includes("422")) {
          console.warn(`[NM] 导入 ${category}/${node.name} 失败: ${e.message}`);
        }
      }
    }
  }
  console.log(`[NM] 角色 ${charName} 初始记忆导入完成: ${count} 条`);
}

/**
 * 获取角色的 boot 记忆文本（注入 system prompt 用）。
 */
export async function fetchBootMemories(charName: string): Promise<string> {
  try {
    const root = await fnReadNode(charName, "core", "");
    const parts: string[] = [];

    for (const child of root.children) {
      try {
        const detail = await fnReadNode(charName, child.domain, child.path);
        if (detail.node.content) {
          const lines = [`## ${detail.node.uri}`, detail.node.content];
          if (detail.children.length > 0) {
            for (const sub of detail.children) {
              try {
                const subDetail = await fnReadNode(charName, sub.domain, sub.path);
                if (subDetail.node.content) {
                  lines.push(`\n### ${subDetail.node.name}`);
                  lines.push(subDetail.node.content);
                }
              } catch { /* skip */ }
            }
          }
          parts.push(lines.join("\n"));
        }
      } catch { /* skip */ }
    }

    return parts.length > 0 ? `## 我记住的事\n\n${parts.join("\n\n---\n\n")}` : "";
  } catch {
    return "";
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Pi Extension — 注册 recall / memorize / memory-tree 工具
// ════════════════════════════════════════════════════════════════════════════

function parseUri(uri: string): { domain: string; path: string } {
  const m = uri.match(/^([a-z][a-z0-9_]*):\/\/(.+)$/);
  if (!m) throw new Error(`无效 URI: ${uri}`);
  return { domain: m[1], path: m[2] };
}

export default function (pi: ExtensionAPI) {
  // ══════════════════════════════════════════════════════════════════════════
  // recall — 回忆
  // ══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "recall",
    label: "回忆",
    description: "回忆过去的事。搜索关键词或读取具体的记忆节点。不传参数时浏览记忆目录。",
    parameters: Type.Object({
      char: Type.String({ description: "我的名字" }),
      query: Type.Optional(Type.String({ description: "搜索关键词——想起某个模糊的人或事" })),
      uri: Type.Optional(Type.String({ description: "具体的记忆 URI，如 core://relationships/远坂凛" })),
    }),

    async execute(_id, params, _sig, _upd, _ctx) {
      const ns = params.char;
      try {
        if (params.uri) {
          const { domain, path } = parseUri(params.uri);
          const res = await fnReadNode(ns, domain, path);
          const lines = [`📍 ${res.node.uri}`];
          if (res.node.content) lines.push(res.node.content);
          if (res.node.priority > 0) lines.push(`[重要: ${res.node.priority}/10]`);
          if (res.children.length > 0) {
            lines.push("\n相关的记忆:");
            for (const c of res.children) {
              const snip = c.content_snippet ? ` — ${c.content_snippet.slice(0, 80)}` : "";
              lines.push(`  • ${c.uri}${snip}`);
            }
          }
          return { content: [{ type: "text", text: lines.join("\n") }], details: { type: "recall", uri: params.uri } };
        }

        if (params.query) {
          const sr = await fnSearch(ns, params.query);
          if (sr.results.length === 0) return { content: [{ type: "text", text: `想不起来和"${params.query}"有关的事。` }], details: { type: "recall", query: params.query, count: 0 } };
          const lines = [`搜索"${params.query}" — 找到 ${sr.count} 条:\n`];
          for (const r of sr.results) lines.push(`  • ${r.uri}: ${r.snippet.slice(0, 120)}`);
          lines.push("\n(用 uri 参数读取完整内容)");
          return { content: [{ type: "text", text: lines.join("\n") }], details: { type: "recall", query: params.query, count: sr.count } };
        }

        // 浏览目录
        const root = await fnReadNode(ns, "core", "");
        const lines = ["## 📖 我的记忆\n"];
        for (const c of root.children) {
          const snip = c.content_snippet ? ` — ${c.content_snippet.slice(0, 60)}` : "";
          const kids = c.approx_children_count > 0 ? ` (${c.approx_children_count}条)` : "";
          lines.push(`  • ${c.uri}${kids}${snip}`);
        }
        if (root.children.length === 0) lines.push("  (还没有任何记忆)");
        lines.push("\n用 uri 或 query 查找具体记忆。");
        return { content: [{ type: "text", text: lines.join("\n") }], details: { type: "recall", mode: "browse" } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `回忆时走神了: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ══════════════════════════════════════════════════════════════════════════
  // memorize — 记住
  // ══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "memorize",
    label: "记住",
    description: "记住新发生的事。写下我想记住的内容和分类路径。",
    parameters: Type.Object({
      char: Type.String({ description: "我的名字" }),
      content: Type.String({ description: "要记住的内容——用第一人称写" }),
      path: Type.String({ description: "存放路径，如 relationships/远坂凛 或 events/今天的事" }),
      priority: Type.Optional(Type.Number({ description: "重要程度 0-10，默认 5" })),
    }),

    async execute(_id, params, _sig, _upd, _ctx) {
      try {
        const priority = params.priority ?? 5;
        const segments = params.path.split("/");
        const rawTitle = segments.pop()!;
        const parentPath = segments.join("/");
        const safeTitle = toSafeTitle(rawTitle);
        const content = `【${rawTitle}】${params.content}`;
        const result = await fnCreateNode(params.char, parentPath, content, priority, safeTitle);
        return { content: [{ type: "text", text: `✅ 记住了: ${result.uri}` }], details: { type: "memorize", uri: result.uri } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `没记住: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ══════════════════════════════════════════════════════════════════════════
  // memory-tree — 浏览记忆树
  // ══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "memory-tree",
    label: "记忆树",
    description: "浏览我的记忆结构，查看有哪些分类和内容。",
    parameters: Type.Object({
      char: Type.String({ description: "我的名字" }),
      path: Type.Optional(Type.String({ description: "从哪个路径开始，空=根目录" })),
    }),

    async execute(_id, params, _sig, _upd, _ctx) {
      try {
        const res = await fnReadNode(params.char, "core", params.path || "");
        const lines = [`📂 ${res.node.uri}`];
        if (res.node.content) lines.push(res.node.content.slice(0, 200));
        if (res.children.length === 0) {
          lines.push("（空）");
        } else {
          lines.push("");
          for (const c of res.children) {
            const snip = c.content_snippet ? ` — ${c.content_snippet.slice(0, 60)}` : "";
            const kids = c.approx_children_count > 0 ? ` [${c.approx_children_count}个子节点]` : "";
            lines.push(`  📄 ${c.uri} (p=${c.priority})${kids}${snip}`);
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }], details: { type: "memory_tree", char: params.char } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `想不起来: ${e.message}` }], details: {}, isError: true };
      }
    },
  });
}
