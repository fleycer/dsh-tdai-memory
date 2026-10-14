/**
 * L1 Response Parser — extracts summarization results from LLM output.
 */
import { extractJson } from "./json-utils.js";
/**
 * Parse L1 LLM response into OffloadEntry array.
 * Tolerant of markdown wrapping, missing fields, etc.
 */
export function parseL1Response(raw) {
    const parsed = extractJson(raw);
    if (!parsed || !Array.isArray(parsed))
        return [];
    const entries = [];
    for (const item of parsed) {
        if (!item || typeof item !== "object")
            continue;
        const toolCallId = item.tool_call_id ?? "";
        if (!toolCallId)
            continue; // tool_call_id is required
        entries.push({
            tool_call_id: toolCallId,
            tool_call: item.tool_call ?? "",
            summary: item.summary ?? "",
            timestamp: item.timestamp ?? "",
            score: typeof item.score === "number" ? item.score : 5,
            node_id: null,
        });
    }
    return entries;
}
