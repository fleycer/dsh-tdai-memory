/**
 * L2 Response Parser — extracts MMD generation results from LLM output.
 */
import { extractJson, extractMermaidFromFence } from "./json-utils.js";
/**
 * Parse L2 LLM response into structured L2 result.
 * Returns null if parsing fails completely.
 */
export function parseL2Response(raw) {
    const parsed = extractJson(raw);
    if (!parsed || typeof parsed !== "object") {
        // Fallback: try extracting ```mermaid ... ``` code block (same as Go backend)
        const mmd = extractMermaidFromFence(raw);
        if (mmd) {
            return { fileAction: "write", mmdContent: mmd, nodeMapping: {} };
        }
        return null;
    }
    const fileAction = parsed.file_action === "replace" ? "replace" : "write";
    // Extract mmd_content (may be wrapped in code fence)
    let mmdContent;
    if (fileAction === "write") {
        if (parsed.mmd_content) {
            mmdContent = extractMermaidFromFence(parsed.mmd_content) ?? parsed.mmd_content;
        }
        else {
            // mmd_content missing in write mode — try extracting from raw response
            const fallbackMmd = extractMermaidFromFence(raw);
            if (fallbackMmd)
                mmdContent = fallbackMmd;
        }
    }
    // Parse replace_blocks
    let replaceBlocks;
    if (fileAction === "replace" && Array.isArray(parsed.replace_blocks)) {
        replaceBlocks = [];
        for (const block of parsed.replace_blocks) {
            if (!block || typeof block !== "object")
                continue;
            const startLine = Number(block.start_line);
            const endLine = Number(block.end_line);
            if (isNaN(startLine) || isNaN(endLine))
                continue;
            let content = block.content ?? "";
            // Extract mermaid from fence if present
            const extracted = extractMermaidFromFence(content);
            if (extracted)
                content = extracted;
            replaceBlocks.push({ startLine, endLine, content });
        }
    }
    // Parse node_mapping
    const nodeMapping = {};
    if (parsed.node_mapping && typeof parsed.node_mapping === "object") {
        for (const [key, value] of Object.entries(parsed.node_mapping)) {
            if (typeof value === "string") {
                nodeMapping[key] = value;
            }
        }
    }
    return {
        fileAction,
        mmdContent,
        replaceBlocks,
        nodeMapping,
    };
}
