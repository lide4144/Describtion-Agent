/**
 * Save/Load — 故事存档与读档
 *
 * 职责：
 *   saveStory / loadStory / listSaves
 *   以及底层的 Nocturne Memory namespace 导出/导入
 *
 * 覆盖保证：
 *   load 时先清空 namespace 再重建，确保无残留
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CharacterMap, CharacterSession } from "./story-session.ts";

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

/** 一个记忆节点的扁平表示（序列化用） */
export interface MemoryNodeExport {
  path: string;
  domain: string;
  content: string;
  priority: number;
  title: string;
}

/** 一个角色在某个时刻的全部记忆 */
export interface CharacterMemoryDump {
  namespace: string;
  exportedAt: string;
  nodes: MemoryNodeExport[];
}

/** 一次存档的概要信息 */
export interface SaveSummary {
  storyName: string;
  saveName: string;
  savedAt: string;
  characters: string[];
  nodeCount: number;
}

/** 存档元信息（写入 save-index.yaml） */
export interface SaveMeta {
  name: string;
  savedAt: string;
  characters: string[];
  nodeCount: number;
  description?: string;
}

// ═══════════════════════════════════════════════════════════════
// Nocturne Memory HTTP Client (同 memory-tools 的通信方式)
// ═══════════════════════════════════════════════════════════════

const NM_BASE = "http://127.0.0.1:8233/api";

async function nmRequest<T>(
  method: string,
  apiPath: string,
  params?: Record<string, string>,
  body?: unknown,
): Promise<T> {
  const url = new URL(`${NM_BASE}${apiPath}`);
  if (params) for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`NM API ${method} ${apiPath}: ${res.status} — ${text.slice(0, 150)}`);
  }
  return res.json() as Promise<T>;
}

/** 获取某个 namespace + domain 下的直接子节点列表 */
interface ChildInfo {
  domain: string;
  path: string;
  uri: string;
  name: string;
  priority: number;
  content_snippet: string;
  approx_children_count: number;
}

interface NodeDetail {
  node: {
    path: string;
    domain: string;
    uri: string;
    name: string;
    content: string;
    priority: number;
    disclosure: string | null;
    created_at: string | null;
    is_virtual: boolean;
    node_uuid: string;
  };
  children: ChildInfo[];
}

async function readNode(
  ns: string,
  domain: string,
  pathStr: string,
): Promise<NodeDetail> {
  return nmRequest<NodeDetail>("GET", "/browse/node", {
    namespace: ns,
    domain,
    path: pathStr,
  });
}

async function deleteNode(
  ns: string,
  domain: string,
  pathStr: string,
): Promise<void> {
  await nmRequest("DELETE", "/browse/node", {
    namespace: ns,
    domain,
    path: pathStr,
  });
}

interface CreateResult {
  success: boolean;
  uri: string;
  memory_id: string;
}

async function createNode(
  ns: string,
  parentPath: string,
  content: string,
  priority: number,
  title?: string,
): Promise<CreateResult> {
  return nmRequest<CreateResult>("POST", "/browse/node", { namespace: ns }, {
    parent_path: parentPath,
    content: content || "",
    priority: Math.max(0, Math.min(10, priority || 0)),
    title: title || undefined,
    domain: "core",
    disclosure: "public",
  } as any);
}

// ═══════════════════════════════════════════════════════════════
// dumpNamespace — 递归导出整个 namespace
// ═══════════════════════════════════════════════════════════════

/**
 * 递归遍历一个角色 namespace 的全部记忆节点，导出为扁平列表。
 *
 * 通过递归读取根节点 → 子节点 → 孙子节点 的方式完整遍历树。
 * 每个节点包含 path / domain / content / priority / title。
 */
export async function dumpNamespace(ns: string): Promise<CharacterMemoryDump> {
  const nodes: MemoryNodeExport[] = [];
  await walkNode(ns, "core", "", nodes);
  return {
    namespace: ns,
    exportedAt: new Date().toISOString(),
    nodes,
  };
}

/** 递归遍历辅助 */
async function walkNode(
  ns: string,
  domain: string,
  pathStr: string,
  accumulator: MemoryNodeExport[],
): Promise<void> {
  const detail = await readNode(ns, domain, pathStr);

  // 跳过虚拟根节点（is_virtual = true）和空路径
  if (pathStr !== "" && !detail.node.is_virtual) {
    const title = detail.node.name || detail.node.path.split("/").pop() || "";
    accumulator.push({
      path: detail.node.path,
      domain: detail.node.domain,
      content: detail.node.content || "",
      priority: detail.node.priority || 0,
      title,
    });
  }

  // 递归遍历子节点
  for (const child of detail.children) {
    await walkNode(ns, child.domain, child.path, accumulator);
  }
}

// ═══════════════════════════════════════════════════════════════
// clearNamespace — 清空整个 namespace（保证完全覆盖）
// ═══════════════════════════════════════════════════════════════

/**
 * 递归删除一个节点及其所有子节点（从叶子到根）。
 * 因为 Nocturne Memory 的 DELETE 有孤儿保护，必须先删子节点。
 */
async function deleteNodeRecursive(
  ns: string,
  domain: string,
  pathStr: string,
): Promise<void> {
  const detail = await readNode(ns, domain, pathStr);
  // 递归删除所有子节点（叶子优先）
  for (const child of detail.children) {
    await deleteNodeRecursive(ns, child.domain, child.path);
  }
  // 如果不是根节点，删除自己
  if (pathStr !== "") {
    try {
      await deleteNode(ns, domain, pathStr);
    } catch (e: any) {
      if (!e.message.includes("404")) throw e;
    }
  }
}

/**
 * 清空整个 namespace。
 * 从叶子到根递归删除所有节点，确保完全清空。
 */
export async function clearNamespace(ns: string): Promise<void> {
  const detail = await readNode(ns, "core", "");
  for (const child of detail.children) {
    await deleteNodeRecursive(ns, child.domain, child.path);
  }
}

// ═══════════════════════════════════════════════════════════════
// restoreNamespace — 导入记忆到 namespace（先清空再重建）
// ═══════════════════════════════════════════════════════════════

/**
 * 将存档中的记忆恢复到指定 namespace。
 * 保证完全覆盖：先 clearNamespace 清空，再逐个创建。
 *
 * 创建时按层级顺序：先建分类父节点（identity），再建子节点（identity/self）。
 */
export async function restoreNamespace(
  ns: string,
  dump: CharacterMemoryDump,
): Promise<number> {
  // 先清空
  await clearNamespace(ns);

  let count = 0;

  // 按路径深度排序（确保父节点先于子节点创建）
  const sorted = [...dump.nodes].sort((a, b) => {
    const aDepth = a.path.split("/").length;
    const bDepth = b.path.split("/").length;
    if (aDepth !== bDepth) return aDepth - bDepth;
    return a.path.localeCompare(b.path);
  });

  for (const node of sorted) {
    try {
      // 父路径 = 去掉最后一段
      const segments = node.path.split("/");
      const title = segments.pop()!;
      const parentPath = segments.join("/");

      await createNode(
        ns,
        parentPath,
        node.content,
        node.priority,
        title,
      );
      count++;
    } catch (e: any) {
      // 如果节点已存在（可能由父节点创建时自动创建），跳过
      if (!e.message.includes("422")) {
        console.warn(`[save-load] 恢复节点失败 ${node.path}: ${e.message}`);
      }
    }
  }

  return count;
}

// ═══════════════════════════════════════════════════════════════
// saveStory — 存档
// ═══════════════════════════════════════════════════════════════

export interface SaveStoryOptions {
  storyName: string;
  saveName: string;
  storiesDir: string;
  activeCharacters: CharacterMap;
}

/**
 * 保存当前故事状态到命名存档。
 *
 * 流程：
 *   1. 创建 saves/{saveName}/ 目录
 *   2. 对每个活跃角色，dumpNamespace → 写 charMemory/{charName}.json
 *   3. 复制 story-log.md（如果存在）
 *   4. 写 save-index.yaml + 更新 story-index.yaml
 */
export async function saveStory(options: SaveStoryOptions): Promise<SaveSummary> {
  const { storyName, saveName, storiesDir, activeCharacters } = options;
  const saveDir = path.join(storiesDir, storyName, "saves", saveName);
  const charMemoryDir = path.join(saveDir, "charMemory");

  // 创建目录
  fs.mkdirSync(charMemoryDir, { recursive: true });

  const charNames: string[] = [];
  let totalNodes = 0;

  // 对每个活跃角色，导出记忆
  for (const [charName] of activeCharacters) {
    try {
      const dump = await dumpNamespace(charName);
      fs.writeFileSync(
        path.join(charMemoryDir, `${charName}.json`),
        JSON.stringify(dump, null, 2),
        "utf-8",
      );
      charNames.push(charName);
      totalNodes += dump.nodes.length;
    } catch (e: any) {
      console.warn(`[save-load] 导出角色 ${charName} 记忆失败: ${e.message}`);
    }
  }

  // 复制 story-log.md
  const logSrc = path.join(storiesDir, storyName, "story-log.md");
  if (fs.existsSync(logSrc)) {
    fs.copyFileSync(logSrc, path.join(saveDir, "story-log.md"));
  }

  // 写 save-index.yaml
  const saveMeta: SaveMeta = {
    name: saveName,
    savedAt: new Date().toISOString(),
    characters: charNames,
    nodeCount: totalNodes,
  };
  await appendSaveIndex(storyName, saveName, saveMeta, storiesDir);

  return {
    storyName,
    saveName,
    savedAt: saveMeta.savedAt,
    characters: charNames,
    nodeCount: totalNodes,
  };
}

// ═══════════════════════════════════════════════════════════════
// loadStory — 读档（完全覆盖）
// ═══════════════════════════════════════════════════════════════

export interface LoadStoryOptions {
  storyName: string;
  saveName: string;
  storiesDir: string;
  activeCharacters: CharacterMap;
  /** 重启角色的回调函数 */
  restartCharacter: (name: string) => Promise<void>;
}

export interface LoadSummary {
  storyName: string;
  saveName: string;
  characters: string[];
  nodeCount: number;
  storyLogRestored: boolean;
}

/**
 * 从命名存档恢复故事状态。
 *
 * 流程：
 *   1. 停止所有当前角色 session（由调用者负责）
 *   2. 对存档中每个角色，restoreNamespace
 *   3. 恢复 story-log.md
 *   4. 重启角色 session
 */
export async function loadStory(options: LoadStoryOptions): Promise<LoadSummary> {
  const { storyName, saveName, storiesDir, restartCharacter } = options;
  const saveDir = path.join(storiesDir, storyName, "saves", saveName);
  const charMemoryDir = path.join(saveDir, "charMemory");

  if (!fs.existsSync(saveDir)) {
    throw new Error(`存档不存在: ${saveName}`);
  }

  const charNames: string[] = [];
  let totalNodes = 0;

  // 恢复每个角色的记忆
  if (fs.existsSync(charMemoryDir)) {
    const files = fs.readdirSync(charMemoryDir).filter(f => f.endsWith(".json"));
    for (const file of files) {
      const charName = file.replace(/\.json$/, "");
      const dump: CharacterMemoryDump = JSON.parse(
        fs.readFileSync(path.join(charMemoryDir, file), "utf-8"),
      );
      const count = await restoreNamespace(charName, dump);
      charNames.push(charName);
      totalNodes += count;
    }
  }

  // 恢复 story-log.md
  let storyLogRestored = false;
  const logSrc = path.join(saveDir, "story-log.md");
  if (fs.existsSync(logSrc)) {
    fs.copyFileSync(logSrc, path.join(storiesDir, storyName, "story-log.md"));
    storyLogRestored = true;
  }

  // 重启角色 session
  for (const name of charNames) {
    try {
      await restartCharacter(name);
    } catch (e: any) {
      console.warn(`[save-load] 重启角色 ${name} 失败: ${e.message}`);
    }
  }

  return {
    storyName,
    saveName,
    characters: charNames,
    nodeCount: totalNodes,
    storyLogRestored,
  };
}

// ═══════════════════════════════════════════════════════════════
// listSaves — 列出存档
// ═══════════════════════════════════════════════════════════════

/**
 * 列出某个故事的所有命名存档。
 */
export async function listSaves(
  storyName: string,
  storiesDir: string,
): Promise<SaveMeta[]> {
  const indexPath = path.join(storiesDir, storyName, "saves", "save-index.yaml");
  if (!fs.existsSync(indexPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    return (data.saves || []) as SaveMeta[];
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

async function appendSaveIndex(
  storyName: string,
  saveName: string,
  meta: SaveMeta,
  storiesDir: string,
): Promise<void> {
  const indexPath = path.join(storiesDir, storyName, "saves", "save-index.yaml");
  let index: { saves: SaveMeta[] } = { saves: [] };
  if (fs.existsSync(indexPath)) {
    try {
      index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    } catch { /* reset */ }
  }

  // 替换同名或追加
  const existing = index.saves.findIndex(s => s.name === saveName);
  if (existing >= 0) {
    index.saves[existing] = meta;
  } else {
    index.saves.push(meta);
  }

  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
}
