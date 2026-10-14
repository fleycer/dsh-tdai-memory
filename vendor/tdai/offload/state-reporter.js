import { nowChinaISO } from "./time-utils.js";
// ─── Fixed overhead constants ────────────────────────────────────────────────
/**
 * Fixed L3 "patch overhead" charged per trigger.
 *
 * The context-offload runtime patch injects a small amount of boilerplate
 * (scanner loops, message-mutation wrappers, sentinel fields like
 * `_offloaded` / `_mmdContextMessage`) before the compression routine runs.
 * That boilerplate adds a roughly constant token cost per invocation that
 * is NOT captured by the tiktoken snapshot delta (which only measures
 * compressed vs uncompressed messages).
 *
 * We account for it here with a single fixed constant so cost/benefit
 * tracking on the backend is monotonic. The value is a conservative estimate
 * that can be tuned as the runtime patch evolves.
 */
export const L3_FIXED_PATCH_COST_TOKENS = 80;
/** Inspects `event.messages` to classify patch health for after_tool_call. */
export function classifyPatchEffectiveness(event, stage) {
    // Only after_tool_call depends on the runtime patch for event.messages.
    if (stage !== "after_tool_call")
        return { status: "n/a", messagesLen: 0 };
    if (!event || typeof event !== "object") {
        return { status: "missing_field", messagesLen: 0 };
    }
    const msgs = event.messages;
    if (!Array.isArray(msgs))
        return { status: "missing_field", messagesLen: 0 };
    if (msgs.length === 0)
        return { status: "empty_messages", messagesLen: 0 };
    return { status: "effective", messagesLen: msgs.length };
}
const _counters = {
    totalTokensSaved: 0,
    totalNetTokensSaved: 0,
    totalToolCalls: 0,
    totalL3Triggers: 0,
    totalL3TriggersByStage: { after_tool_call: 0, llm_input: 0, assemble: 0 },
    totalAggressiveDeleted: 0,
    totalMildReplaced: 0,
    totalEmergencyTriggered: 0,
    totalEmergencyDeleted: 0,
    startedAt: nowChinaISO(),
};
/**
 * Record a tool-call observation. Called from the `after_tool_call` hook
 * entry regardless of whether L3 compression fires — it counts *all* tool
 * invocations the plugin has seen.
 */
export function recordToolCall() {
    _counters.totalToolCalls += 1;
}
/** Returns a shallow copy of the current cumulative counters. */
export function getCumulativeCounters() {
    return {
        ..._counters,
        totalL3TriggersByStage: { ..._counters.totalL3TriggersByStage },
    };
}
/** Testing hook — wipes counters so unit tests stay isolated. */
export function _resetCumulativeCountersForTests() {
    _counters.totalTokensSaved = 0;
    _counters.totalNetTokensSaved = 0;
    _counters.totalToolCalls = 0;
    _counters.totalL3Triggers = 0;
    _counters.totalL3TriggersByStage = { after_tool_call: 0, llm_input: 0, assemble: 0 };
    _counters.totalAggressiveDeleted = 0;
    _counters.totalMildReplaced = 0;
    _counters.totalEmergencyTriggered = 0;
    _counters.totalEmergencyDeleted = 0;
    _counters.startedAt = nowChinaISO();
}
// ─── Report payload types ────────────────────────────────────────────────────
/** Stable report type tag — one line per reporting category. */
export const REPORT_TYPE_L3 = "offload.l3.trigger";
export function buildL3TriggerReport(input) {
    const { stage, triggerReason, stateManager, event, contextWindow, mildThreshold, aggressiveThreshold, tokensBefore, tokensAfter, messagesBefore, messagesAfter, durationMs, aboveMild, aboveAggressive, mildReplacedCount = 0, aggressiveDeletedCount = 0, emergencyTriggered = false, emergencyDeletedCount = 0, } = input;
    const tokensSaved = Math.max(0, tokensBefore - tokensAfter);
    const netTokensSaved = tokensSaved - L3_FIXED_PATCH_COST_TOKENS;
    const patch = classifyPatchEffectiveness(event, stage);
    // ── Cumulative update (side effect — counters persist across triggers) ──
    _counters.totalTokensSaved += tokensSaved;
    _counters.totalNetTokensSaved += netTokensSaved;
    _counters.totalL3Triggers += 1;
    _counters.totalL3TriggersByStage[stage] =
        (_counters.totalL3TriggersByStage[stage] ?? 0) + 1;
    _counters.totalAggressiveDeleted += aggressiveDeletedCount;
    _counters.totalMildReplaced += mildReplacedCount;
    if (emergencyTriggered)
        _counters.totalEmergencyTriggered += 1;
    _counters.totalEmergencyDeleted += emergencyDeletedCount;
    // Safe read: stateManager is private-field-heavy, use only public getters.
    let activeMmdFile = null;
    try {
        activeMmdFile = stateManager.getActiveMmdFile?.() ?? null;
    }
    catch { /* ignore */ }
    let sessionKey = null;
    try {
        sessionKey = stateManager.getLastSessionKey?.() ?? null;
    }
    catch { /* ignore */ }
    let pendingCount = 0;
    try {
        pendingCount = stateManager.getPendingCount?.() ?? 0;
    }
    catch { /* ignore */ }
    return {
        reportType: REPORT_TYPE_L3,
        reportedAt: nowChinaISO(),
        sessionKey,
        stage,
        triggerReason,
        pluginState: {
            activeMmdFile,
            l15Settled: stateManager.l15Settled === true,
            pendingCount,
            confirmedOffloadCount: stateManager.confirmedOffloadIds?.size ?? 0,
            deletedOffloadCount: stateManager.deletedOffloadIds?.size ?? 0,
        },
        recent: {
            tokensBefore,
            tokensAfter,
            tokensSaved,
            netTokensSaved,
            messagesBefore,
            messagesAfter,
            messagesRemoved: Math.max(0, messagesBefore - messagesAfter),
            durationMs,
        },
        thresholds: {
            contextWindow,
            mildThreshold,
            aggressiveThreshold,
            fixedPatchCostTokens: L3_FIXED_PATCH_COST_TOKENS,
            utilisationBeforePct: contextWindow > 0 ? +((tokensBefore / contextWindow) * 100).toFixed(2) : 0,
            utilisationAfterPct: contextWindow > 0 ? +((tokensAfter / contextWindow) * 100).toFixed(2) : 0,
        },
        compression: {
            aboveMild,
            aboveAggressive,
            mildReplacedCount,
            aggressiveDeletedCount,
            emergencyTriggered,
            emergencyDeletedCount,
        },
        cumulative: getCumulativeCounters(),
        patch,
    };
}
/**
 * Fire-and-forget upload of an L3 report to the backend store endpoint.
 * Must never throw — rejection is logged at warn level only.
 */
export function reportL3Trigger(backendClient, report, logger) {
    if (!backendClient)
        return;
    try {
        backendClient
            .storeState(report)
            .then(() => {
            logger.debug?.(`[context-offload] state-report OK: stage=${report.stage} reason=${report.triggerReason} ` +
                `recentSaved=${report.recent.tokensSaved} cumSaved=${report.cumulative.totalTokensSaved} ` +
                `toolCalls=${report.cumulative.totalToolCalls} patch=${report.patch.status}`);
        })
            .catch((err) => {
            logger.warn(`[context-offload] state-report FAILED: stage=${report.stage} — ${err}`);
        });
    }
    catch (err) {
        logger.warn(`[context-offload] state-report schedule FAILED: ${err}`);
    }
}
