/**
 * Core type definitions for the context offload plugin.
 * Ported from context-offload-plugin with updated runtime defaults.
 */
// ============================
// Plugin defaults
// ============================
/** Defaults for all configurable values (sourced from runtime .js) */
export const PLUGIN_DEFAULTS = {
    temperature: 0.2,
    forceTriggerThreshold: 4,
    defaultContextWindow: 200_000,
    maxPairsPerBatch: 20,
    l2NullThreshold: 4,
    l2TimeoutSeconds: 300,
    /** If L2 leaves entries in node_id="wait", retry after this many seconds */
    l2WaitRetrySeconds: 120,
    /** When true, time-based L2 only fires if some node_id=null row is newer than last L2 */
    l2TimeTriggerRequiresNewOffload: true,
    mildOffloadRatio: 0.5,
    mildOffloadScanRatio: 0.7,
    mildScoreTopRatio: 0.4,
    mildCurrentTaskRatio: 0.8,
    aggressiveCompressRatio: 0.85,
    aggressiveDeleteRatio: 0.4,
    /** Emergency trigger: when tokens >= contextWindow * 0.95, fire emergency */
    emergencyCompressRatio: 0.95,
    /** Emergency target: delete until tokens <= contextWindow * 0.6 */
    emergencyTargetRatio: 0.6,
    mmdMaxTokenRatio: 0.2,
    l3TokenCountMode: "tiktoken",
    l3TiktokenEncoding: "cl100k_base",
    defaultSystemOverheadRatio: 0.12,
};
