/**
 * File I/O layer for the context offload plugin.
 *
 * Multi-agent / multi-session storage isolation:
 *   - Different agents get separate subdirectories under dataRoot
 *   - Same agent shares mmds/, refs/, state.json
 *   - offload is per-session: offload-<sessionId>.jsonl
 *   - L2 aggregation reads all offload-*.jsonl in the agent dir
 *   - All I/O functions require a StorageContext (no global mutable state)
 */
import { readFile, writeFile, appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
/** Default root data directory (parent of all agent subdirectories) */
export const DEFAULT_DATA_ROOT = join(homedir(), ".openclaw", "context-offload");
/**
 * Build an immutable StorageContext for a given agent + session.
 * Once created, paths are frozen and cannot be affected by other sessions.
 */
export function createStorageContext(dataRoot, agentName, sessionId) {
    const dataDir = join(dataRoot, agentName);
    return Object.freeze({
        dataRoot,
        dataDir,
        refsDir: join(dataDir, "refs"),
        mmdsDir: join(dataDir, "mmds"),
        offloadJsonl: join(dataDir, `offload-${sessionId}.jsonl`),
        stateFile: join(dataDir, "state.json"),
        agentName,
        sessionId,
    });
}
// ─── SessionKey Parsing ──────────────────────────────────────────────────────
/** Sanitize a string for use as a directory/file name */
function sanitizePath(s) {
    return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\.{2,}/g, "_");
}
/**
 * Parse a sessionKey into agentName and sessionId.
 * Expected format: "agent:<agent-name>:<session-id>"
 *
 * Worker isolation: if the sessionId contains a "swebench-w{N}" pattern
 * (from multi-worker inference), the worker suffix is merged into agentName
 * so each worker gets its own dataDir (state.json, mmds/, refs/).
 *
 * Returns null if format doesn't match.
 */
export function parseSessionKey(sessionKey) {
    if (typeof sessionKey !== "string")
        return null;
    const parts = sessionKey.split(":");
    if (parts.length < 3 || parts[0] !== "agent" || !parts[1])
        return null;
    let agentName = parts[1];
    const sessionId = parts.slice(2).join(":");
    if (!sessionId)
        return null;
    const workerMatch = sessionId.match(/swebench-w(\d+)/);
    if (workerMatch) {
        agentName = `${agentName}-w${workerMatch[1]}`;
    }
    return {
        agentName: sanitizePath(agentName),
        sessionId: sanitizePath(sessionId),
    };
}
// ─── Directory Operations ────────────────────────────────────────────────────
/** Ensure all required directories exist for the given context */
export async function ensureDirs(ctx) {
    await mkdir(ctx.dataRoot, { recursive: true });
    await mkdir(ctx.dataDir, { recursive: true });
    await mkdir(ctx.refsDir, { recursive: true });
    await mkdir(ctx.mmdsDir, { recursive: true });
}
// ─── Session Registry ────────────────────────────────────────────────────────
/** Record a sessionKey → realSessionId mapping in the agent's registry. */
export async function registerSession(ctx, sessionKey, realSessionId) {
    if (!sessionKey || !realSessionId || !existsSync(ctx.dataDir))
        return;
    const registryPath = join(ctx.dataDir, "sessions-registry.json");
    let registry = {};
    try {
        if (existsSync(registryPath)) {
            registry = JSON.parse(await readFile(registryPath, "utf-8"));
        }
    }
    catch {
        /* corrupt file, start fresh */
    }
    registry[sessionKey] = {
        sessionId: realSessionId,
        offloadFile: `offload-${realSessionId}.jsonl`,
        updatedAt: new Date().toISOString(),
    };
    await writeFile(registryPath, JSON.stringify(registry, null, 2), "utf-8");
}
/** Look up the real sessionId for a given sessionKey from the registry. */
export async function lookupSessionId(ctx, sessionKey) {
    if (!sessionKey || !existsSync(ctx.dataDir))
        return null;
    const registryPath = join(ctx.dataDir, "sessions-registry.json");
    try {
        if (!existsSync(registryPath))
            return null;
        const registry = JSON.parse(await readFile(registryPath, "utf-8"));
        return registry[sessionKey]?.sessionId ?? null;
    }
    catch {
        return null;
    }
}
/** List all registered sessions for the given context. */
export async function listRegisteredSessions(ctx) {
    if (!existsSync(ctx.dataDir))
        return [];
    const registryPath = join(ctx.dataDir, "sessions-registry.json");
    try {
        if (!existsSync(registryPath))
            return [];
        const registry = JSON.parse(await readFile(registryPath, "utf-8"));
        return Object.entries(registry).map(([key, val]) => ({
            sessionKey: key,
            ...val,
        }));
    }
    catch {
        return [];
    }
}
// ─── JSONL Defense Layer ─────────────────────────────────────────────────────
const UNSAFE_CHAR_RE = /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\u0080-\u009F\uD800-\uDFFF\u200B-\u200F\u2028\u2029\uFEFF]/gu;
/** Layer 0 — Source text sanitize. Strips unsafe characters from arbitrary text. */
export function sanitizeText(text) {
    if (typeof text !== "string")
        return text;
    return text.replace(UNSAFE_CHAR_RE, "");
}
/** Layer 1 — Write sanitize. Strips unsafe characters from a JSON string with roundtrip verification. */
export function sanitizeJsonLine(jsonStr) {
    let cleaned = jsonStr.replace(UNSAFE_CHAR_RE, "");
    try {
        JSON.parse(cleaned);
        return cleaned;
    }
    catch {
        /* fall through */
    }
    cleaned = jsonStr.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u024F\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF]/g, "");
    try {
        JSON.parse(cleaned);
        return cleaned;
    }
    catch {
        /* fall through */
    }
    try {
        const obj = JSON.parse(jsonStr.replace(/[^\x20-\x7E\t\n\r]/g, ""));
        return JSON.stringify(obj);
    }
    catch {
        return "{}";
    }
}
/** Layer 3 — Entry schema validation. */
export function validateEntry(entry) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
        return false;
    const e = entry;
    if (typeof e.tool_call_id !== "string" || e.tool_call_id.length === 0)
        return false;
    return true;
}
/** Layer 2+3+4 — Safe JSONL parser with tolerance, validation, and metrics. */
export function parseJsonlSafe(content, options) {
    const entries = [];
    let corruptCount = 0;
    let invalidCount = 0;
    let corruptSample = null;
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            try {
                parsed = JSON.parse(trimmed.replace(UNSAFE_CHAR_RE, ""));
            }
            catch {
                corruptCount++;
                if (corruptSample === null) {
                    corruptSample = trimmed.slice(0, 200);
                }
                continue;
            }
        }
        if (!options?.skipValidation && !validateEntry(parsed)) {
            invalidCount++;
            continue;
        }
        entries.push(parsed);
    }
    return { entries, corruptCount, invalidCount, corruptSample };
}
function safeStringifyEntry(entry) {
    return sanitizeJsonLine(JSON.stringify(entry));
}
// ─── JSONL Operations (current session) ──────────────────────────────────────
/** Append one or more entries to an offload JSONL with write-time dedup. */
export async function appendOffloadEntries(ctx, entries, targetSessionId, logger) {
    const filePath = targetSessionId && targetSessionId !== ctx.sessionId
        ? join(ctx.dataDir, `offload-${targetSessionId}.jsonl`)
        : ctx.offloadJsonl;
    let newEntries = entries;
    if (existsSync(filePath)) {
        try {
            const existingContent = await readFile(filePath, "utf-8");
            const existingIds = new Set();
            for (const line of existingContent.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed)
                    continue;
                try {
                    const parsed = JSON.parse(trimmed);
                    if (typeof parsed.tool_call_id === "string") {
                        existingIds.add(parsed.tool_call_id);
                        const norm = parsed.tool_call_id.replace(/_/g, "");
                        if (norm !== parsed.tool_call_id)
                            existingIds.add(norm);
                    }
                }
                catch {
                    /* skip corrupt lines */
                }
            }
            if (existingIds.size > 0) {
                const before = newEntries.length;
                const duplicates = [];
                newEntries = entries.filter((e) => {
                    const id = e.tool_call_id;
                    if (!id)
                        return true;
                    const norm = id.replace(/_/g, "");
                    if (existingIds.has(id) || existingIds.has(norm)) {
                        duplicates.push(id);
                        return false;
                    }
                    return true;
                });
                if (duplicates.length > 0) {
                    logger?.warn?.(`[context-offload] appendOffloadEntries DEDUP: ${duplicates.length}/${before} entries are duplicates, writing ${newEntries.length}. file=${basename(filePath)} duplicateIds=[${duplicates.join(",")}]`);
                }
            }
        }
        catch {
            /* If reading existing file fails, proceed without dedup */
        }
    }
    if (newEntries.length === 0) {
        logger?.info?.(`[context-offload] appendOffloadEntries: all ${entries.length} entries deduped, nothing to write`);
        return;
    }
    const lines = newEntries.map((e) => safeStringifyEntry(e)).join("\n") + "\n";
    await appendFile(filePath, lines, "utf-8");
}
/** Read all entries from the current session's offload JSONL. */
export async function readOffloadEntries(ctx, logger) {
    if (!existsSync(ctx.offloadJsonl))
        return [];
    let content;
    try {
        content = await readFile(ctx.offloadJsonl, "utf-8");
    }
    catch (err) {
        logger?.warn?.(`[context-offload] readOffloadEntries: failed to read ${ctx.offloadJsonl}: ${err.message}`);
        return [];
    }
    const { entries, corruptCount, invalidCount, corruptSample } = parseJsonlSafe(content, { sourceLabel: basename(ctx.offloadJsonl) });
    if (corruptCount > 0 || invalidCount > 0) {
        logger?.warn?.(`[context-offload] readOffloadEntries: skipped ${corruptCount} corrupt + ${invalidCount} invalid lines in ${basename(ctx.offloadJsonl)}. Sample: ${corruptSample?.slice(0, 100)}`);
    }
    return entries;
}
/** Rewrite the current session's offload JSONL with the given entries (sanitized) */
export async function rewriteOffloadEntries(ctx, entries) {
    const content = entries.map((e) => safeStringifyEntry(e)).join("\n") +
        (entries.length > 0 ? "\n" : "");
    await writeFile(ctx.offloadJsonl, content, "utf-8");
}
/** Mark offload entries by tool_call_id with an `offloaded` status. */
export async function markOffloadStatus(ctx, updates) {
    if (!existsSync(ctx.offloadJsonl) || updates.size === 0)
        return;
    const entries = (await readOffloadEntries(ctx));
    let changed = false;
    for (const entry of entries) {
        const status = updates.get(entry.tool_call_id);
        if (status !== undefined && entry.offloaded !== status) {
            entry.offloaded = status;
            changed = true;
        }
    }
    if (changed) {
        await rewriteOffloadEntries(ctx, entries);
    }
}
/** Extract confirmed (offloaded) tool_call_ids from entries. */
export function extractConfirmedIdsFromEntries(entries) {
    const ids = new Set();
    for (const entry of entries) {
        if (entry.offloaded) {
            const id = entry.tool_call_id;
            if (!id)
                continue;
            ids.add(id);
            const normalized = id.replace(/_/g, "");
            if (normalized !== id)
                ids.add(normalized);
        }
    }
    return ids;
}
/** Extract aggressively deleted tool_call_ids from entries. */
export function extractDeletedIdsFromEntries(entries) {
    const ids = new Set();
    for (const entry of entries) {
        if (entry.offloaded === "deleted") {
            const id = entry.tool_call_id;
            if (!id)
                continue;
            ids.add(id);
            const normalized = id.replace(/_/g, "");
            if (normalized !== id)
                ids.add(normalized);
        }
    }
    return ids;
}
// ─── JSONL Operations (all sessions under current agent) ─────────────────────
/** Read offload entries from ALL session files under ctx.dataDir. */
export async function readAllOffloadEntries(ctx, logger) {
    if (!existsSync(ctx.dataDir))
        return [];
    let files;
    try {
        files = await readdir(ctx.dataDir);
    }
    catch (err) {
        logger?.warn?.(`[context-offload] readAllOffloadEntries: failed to readdir ${ctx.dataDir}: ${err.message}`);
        return [];
    }
    const offloadFiles = files
        .filter((f) => f.startsWith("offload-") && f.endsWith(".jsonl"))
        .sort();
    if (offloadFiles.length === 0)
        return [];
    const allEntries = [];
    let totalCorrupt = 0;
    let totalInvalid = 0;
    await Promise.all(offloadFiles.map(async (filename) => {
        try {
            const filePath = join(ctx.dataDir, filename);
            const content = await readFile(filePath, "utf-8");
            const { entries, corruptCount, invalidCount } = parseJsonlSafe(content, {
                sourceLabel: filename,
            });
            totalCorrupt += corruptCount;
            totalInvalid += invalidCount;
            for (const entry of entries) {
                entry._sourceFile = filename;
                allEntries.push(entry);
            }
        }
        catch (err) {
            logger?.warn?.(`[context-offload] readAllOffloadEntries: failed to read ${filename}: ${err.message}`);
        }
    }));
    if (totalCorrupt > 0 || totalInvalid > 0) {
        logger?.warn?.(`[context-offload] readAllOffloadEntries: skipped ${totalCorrupt} corrupt + ${totalInvalid} invalid lines across ${offloadFiles.length} files`);
    }
    return allEntries;
}
/** Write entries back to their respective source files. */
export async function rewriteAllOffloadEntries(ctx, entries) {
    const groups = new Map();
    for (const entry of entries) {
        const sourceFile = entry._sourceFile ?? basename(ctx.offloadJsonl);
        if (!groups.has(sourceFile)) {
            groups.set(sourceFile, []);
        }
        const clean = { ...entry };
        delete clean._sourceFile;
        groups.get(sourceFile).push(clean);
    }
    if (existsSync(ctx.dataDir)) {
        const files = await readdir(ctx.dataDir);
        const offloadFiles = files.filter((f) => f.startsWith("offload-") && f.endsWith(".jsonl"));
        for (const f of offloadFiles) {
            if (!groups.has(f)) {
                groups.set(f, []);
            }
        }
    }
    await Promise.all(Array.from(groups.entries()).map(async ([filename, fileEntries]) => {
        const filePath = join(ctx.dataDir, filename);
        const content = fileEntries.map(safeStringifyEntry).join("\n") +
            (fileEntries.length > 0 ? "\n" : "");
        await writeFile(filePath, content, "utf-8");
    }));
}
/** Update specific entries by tool_call_id across ALL session files (L2 backfill). */
export async function updateOffloadNodeIds(ctx, updates) {
    const entries = await readAllOffloadEntries(ctx);
    let changed = false;
    for (const entry of entries) {
        const newNodeId = updates.get(entry.tool_call_id);
        if (newNodeId !== undefined) {
            entry.node_id = newNodeId;
            changed = true;
        }
    }
    if (changed) {
        await rewriteAllOffloadEntries(ctx, entries);
    }
}
// ─── MD (Tool Result Refs) Operations ────────────────────────────────────────
/** Convert ISO 8601 timestamp to a safe filename (replace special chars) */
export function isoToFilename(iso) {
    return iso.replace(/:/g, "-").replace(/\./g, "-").replace(/\+/g, "p");
}
/** Write tool result content to a ref MD file, return relative path */
export async function writeRefMd(ctx, timestamp, toolName, content) {
    const filename = `${isoToFilename(timestamp)}.md`;
    const filePath = join(ctx.refsDir, filename);
    const safeContent = (content ?? "").replace(UNSAFE_CHAR_RE, "");
    const header = `# Tool Result: ${toolName}\n\n**Timestamp:** ${timestamp}\n\n---\n\n`;
    await writeFile(filePath, header + safeContent, "utf-8");
    return `refs/${filename}`;
}
/** Read a ref MD file by relative path */
export async function readRefMd(ctx, refPath) {
    const filePath = join(ctx.dataDir, refPath);
    if (!existsSync(filePath))
        return null;
    return readFile(filePath, "utf-8");
}
/** Write/overwrite an MMD file */
export async function writeMmd(ctx, filename, content) {
    const filePath = join(ctx.mmdsDir, filename);
    await writeFile(filePath, content, "utf-8");
}
/** Apply incremental line-based replace blocks to an existing MMD file. */
export async function patchMmd(ctx, filename, blocks) {
    const filePath = join(ctx.mmdsDir, filename);
    const original = await readMmd(ctx, filename);
    if (original === null)
        return false;
    const lines = original.split("\n");
    let allValid = true;
    const sorted = [...blocks].sort((a, b) => b.startLine - a.startLine);
    for (const block of sorted) {
        const start = block.startLine;
        const end = block.endLine;
        if (start < 1 || start > lines.length + 1) {
            allValid = false;
            continue;
        }
        const newContentLines = block.content ? block.content.split("\n") : [];
        if (end < start) {
            lines.splice(start - 1, 0, ...newContentLines);
        }
        else {
            const clampedEnd = Math.min(end, lines.length);
            const deleteCount = clampedEnd - start + 1;
            lines.splice(start - 1, deleteCount, ...newContentLines);
        }
    }
    const newContent = lines.join("\n");
    if (newContent !== original) {
        await writeFile(filePath, newContent, "utf-8");
    }
    return allValid;
}
/** Read an MMD file */
export async function readMmd(ctx, filename) {
    const filePath = join(ctx.mmdsDir, filename);
    if (!existsSync(filePath))
        return null;
    return readFile(filePath, "utf-8");
}
/** Delete an MMD file */
export async function deleteMmd(ctx, filename) {
    const filePath = join(ctx.mmdsDir, filename);
    if (!existsSync(filePath))
        return false;
    await unlink(filePath);
    return true;
}
/** List all MMD files in the mmds directory */
export async function listMmds(ctx) {
    if (!existsSync(ctx.mmdsDir))
        return [];
    const files = await readdir(ctx.mmdsDir);
    return files.filter((f) => f.endsWith(".mmd")).sort();
}
// ─── State File Operations ───────────────────────────────────────────────────
/** Read the state.json file */
export async function readStateFile(ctx, defaultValue) {
    if (!existsSync(ctx.stateFile))
        return defaultValue;
    try {
        const content = await readFile(ctx.stateFile, "utf-8");
        return JSON.parse(content);
    }
    catch {
        return defaultValue;
    }
}
/** Write the state.json file */
export async function writeStateFile(ctx, state) {
    await mkdir(dirname(ctx.stateFile), { recursive: true });
    await writeFile(ctx.stateFile, JSON.stringify(state, null, 2), "utf-8");
}
