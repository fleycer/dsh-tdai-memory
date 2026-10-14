/**
 * OffloadStateManager: In-memory state + persistent state.json coordination.
 * Manages pendingToolPairs buffer, active MMD tracking, and processed IDs.
 *
 * Each instance is bound to a single session via StorageContext.
 * No global mutable state — all I/O goes through the frozen ctx.
 */
import { readStateFile, writeStateFile, ensureDirs, createStorageContext, parseSessionKey, readOffloadEntries, extractConfirmedIdsFromEntries, extractDeletedIdsFromEntries, registerSession, listMmds, } from "./storage.js";
const DEFAULT_STATE = {
    activeMmdFile: null,
    activeMmdId: null,
    mmdCounter: 0,
    lastSessionKey: null,
    lastOffloadedToolCallId: null,
    lastL2TriggerTime: null,
    estimatedSystemOverhead: null,
};
export class OffloadStateManager {
    /** Immutable storage path context — set by init() or switchSession() */
    _ctx = null;
    /** Buffered tool pairs waiting to be processed by L1 */
    pendingToolPairs = [];
    /** Set of already-processed tool call IDs to prevent duplicates */
    processedToolCallIds = new Set();
    /** Persistent state (synced with state.json) */
    state = { ...DEFAULT_STATE };
    /** Whether state has been loaded from disk */
    loaded = false;
    /** Mutex for L1 pipeline to prevent concurrent runs */
    l1Lock = Promise.resolve();
    // ─── Runtime-only flags (not persisted) ──────────────────────────────────
    mmdInjectionReady = false;
    injectedMmdVersions = {};
    /** Whether L1.5 has successfully executed for the current session/prompt.
     *  L2 must wait for this to be true before triggering. */
    l15Settled = false;
    /** Unique instance ID for debugging (each new OffloadStateManager gets a new id). */
    _instanceId = ++OffloadStateManager._instanceCounter;
    static _instanceCounter = 0;
    /** Set of toolCallIds confirmed offloaded in previous rounds. */
    confirmedOffloadIds = new Set();
    /** Set of toolCallIds that were aggressively DELETED. */
    deletedOffloadIds = new Set();
    /** Reconciliation retry counter */
    _reconcileRetries = new Map();
    /** Cached offload entries map */
    _cachedOffloadMap = null;
    /** Monotonic version counter */
    _offloadMapVersion = 0;
    /** Last MMD injection token count */
    lastMmdInjectedTokens = 0;
    /** Cached system prompt from last llm_input */
    cachedSystemPrompt = null;
    /** Cached user prompt from last llm_input */
    cachedUserPrompt = null;
    /** Cached latest turn messages for L2 */
    cachedLatestTurnMessages = null;
    /** Cached recent history for L2 background triggers */
    cachedRecentHistory = null;
    /** Cached system prompt token count */
    cachedSystemPromptTokens = null;
    /** Cached user prompt token count */
    cachedUserPromptTokens = null;
    /** Force emergency compression on next L3 entry */
    _forceEmergencyNext = false;
    /** Last known total token count from precise tiktoken calculation (P1 quick-skip) */
    lastKnownTotalTokens = 0;
    /** Message count at last precise tiktoken calculation (P1 quick-skip) */
    lastKnownMessageCount = 0;
    /** Consecutive QUICK-SKIP count; reset to 0 on each precise calculation */
    consecutiveQuickSkips = 0;
    /** Boundary info from last aggressive deletion — enables O(1) head-delete on replay.
     *  originalIndex: position of the first kept message in the original input array.
     *  fingerprint: hash of that message for verification.
     *  keptMsgCount: number of messages kept after aggressive.
     *  remainingTokens: total tokens (incl sys) after aggressive compression. */
    _lastAggressiveBoundary = null;
    /** Cached tool params from before_tool_call hook */
    _pendingParams = new Map();
    /** Last L1.5 prompt hash — per-session to avoid cross-session re-trigger skip */
    lastL15PromptHash = null;
    // ─── Fault tolerance fields ─────────────────────────────────────────────
    /** Per-chunk consecutive L1 failure count. Key = first toolCallId of the chunk. */
    _l1ChunkFailCounts = new Map();
    /** Consecutive L1.5 all-null response count. Reset to 0 on successful judgment. */
    l15ConsecutiveNullCount = 0;
    // ─── L1.5 Boundary (runtime-only, per-session) ────────────────────────
    /** Global entry counter, incremented after each appendOffloadEntries. */
    entryCounter = 0;
    /** Settled boundaries (ascending by startIndex). */
    l15Boundaries = [];
    // ─── StorageContext accessor ─────────────────────────────────────────────
    /** Get the current session's StorageContext. Throws if not initialized. */
    get ctx() {
        if (!this._ctx) {
            throw new Error("OffloadStateManager: ctx not initialized, call init() or switchSession() first");
        }
        return this._ctx;
    }
    /** Get agent name from ctx (null if not initialized) */
    get agentName() {
        return this._ctx?.agentName ?? null;
    }
    /** Get session id from ctx (null if not initialized) */
    get sessionId() {
        return this._ctx?.sessionId ?? null;
    }
    // ─── Initialization ──────────────────────────────────────────────────────
    /**
     * Initialize the manager for a specific agent + session.
     * Creates StorageContext, ensures directories, and loads persistent state.
     */
    async init(dataRoot, agentName, sessionId) {
        this._ctx = createStorageContext(dataRoot, agentName, sessionId);
        await ensureDirs(this._ctx);
        const loadedState = await readStateFile(this._ctx, DEFAULT_STATE);
        this.state = { ...DEFAULT_STATE, ...loadedState };
        this.loaded = true;
    }
    async save() {
        await writeStateFile(this.ctx, this.state);
    }
    // ─── Tool Pair Buffer ────────────────────────────────────────────────────
    addToolPair(pair) {
        if (this.processedToolCallIds.has(pair.toolCallId))
            return;
        pair._sessionId = this._ctx?.sessionId ?? null;
        this.pendingToolPairs.push(pair);
    }
    getPendingCount() {
        return this.pendingToolPairs.length;
    }
    hasPending() {
        return this.pendingToolPairs.length > 0;
    }
    takePending(max) {
        const taken = this.pendingToolPairs.splice(0, max);
        for (const pair of taken) {
            this.processedToolCallIds.add(pair.toolCallId);
        }
        return taken;
    }
    isProcessed(toolCallId) {
        return this.processedToolCallIds.has(toolCallId);
    }
    // ─── Active MMD ──────────────────────────────────────────────────────────
    getActiveMmdFile() {
        return this.state.activeMmdFile;
    }
    getActiveMmdId() {
        return this.state.activeMmdId;
    }
    setActiveMmd(file, id) {
        this.state.activeMmdFile = file;
        this.state.activeMmdId = id;
    }
    async nextMmdNumber() {
        try {
            const existingFiles = await listMmds(this.ctx);
            let maxOnDisk = 0;
            for (const f of existingFiles) {
                const m = f.match(/^(\d+)-/);
                if (m) {
                    const num = parseInt(m[1], 10);
                    if (num > maxOnDisk)
                        maxOnDisk = num;
                }
            }
            if (maxOnDisk >= this.state.mmdCounter) {
                this.state.mmdCounter = maxOnDisk;
            }
        }
        catch {
            /* If listing fails, fall through with in-memory counter */
        }
        this.state.mmdCounter += 1;
        return this.state.mmdCounter;
    }
    getMmdCounter() {
        return this.state.mmdCounter;
    }
    // ─── Session / Multi-Agent ──────────────────────────────────────────────
    getLastSessionKey() {
        return this.state.lastSessionKey;
    }
    setLastSessionKey(key) {
        this.state.lastSessionKey = key;
    }
    /**
     * Switch to a new session. Rebuilds StorageContext and reloads state.
     * @param sessionKey - Full session key (e.g. "agent:main:session-123")
     * @param dataRoot - Storage root directory
     * @param realSessionId - Optional override for the parsed sessionId
     */
    async switchSession(sessionKey, dataRoot, realSessionId) {
        const parsed = parseSessionKey(sessionKey);
        if (!parsed)
            return false;
        const prevAgent = this._ctx?.agentName;
        const effectiveSessionId = realSessionId || parsed.sessionId;
        // Create new immutable StorageContext
        this._ctx = createStorageContext(dataRoot, parsed.agentName, effectiveSessionId);
        await ensureDirs(this._ctx);
        if (realSessionId) {
            await registerSession(this._ctx, sessionKey, realSessionId).catch(() => { });
        }
        if (prevAgent !== parsed.agentName) {
            const loadedState = await readStateFile(this._ctx, DEFAULT_STATE);
            this.state = { ...DEFAULT_STATE, ...loadedState };
        }
        try {
            const entries = await readOffloadEntries(this._ctx);
            this.confirmedOffloadIds = extractConfirmedIdsFromEntries(entries);
            this.deletedOffloadIds = extractDeletedIdsFromEntries(entries);
            this.processedToolCallIds = new Set();
            for (const e of entries) {
                if (e.tool_call_id) {
                    this.processedToolCallIds.add(e.tool_call_id);
                    const norm = e.tool_call_id.replace(/_/g, "");
                    if (norm !== e.tool_call_id) {
                        this.processedToolCallIds.add(norm);
                    }
                }
            }
            this.pendingToolPairs = [];
            this.injectedMmdVersions = {};
            this.mmdInjectionReady = false;
            this.l15Settled = false;
            this.lastMmdInjectedTokens = 0;
            this.cachedUserPrompt = null;
            this.lastL15PromptHash = null;
            // Restore entryCounter from persisted entries; reset boundaries
            this.entryCounter = entries.length;
            this.l15Boundaries = [];
            // Reset P1 quick-skip state
            this.lastKnownTotalTokens = 0;
            this.lastKnownMessageCount = 0;
            this.consecutiveQuickSkips = 0;
            this._forceEmergencyNext = false;
            this._lastAggressiveBoundary = null;
            // Keep cachedSystemPrompt/Tokens across switchSession within the same agent
            if (prevAgent !== parsed.agentName) {
                this.cachedSystemPrompt = null;
                this.cachedSystemPromptTokens = null;
                this.cachedUserPromptTokens = null;
            }
            this._cachedOffloadMap = null;
            this._offloadMapVersion++;
            this.cachedLatestTurnMessages = null;
            this.cachedRecentHistory = null;
            this._reconcileRetries = new Map();
            this._pendingParams = new Map();
            this._l1ChunkFailCounts = new Map();
            this.l15ConsecutiveNullCount = 0;
        }
        catch {
            this.confirmedOffloadIds = new Set();
            this.deletedOffloadIds = new Set();
            this.processedToolCallIds = new Set();
            this.pendingToolPairs = [];
        }
        this.state.lastSessionKey = sessionKey;
        await this.save();
        return true;
    }
    getLastOffloadedToolCallId() {
        return this.state.lastOffloadedToolCallId;
    }
    setLastOffloadedToolCallId(toolCallId) {
        this.state.lastOffloadedToolCallId = toolCallId;
    }
    // ─── L1 Mutex ────────────────────────────────────────────────────────────
    acquireL1Lock() {
        let release;
        const prev = this.l1Lock;
        this.l1Lock = new Promise((resolve) => {
            release = () => resolve();
        });
        return prev.then(() => release);
    }
    // ─── L2 Trigger Tracking ───────────────────────────────────────────────
    getLastL2TriggerTime() {
        return this.state.lastL2TriggerTime;
    }
    setLastL2TriggerTime(time) {
        this.state.lastL2TriggerTime = time;
    }
    // ─── Full State Access ───────────────────────────────────────────────────
    getState() {
        return { ...this.state };
    }
    isLoaded() {
        return this.loaded;
    }
    // ─── MMD Injection Control ──────────────────────────────────────────────
    setMmdInjectionReady(ready) {
        this.mmdInjectionReady = ready;
    }
    isMmdInjectionReady() {
        return this.mmdInjectionReady;
    }
    // ─── Injected MMD Version Tracking ──────────────────────────────────────
    setInjectedMmdVersion(filename, fingerprint) {
        this.injectedMmdVersions[filename] = fingerprint;
    }
    getInjectedMmdVersion(filename) {
        return this.injectedMmdVersions[filename] ?? null;
    }
    removeInjectedMmdVersion(filename) {
        delete this.injectedMmdVersions[filename];
    }
    getAllInjectedMmdVersions() {
        return { ...this.injectedMmdVersions };
    }
    clearInjectedMmdVersions() {
        this.injectedMmdVersions = {};
    }
    // ─── Token Tracking ─────────────────────────────────────────────────────
    setEstimatedSystemOverhead(tokens) {
        this.state.estimatedSystemOverhead = tokens;
    }
    getEstimatedSystemOverhead() {
        return this.state.estimatedSystemOverhead;
    }
    // ─── Offload Map Cache ──────────────────────────────────────────────────
    invalidateOffloadMapCache() {
        this._cachedOffloadMap = null;
        this._offloadMapVersion++;
    }
    getCachedOffloadMap() {
        return this._cachedOffloadMap;
    }
    setCachedOffloadMap(map) {
        this._cachedOffloadMap = map;
    }
    getOffloadMapVersion() {
        return this._offloadMapVersion;
    }
    // ─── Before Tool Call Params Cache ───────────────────────────────────────
    cacheToolParams(toolCallId, params) {
        this._pendingParams.set(toolCallId, params);
        if (this._pendingParams.size > 100) {
            const oldest = this._pendingParams.keys().next().value;
            if (oldest !== undefined)
                this._pendingParams.delete(oldest);
        }
    }
    consumeToolParams(toolCallId) {
        const params = this._pendingParams.get(toolCallId);
        if (params !== undefined) {
            this._pendingParams.delete(toolCallId);
        }
        return params ?? null;
    }
    // ─── L1.5 Boundary Helpers ─────────────────────────────────────────────
    /**
     * Append a new boundary (must be in ascending startIndex order).
     * If the last boundary has the same startIndex, overwrite it instead of
     * appending — this happens during fast task switching when no tool calls
     * (and thus no L1 entries) are produced between consecutive L1.5 judgments.
     */
    pushBoundary(boundary) {
        const last = this.l15Boundaries.at(-1);
        if (last && last.startIndex === boundary.startIndex) {
            this.l15Boundaries[this.l15Boundaries.length - 1] = boundary;
        }
        else {
            this.l15Boundaries.push(boundary);
        }
    }
    /**
     * Find the boundary that covers the given entry index.
     * Returns the last boundary whose startIndex <= entryIndex,
     * or null if no boundary covers it (entry predates all boundaries).
     */
    resolveEntryBoundary(entryIndex) {
        let matched = null;
        for (const b of this.l15Boundaries) {
            if (b.startIndex <= entryIndex) {
                matched = b;
            }
            else {
                break; // boundaries are ascending by startIndex
            }
        }
        return matched;
    }
}
