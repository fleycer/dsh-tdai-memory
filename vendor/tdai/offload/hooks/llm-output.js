const DEFAULT_FORCE_TRIGGER_THRESHOLD = 4;
/**
 * Check if L1 should be force-triggered (called from after_tool_call when
 * pending count exceeds threshold).
 */
export function shouldForceL1(stateManager, pluginConfig) {
    const threshold = pluginConfig?.forceTriggerThreshold ?? DEFAULT_FORCE_TRIGGER_THRESHOLD;
    return stateManager.getPendingCount() >= threshold;
}
