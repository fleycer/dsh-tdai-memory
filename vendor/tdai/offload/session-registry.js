/**
 * SessionRegistry: Per-session OffloadStateManager routing.
 *
 * Maps sessionKey → { manager, lastAccessMs } with LRU eviction.
 * Eliminates the global singleton stateManager — each session gets
 * its own isolated OffloadStateManager + StorageContext.
 */
import { OffloadStateManager } from "./state-manager.js";
import { parseSessionKey } from "./storage.js";
/** Matches internal memory-pipeline sessions (e.g. memory-{taskId}-session-{ts}). */
const INTERNAL_SESSION_RE = /memory-.*-session-\d+/;
/** Returns true if the sessionKey belongs to an internal memory-pipeline session. */
function isInternalMemorySession(sessionKey) {
    return INTERNAL_SESSION_RE.test(sessionKey);
}
/** Maximum number of cached sessions before LRU eviction kicks in. */
const MAX_CACHED_SESSIONS = 20;
/** Routes sessionKey → per-session OffloadStateManager with LRU eviction. */
export class SessionRegistry {
    _sessions = new Map();
    _dataRoot;
    _registryId = ++SessionRegistry._registryCounter;
    static _registryCounter = 0;
    constructor(dataRoot) {
        this._dataRoot = dataRoot;
    }
    /** Get the configured data root. */
    get dataRoot() {
        return this._dataRoot;
    }
    /**
     * Get or create a per-session manager.
     * First access will create a new OffloadStateManager, call init() + switchSession()
     * to fully initialize storage paths and rebuild in-memory state from offload files.
     */
    async resolve(sessionKey, realSessionId) {
        let entry = this._sessions.get(sessionKey);
        if (entry) {
            entry.lastAccessMs = Date.now();
            return entry;
        }
        // New session — create manager and fully initialize
        const mgr = new OffloadStateManager();
        const parsed = parseSessionKey(sessionKey);
        if (parsed) {
            const effectiveSessionId = realSessionId || parsed.sessionId;
            await mgr.init(this._dataRoot, parsed.agentName, effectiveSessionId);
            // switchSession rebuilds confirmedOffloadIds, deletedOffloadIds,
            // processedToolCallIds from offload JSONL, registers sessionKey mapping,
            // and resets session-level runtime state.
            await mgr.switchSession(sessionKey, this._dataRoot, realSessionId);
        }
        else {
            // sessionKey doesn't match "agent:<name>:<id>" format.
            // Use a sanitized sessionKey as both agentName and sessionId
            // so ctx is always initialized (avoids "ctx not initialized" errors).
            const fallbackName = sessionKey.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 64) || "unknown";
            const fallbackSessionId = realSessionId || `fallback-${Date.now()}`;
            await mgr.init(this._dataRoot, fallbackName, fallbackSessionId);
        }
        entry = { sessionKey, manager: mgr, lastAccessMs: Date.now() };
        this._sessions.set(sessionKey, entry);
        // LRU eviction
        if (this._sessions.size > MAX_CACHED_SESSIONS) {
            this._evictOldest();
        }
        return entry;
    }
    /**
     * Resolve a session only if it is NOT an internal memory-pipeline session.
     *
     * Returns null for memory sessions (e.g. `memory-{taskId}-session-{ts}`),
     * preventing unnecessary OffloadStateManager creation, disk I/O, and LRU
     * cache slot pollution for sessions that should never run offload.
     *
     * Callers that need unconditional resolve (e.g. tests) can still use resolve().
     */
    async resolveIfAllowed(sessionKey, realSessionId) {
        if (isInternalMemorySession(sessionKey))
            return null;
        return this.resolve(sessionKey, realSessionId);
    }
    /** Look up an existing session (does not create). Updates lastAccessMs. */
    get(sessionKey) {
        const entry = this._sessions.get(sessionKey);
        if (entry)
            entry.lastAccessMs = Date.now();
        return entry;
    }
    /** Number of cached sessions. */
    get size() {
        return this._sessions.size;
    }
    /** Iterate over all session keys. */
    keys() {
        return this._sessions.keys();
    }
    /** Iterate over all session entries. */
    values() {
        return this._sessions.values();
    }
    /** Evict the least-recently-accessed session. */
    _evictOldest() {
        let oldestKey = null;
        let oldestMs = Infinity;
        for (const [key, entry] of this._sessions) {
            if (entry.lastAccessMs < oldestMs) {
                oldestMs = entry.lastAccessMs;
                oldestKey = key;
            }
        }
        if (oldestKey)
            this._sessions.delete(oldestKey);
    }
}
