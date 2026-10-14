import { traceOffloadModelIo } from "./opik-tracer.js";
import * as https from "node:https";
import * as http from "node:http";
// ─── BackendClient ───────────────────────────────────────────────────────────
export class BackendClient {
    baseUrl;
    apiKey;
    /** Hardcoded timeout for all backend calls (L1/L1.5/L2/L4) */
    static TIMEOUT_MS = 120_000;
    logger;
    sessionKeyFn;
    /** Resolves the value of the `X-User-Id` header sent on every call. */
    userIdFn;
    /** Resolves the value of the `X-Task-Id` header sent on every call (optional). */
    taskIdFn;
    constructor(baseUrl, logger, apiKey, _defaultTimeoutMs, // kept for backward compat, ignored
    sessionKeyFn, userIdFn, taskIdFn) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.apiKey = apiKey;
        this.logger = logger;
        this.sessionKeyFn = sessionKeyFn ?? (() => null);
        this.userIdFn = userIdFn ?? (() => null);
        this.taskIdFn = taskIdFn ?? (() => null);
    }
    /** L1 Summarize — synchronous await (used by assemble flush + force trigger) */
    async l1Summarize(req) {
        const pairNames = req.toolPairs.map((p) => `${p.toolName}(${p.toolCallId})`).join(", ");
        this.logger.debug?.(`[context-offload] L1 >>> summarize ${req.toolPairs.length} pairs: [${pairNames}]`);
        const startMs = Date.now();
        const resp = await this.post("/offload/v1/l1/summarize", req, BackendClient.TIMEOUT_MS);
        const durationMs = Date.now() - startMs;
        const entryCount = resp.entries?.length ?? 0;
        const scores = resp.entries?.map((e) => `${e.tool_call_id}:score=${e.score}`).join(", ") ?? "";
        this.logger.debug?.(`[context-offload] L1 <<< ${entryCount} entries [${scores}]`);
        traceOffloadModelIo({
            sessionKey: this.sessionKeyFn(),
            stage: "L1.backend",
            provider: "backend",
            model: `backend:${this.baseUrl}`,
            url: `${this.baseUrl}/offload/v1/l1/summarize`,
            systemPrompt: "(constructed by backend)",
            userPrompt: JSON.stringify(req),
            responseContent: JSON.stringify(resp),
            usage: { entriesCount: entryCount },
            status: "ok",
            durationMs,
            logger: this.logger,
        });
        return resp;
    }
    /** L1.5 Task Judgment — synchronous await, uses unified timeout */
    async l15Judge(req) {
        this.logger.debug?.(`[context-offload] L1.5 >>> judge: currentMmd=${req.currentMmd?.filename ?? "null"}, availableMmds=${req.availableMmdMetas.length}, recentMessages=${req.recentMessages.length} chars`);
        const startMs = Date.now();
        const resp = await this.post("/offload/v1/l15/judge", req, BackendClient.TIMEOUT_MS);
        const durationMs = Date.now() - startMs;
        this.logger.debug?.(`[context-offload] L1.5 <<< completed=${resp.taskCompleted}, continuation=${resp.isContinuation}, continuationFile=${resp.continuationMmdFile ?? "null"}, newLabel=${resp.newTaskLabel ?? "null"}, longTask=${resp.isLongTask}`);
        traceOffloadModelIo({
            sessionKey: this.sessionKeyFn(),
            stage: "L1.5.backend",
            provider: "backend",
            model: `backend:${this.baseUrl}`,
            url: `${this.baseUrl}/offload/v1/l15/judge`,
            systemPrompt: "(constructed by backend)",
            userPrompt: JSON.stringify(req),
            responseContent: JSON.stringify(resp),
            status: "ok",
            durationMs,
            logger: this.logger,
        });
        return resp;
    }
    /** L2 MMD Generation — async background, uses unified timeout */
    async l2Generate(req) {
        const entryIds = req.newEntries.map((e) => e.tool_call_id).join(", ");
        this.logger.debug?.(`[context-offload] L2 >>> generate: task=${req.taskLabel}, prefix=${req.mmdPrefix}, entries=${req.newEntries.length} [${entryIds}], existingMmd=${req.existingMmd ? `${req.mmdCharCount} chars` : "null (new)"}`);
        const startMs = Date.now();
        const resp = await this.post("/offload/v1/l2/generate", req, BackendClient.TIMEOUT_MS);
        const durationMs = Date.now() - startMs;
        const mappingCount = Object.keys(resp.nodeMapping ?? {}).length;
        const mappingStr = Object.entries(resp.nodeMapping ?? {}).map(([k, v]) => `${k}->${v}`).join(", ");
        this.logger.debug?.(`[context-offload] L2 <<< action=${resp.fileAction}, mmdContent=${resp.mmdContent ? `${resp.mmdContent.length} chars` : "null"}, replaceBlocks=${resp.replaceBlocks?.length ?? 0}, nodeMapping=${mappingCount} [${mappingStr}]`);
        traceOffloadModelIo({
            sessionKey: this.sessionKeyFn(),
            stage: "L2.backend",
            provider: "backend",
            model: `backend:${this.baseUrl}`,
            url: `${this.baseUrl}/offload/v1/l2/generate`,
            systemPrompt: "(constructed by backend)",
            userPrompt: JSON.stringify(req),
            responseContent: JSON.stringify(resp),
            status: "ok",
            durationMs,
            logger: this.logger,
        });
        return resp;
    }
    /** L4 Skill Generation — synchronous await, uses unified timeout */
    async l4Generate(req) {
        this.logger.debug?.(`[context-offload] L4 >>> generate: mmd=${req.mmdFilename}, entries=${req.offloadEntries.length}, skillFocus=${req.skillFocus ?? "null"}`);
        const startMs = Date.now();
        const resp = await this.post("/offload/v1/l4/generate", req, BackendClient.TIMEOUT_MS);
        const durationMs = Date.now() - startMs;
        this.logger.debug?.(`[context-offload] L4 <<< skill="${resp.skillName}", content=${resp.skillContent?.length ?? 0} chars`);
        traceOffloadModelIo({
            sessionKey: this.sessionKeyFn(),
            stage: "L4.backend",
            provider: "backend",
            model: `backend:${this.baseUrl}`,
            url: `${this.baseUrl}/offload/v1/l4/generate`,
            systemPrompt: "(constructed by backend)",
            userPrompt: JSON.stringify(req),
            responseContent: JSON.stringify(resp),
            status: "ok",
            durationMs,
            logger: this.logger,
        });
        return resp;
    }
    /**
     * Upload an arbitrary state payload to the backend `/offload/v1/store` endpoint.
     * Fire-and-forget style — the caller is expected to `.catch(...)` rejections.
     * Uses a short timeout so reporting never blocks hook execution meaningfully.
     */
    async storeState(payload) {
        // Short timeout — reporting must never stall the plugin
        const timeoutMs = 10_000;
        const startMs = Date.now();
        try {
            const resp = await this.post("/offload/v1/store", payload, timeoutMs);
            const durationMs = Date.now() - startMs;
            this.logger.debug?.(`[context-offload] store <<< insertedId=${resp.insertedId ?? "?"} (${durationMs}ms)`);
            return resp;
        }
        catch (err) {
            const durationMs = Date.now() - startMs;
            this.logger.warn(`[context-offload] store !!! failed after ${durationMs}ms: ${err}`);
            throw err;
        }
    }
    // ─── Internal ──────────────────────────────────────────────────────────
    async post(path, body, timeoutMs) {
        const url = `${this.baseUrl}${path}`;
        const startMs = Date.now();
        const bodyStr = JSON.stringify(body);
        this.logger.debug?.(`[context-offload] HTTP >>> POST ${url} (${bodyStr.length} bytes, timeout=${timeoutMs}ms)`);
        const reqHeaders = {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(bodyStr)),
        };
        if (this.apiKey) {
            reqHeaders["Authorization"] = `Bearer ${this.apiKey}`;
        }
        // Propagate identity headers so the backend can key stored state by
        // `X-User-Id` (used as Mongo `_id` in /store) and scope by task.
        try {
            const uid = this.userIdFn();
            if (uid)
                reqHeaders["X-User-Id"] = uid;
        }
        catch { /* ignore — identity headers are best-effort */ }
        try {
            const tid = this.taskIdFn();
            if (tid)
                reqHeaders["X-Task-Id"] = tid;
        }
        catch { /* ignore */ }
        const parsed = new URL(url);
        const isHttps = parsed.protocol === "https:";
        const transport = isHttps ? https : http;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                req.destroy(new Error("timeout"));
            }, timeoutMs);
            const req = transport.request({
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: "POST",
                headers: reqHeaders,
                ...(isHttps ? { rejectUnauthorized: false } : {}),
            }, (res) => {
                let data = "";
                res.on("data", (chunk) => {
                    data += chunk.toString();
                });
                res.on("end", () => {
                    clearTimeout(timer);
                    const durationMs = Date.now() - startMs;
                    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                        this.logger.warn(`[context-offload] HTTP <<< ${path}: ${res.statusCode} ${res.statusMessage} (${durationMs}ms) body=${data.slice(0, 500)}`);
                        reject(new Error(`Backend API error ${res.statusCode}: ${data}`));
                        return;
                    }
                    try {
                        const parsed = JSON.parse(data);
                        this.logger.debug?.(`[context-offload] HTTP <<< ${path}: ${res.statusCode} (${durationMs}ms, ${data.length} bytes)`);
                        resolve(parsed);
                    }
                    catch {
                        reject(new Error(`Backend response JSON parse error: ${data.slice(0, 500)}`));
                    }
                });
            });
            req.on("error", (err) => {
                clearTimeout(timer);
                const durationMs = Date.now() - startMs;
                const errMsg = err.message;
                const isTimeout = errMsg.includes("timeout");
                this.logger.warn(`[context-offload] HTTP !!! ${path}: ${isTimeout ? "TIMEOUT" : "ERROR"} after ${durationMs}ms — ${errMsg}`);
                reject(err);
            });
            req.write(bodyStr);
            req.end();
        });
    }
}
