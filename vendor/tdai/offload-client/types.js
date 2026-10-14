/**
 * offload-client — Type definitions.
 */
export function defaultOffloadClientConfig() {
    return {
        enabled: false,
        serverUrl: "http://localhost:9100",
        apiKey: "",
        serviceId: "",
        compactionRatio: 0.5,
        ingestTimeoutMs: 5000,
        compactionTimeoutMs: 30000,
    };
}
