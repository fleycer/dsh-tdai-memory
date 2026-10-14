/**
 * Create the after_tool_call hook handler.
 * Sends each tool call result to the server for L1 processing.
 *
 * @param getContext Optional getter for { prompt, recentMessages } context per session.
 */
export function createAfterToolCallHandler(client, config, logger, getContext) {
    return (event, ctx) => {
        const sessionId = ctx.sessionKey ?? ctx.sessionId;
        logger.debug?.(`[offload-client] after_tool_call: tool=${event.toolName}, session=${sessionId ?? "(none)"}, callId=${event.toolCallId ?? "(none)"}`);
        if (!sessionId)
            return;
        const toolPair = {
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            params: event.params ?? {},
            result: event.result,
            error: event.error,
            timestamp: new Date().toISOString(),
            durationMs: event.durationMs,
        };
        const context = getContext?.(sessionId);
        // Fire-and-forget — do not block the LLM flow
        client.ingestWithContext(sessionId, [toolPair], context?.prompt, context?.recentMessages).catch((err) => {
            logger.warn(`[offload-client] ingest fire-and-forget error: ${err}`);
        });
    };
}
