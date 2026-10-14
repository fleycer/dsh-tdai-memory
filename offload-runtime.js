/**
 * offload-runtime.js — pure message-shape helpers for the context-offload
 * integration (vendor/tdai/offload). No plugin/DSH state lives here, so the
 * mapping and extraction contracts are testable without booting apply():
 * see tests/offload-runtime.test.mjs.
 *
 * Two contracts matter:
 *  - `mapForOffload()` maps DSH deriveMessages() output to the
 *    `{role, content:[blocks], toolCallId?}` shape the upstream offload
 *    handlers consume, on a FRESH array of FRESH objects — upstream mutates
 *    only these copies, never dsh's real session history (the compaction
 *    subsystem stays its sole owner).
 *  - `extractMmdText()` pulls the injected Mermaid short-term-memory message
 *    (flagged `m._mmdContextMessage` by upstream) out of an assemble() result.
 */

/** Extract plain text from a dsh message content (block array or string). */
export function extractText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** JSON.parse that degrades to the raw string instead of throwing. */
export function safeJson(text) {
  if (typeof text !== "string") return text ?? {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** JSON.stringify that never throws. */
export function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Map one DSH content block to the Anthropic-ish block shape the offload
 * pipeline expects (`{type:"text"|"tool_use"|"tool_result", ...}`). Known
 * blocks pass through untouched; anything else is stringified into a text
 * block so no content silently disappears.
 */
export function mapBlocksForOffload(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((b) => {
    if (b && typeof b === "object") {
      if (b.type === "text" && typeof b.text === "string") return b;
      if (b.type === "tool_use" || b.type === "tool_result") return b;
      try {
        return { type: "text", text: JSON.stringify(b) };
      } catch {
        return { type: "text", text: String(b) };
      }
    }
    return { type: "text", text: String(b) };
  });
}

/**
 * Map dsh deriveMessages() output to the message shape the offload handlers
 * consume: `{role, content:[blocks], toolCallId?}`. Roles pass through
 * (system/developer/user/assistant/tool); the tool call id comes from
 * `message.toolCallId` (ToolResultMessage) or `message.source.callId`.
 * Always returns new objects — the input array and its blocks are shared
 * read-only, upstream mutations (splice, push) land on the returned copies.
 */
export function mapForOffload(messages) {
  return (messages ?? []).map((m) => {
    const out = { role: m?.role ?? "user", content: mapBlocksForOffload(m?.content) };
    const callId = m?.toolCallId ?? m?.source?.callId;
    if (callId) out.toolCallId = callId;
    return out;
  });
}

/**
 * Extract the injected MMD (Mermaid short-term memory) text from an upstream
 * engine.assemble() result. Upstream flags its synthetic message with
 * `m._mmdContextMessage` (role "user", content [{type:"text",text}]); multiple
 * flagged messages are joined with a blank line. Returns "" when the result
 * carries no MMD message.
 */
export function extractMmdText(messages) {
  const parts = (messages ?? [])
    .filter((m) => m && m._mmdContextMessage)
    .map((m) => extractText(m.content))
    .filter(Boolean);
  return parts.length ? parts.join("\n\n") : "";
}

/**
 * Map a dsh `tool/result` event to the upstream after_tool_call event
 * (`{toolName, toolCallId, params, result, error, durationMs}`). `cached` is
 * the matching tool/call bookkeeping ({name, params, at}) when still tracked;
 * without it the pair degrades to toolName "unknown_tool" and empty params.
 */
export function buildToolPairEvent({ cached, data, now = Date.now() }) {
  const message = data?.message ?? {};
  const callId = message.toolCallId ?? message.source?.callId ?? `auto-${now}`;
  const resultText = extractText(message.content) || safeStringify(message.content);
  const errorText = data?.error
    ? (data.error.reason || data.error.name || safeStringify(data.error))
    : (message.isError ? resultText : undefined);
  return {
    toolName: cached?.name ?? "unknown_tool",
    toolCallId: callId,
    params: cached?.params ?? {},
    result: message.isError ? undefined : resultText,
    error: errorText,
    durationMs: cached?.at ? now - cached.at : undefined,
  };
}
