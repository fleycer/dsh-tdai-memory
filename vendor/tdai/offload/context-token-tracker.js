/**
 * Context Token Tracker
 *
 * Prefers API-reported input_tokens when available, supplements with tiktoken
 * for message deltas and full fallback. Encoding is configurable via configure().
 */
import { getEncoding } from "js-tiktoken";
let ENCODING_NAME = "o200k_base";
let encoder = null;
/**
 * Configure the tiktoken encoding used for token counting.
 * Call once at startup before any snapshot calls.
 * If the encoding changes, the cached encoder is invalidated.
 */
export function configureTokenTracker(encodingName) {
    if (encodingName && encodingName !== ENCODING_NAME) {
        ENCODING_NAME = encodingName;
        encoder = null; // invalidate cached encoder
    }
}
function getEncoder() {
    if (!encoder) {
        encoder = getEncoding(ENCODING_NAME);
    }
    return encoder;
}
/** Count tokens for a text string using tiktoken BPE encoding. */
export function tiktokenCount(text) {
    if (!text || text.length === 0)
        return 0;
    try {
        return getEncoder().encode(text).length;
    }
    catch {
        return Math.ceil(text.length / 4);
    }
}
function extractLastUserText(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        const wrapped = m.type === "message" ? m.message : m;
        if (!wrapped || wrapped.role !== "user")
            continue;
        const c = wrapped.content;
        if (typeof c === "string")
            return c;
        if (Array.isArray(c)) {
            const parts = [];
            for (const block of c) {
                if (block.type === "text" && typeof block.text === "string")
                    parts.push(block.text);
            }
            return parts.length > 0 ? parts.join("\n") : null;
        }
        return null;
    }
    return null;
}
// Internal metadata keys that should NOT be counted as tokens.
// These are plugin-internal markers or framework-internal fields that the LLM never sees.
// Note: "details" is stripped by OpenClaw's normalizeMessagesForLlmBoundary before sending to LLM.
const INTERNAL_KEYS = new Set([
    "_offloaded",
    "_mmdContextMessage",
    "_mmdInjection",
    "_contextOffloadProcessed",
    "details",
]);
/** JSON replacer that strips internal metadata keys from serialization. */
export function jsonReplacer(key, value) {
    if (INTERNAL_KEYS.has(key))
        return undefined;
    return value;
}
// ─── Per-message token cache (WeakMap) ─────────────────────────────────────
// Cache token counts per message object. Entries are automatically GC'd when
// the message object is no longer referenced. Cache invalidation is triggered
// by _offloaded flag changes or explicit invalidateTokenCache() calls.
const msgTokenCache = new WeakMap();
function cachedMessageTokens(msg) {
    const offloaded = !!msg._offloaded;
    const cached = msgTokenCache.get(msg);
    if (cached && cached.offloaded === offloaded)
        return cached.tokens;
    const str = JSON.stringify(msg, jsonReplacer);
    const tokens = tiktokenCount(str);
    msgTokenCache.set(msg, { tokens, offloaded });
    return tokens;
}
/**
 * Invalidate the token cache for a message whose content was mutated in-place
 * (e.g. by replaceWithSummary). Must be called after any content mutation.
 */
export function invalidateTokenCache(msg) {
    msgTokenCache.delete(msg);
}
/**
 * Tiktoken-only snapshot (messages JSON + optional user prompt dedupe).
 * Does not write logs.
 * Internal metadata keys (_offloaded, _mmdContextMessage, etc.) are stripped
 * before serialization so they don't inflate the token count.
 *
 * Uses per-message WeakMap cache: unchanged messages (same object reference
 * and same _offloaded flag) reuse previously computed token counts.
 */
export function buildTiktokenContextSnapshot(stage, messages, systemPromptText, userPromptText, precomputed) {
    const systemTokens = precomputed?.systemTokens != null
        ? precomputed.systemTokens
        : tiktokenCount(systemPromptText ?? "");
    // Per-message cached token counting (replaces full JSON.stringify + tiktoken)
    let messagesTokens = 0;
    for (const msg of messages) {
        messagesTokens += cachedMessageTokens(msg);
    }
    // Compensate for JSON array structure overhead ([, commas, ])
    messagesTokens += Math.ceil(messages.length * 0.5);
    let userPromptTokens = 0;
    if (precomputed?.userPromptTokens != null) {
        userPromptTokens = precomputed.userPromptTokens;
    }
    else if (userPromptText && userPromptText.trim()) {
        const lastUserText = extractLastUserText(messages);
        const alreadyInMessages = lastUserText !== null && lastUserText.trim() === userPromptText.trim();
        if (!alreadyInMessages) {
            userPromptTokens = tiktokenCount(userPromptText);
        }
    }
    const totalTokens = systemTokens + messagesTokens + userPromptTokens;
    return {
        timestamp: new Date().toISOString(),
        stage,
        encoding: ENCODING_NAME,
        totalTokens,
        systemTokens,
        messagesTokens,
        userPromptTokens,
        messageCount: messages.length,
    };
}
