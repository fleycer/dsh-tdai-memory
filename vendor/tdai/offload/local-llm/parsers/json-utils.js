/**
 * Tolerant JSON parsing utilities for LLM responses.
 *
 * LLMs often wrap JSON in markdown code fences, include trailing commas,
 * or prepend explanatory text. These utilities handle common deviations.
 */
/**
 * Extract JSON from LLM output — handles code fences, prefix text, etc.
 * Returns the parsed object/array, or null if parsing fails.
 */
export function extractJson(raw) {
    if (!raw || typeof raw !== "string")
        return null;
    const trimmed = raw.trim();
    // Strategy 1: Direct parse (ideal case)
    const direct = tryParse(trimmed);
    if (direct !== null)
        return direct;
    // Strategy 2: Extract from markdown code fence (```json ... ``` or ``` ... ```)
    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
        const inner = fenceMatch[1].trim();
        const parsed = tryParse(inner);
        if (parsed !== null)
            return parsed;
    }
    // Strategy 3: Find first { to last } (or first [ to last ])
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        const candidate = trimmed.slice(firstBrace, lastBrace + 1);
        const parsed = tryParse(candidate);
        if (parsed !== null)
            return parsed;
        // Try with trailing comma fix
        const fixed = fixTrailingCommas(candidate);
        const parsedFixed = tryParse(fixed);
        if (parsedFixed !== null)
            return parsedFixed;
    }
    const firstBracket = trimmed.indexOf("[");
    const lastBracket = trimmed.lastIndexOf("]");
    if (firstBracket >= 0 && lastBracket > firstBracket) {
        const candidate = trimmed.slice(firstBracket, lastBracket + 1);
        const parsed = tryParse(candidate);
        if (parsed !== null)
            return parsed;
    }
    // Strategy 4: Try fixing the entire string
    const fixed = fixTrailingCommas(trimmed);
    const parsedFixed = tryParse(fixed);
    if (parsedFixed !== null)
        return parsedFixed;
    return null;
}
/**
 * Extract mermaid content from a code fence.
 * Returns the raw mermaid text (without fence markers).
 */
export function extractMermaidFromFence(text) {
    if (!text)
        return null;
    const match = text.match(/```mermaid\s*\n?([\s\S]*?)```/);
    if (match)
        return match[1].trim();
    // Fallback: if no fence, return as-is (might already be raw mermaid)
    if (text.includes("flowchart") || text.includes("graph"))
        return text.trim();
    return null;
}
// ─── Internal Helpers ────────────────────────────────────────────────────────
function tryParse(s) {
    try {
        return JSON.parse(s);
    }
    catch {
        return null;
    }
}
function fixTrailingCommas(s) {
    // Remove trailing commas before } or ]
    return s.replace(/,\s*([}\]])/g, "$1");
}
