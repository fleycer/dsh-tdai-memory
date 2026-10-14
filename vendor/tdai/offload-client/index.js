import { defaultOffloadClientConfig } from "./types.js";
import { OffloadApiClient } from "./offload-api-client.js";
import { OffloadContextEngine } from "./context-engine.js";
import { createAfterToolCallHandler } from "./hooks/after-tool-call.js";
/**
 * Register the offload-client plugin.
 * Call this from the main plugin's register() when offload-client config is enabled.
 */
export function registerOffloadClient(api, userConfig) {
    const config = { ...defaultOffloadClientConfig(), ...userConfig };
    const logger = api.logger ?? { info: console.log, warn: console.warn, error: console.error, debug: console.debug };
    if (!config.enabled) {
        logger.info("[offload-client] disabled by config");
        return;
    }
    if (!config.serverUrl || !config.apiKey || !config.serviceId) {
        logger.error("[offload-client] missing required config: serverUrl, apiKey, or serviceId");
        return;
    }
    const client = new OffloadApiClient(config, logger);
    // Context Engine: occupies slot, assemble() calls compaction API
    const engine = new OffloadContextEngine(client, config, logger);
    // Hook: fire-and-forget ingest on every tool call (with context from engine per session)
    const afterToolCallHandler = createAfterToolCallHandler(client, config, logger, (sessionKey) => engine.getContext(sessionKey), config.agentName);
    api.on("after_tool_call", afterToolCallHandler);
    // ── Memory management hooks ──
    // agent_end: clear token cache after each agent turn
    api.on("agent_end", (_event, ctx) => {
        const sk = ctx.sessionKey ?? ctx.sessionId;
        if (sk) {
            engine.resetSession(sk);
            logger.debug?.(`[offload-client] reset session state: ${sk}`);
        }
    });
    // gateway_stop: emergency cleanup on shutdown
    api.on("gateway_stop", async () => {
        engine.clearAllSessions();
        logger.info("[offload-client] all session states cleared on gateway_stop");
    });
    try {
        const result = api.registerContextEngine("memory-tencentdb", () => engine);
        if (result?.ok === false) {
            logger.error(`[offload-client] Context Engine slot occupied by "${result.existingOwner ?? "unknown"}". ` +
                `Compaction disabled — only ingest will work.`);
        }
        else {
            logger.info("[offload-client] Context Engine registered");
        }
    }
    catch (err) {
        logger.error(`[offload-client] registerContextEngine failed: ${err}. Compaction disabled.`);
    }
    // ── Health check (async, non-blocking) ──
    client.checkHealth().then((ok) => {
        if (!ok) {
            logger.warn(`[offload-client] ⚠️  Server ${config.serverUrl} unreachable! ` +
                `Ingest calls will fail silently until server becomes available.`);
        }
        else {
            logger.info(`[offload-client] Server health OK: ${config.serverUrl}`);
        }
    }).catch((_err) => {
        // ignore
    });
    logger.info(`[offload-client] registered (server=${config.serverUrl})`);
}
export { OffloadApiClient } from "./offload-api-client.js";
export { OffloadContextEngine } from "./context-engine.js";
export { createAfterToolCallHandler } from "./hooks/after-tool-call.js";
export { estimateTokens, estimateMessageTokens, estimateAllTokens } from "./token-estimator.js";
