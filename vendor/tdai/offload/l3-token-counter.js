/**
 * L3 token counting: prefer tiktoken (exact for OpenAI-style BPE), with heuristic fallback.
 */
import { getEncoding } from "js-tiktoken";
import { PLUGIN_DEFAULTS } from "./types.js";
import { estimateL3MixedTokensHeuristic } from "./l3-token-helpers.js";
export function createL3TokenCounter(pluginConfig, logger) {
    const mode = pluginConfig?.l3TokenCountMode ?? PLUGIN_DEFAULTS.l3TokenCountMode;
    if (mode === "heuristic") {
        return (text) => estimateL3MixedTokensHeuristic(text);
    }
    const encodingName = (pluginConfig?.l3TiktokenEncoding ??
        PLUGIN_DEFAULTS.l3TiktokenEncoding);
    let enc = null;
    return (text) => {
        try {
            if (!enc) {
                enc = getEncoding(encodingName);
                logger?.debug?.(`[context-offload] L3 token counter: tiktoken encoding=${encodingName}`);
            }
            return enc.encode(text).length;
        }
        catch (err) {
            logger?.warn?.(`[context-offload] tiktoken encode failed (${String(err)}), falling back to heuristic`);
            return estimateL3MixedTokensHeuristic(text);
        }
    };
}
