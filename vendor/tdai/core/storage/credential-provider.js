/**
 * Credential Provider — abstracts COS/VDB credential sourcing.
 *
 * The provider caches credentials with a configurable TTL and supports
 * forced invalidation (e.g. when COS returns 403).
 */
const TAG = "[storage][credential]";
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
/**
 * Returns fixed mock credentials. Use for local development and unit tests.
 * Defaults to reasonable placeholder values if not provided.
 */
export class MockCredentialProvider {
    credential;
    constructor(config = {}) {
        this.credential = {
            secretId: config.secretId ?? "MOCK_SECRET_ID",
            secretKey: config.secretKey ?? "MOCK_SECRET_KEY",
            token: config.token,
            bucket: config.bucket ?? "tdai-memory-dev-0000000000",
            region: config.region ?? "ap-guangzhou",
            prefix: config.prefix ?? "mock_tenant/mock_space/",
        };
    }
    async getCosCredential() {
        return this.credential;
    }
    invalidate() {
        // no-op for static/mock credentials
    }
}
/**
 * Alias for MockCredentialProvider — use when injecting real static credentials
 * (e.g. from environment variables or cos.env file) to avoid misleading "Mock" naming.
 */
export const StaticCredentialProvider = MockCredentialProvider;
/**
 * Generic cached credential provider. Wraps any fetcher with in-memory cache,
 * refresh-ahead-of-expiry, and forced invalidation.
 *
 * Refresh strategy (priority order):
 * 1. If `cred.expiresAt` is set by the upstream source:
 *      refresh when `now >= expiresAt - refreshBufferMs`
 * 2. Else fallback to TTL: refresh when `now >= fetchedAt + refreshBufferMs`
 * 3. On invalidate() (e.g. 403 from upstream)
 */
export class CachedCredentialProvider {
    cached = null;
    fetchedAt = 0;
    refreshBufferMs;
    fetcher;
    logger;
    fetchPromise = null;
    constructor(opts) {
        this.fetcher = opts.fetcher;
        this.refreshBufferMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
        this.logger = opts.logger;
    }
    async getCosCredential() {
        if (this.cached && !this.isExpired()) {
            return this.cached;
        }
        // Coalesce concurrent requests — only one fetch in flight at a time
        if (!this.fetchPromise) {
            this.fetchPromise = this.refresh();
        }
        try {
            return await this.fetchPromise;
        }
        finally {
            this.fetchPromise = null;
        }
    }
    invalidate() {
        this.logger?.debug?.(`${TAG} Credential cache invalidated`);
        this.cached = null;
        this.fetchedAt = 0;
        this.fetchPromise = null;
    }
    isExpired() {
        const now = Date.now();
        // Priority 1: refresh ahead of explicit credential expiration
        // (avoids 403 race for in-flight requests near expiry boundary).
        if (this.cached?.expiresAt) {
            // Total lifetime of this credential since we fetched it.
            const lifetimeMs = this.cached.expiresAt - this.fetchedAt;
            // If lifetime is shorter than the configured refresh buffer,
            // fall back to using expiresAt directly (don't refresh "before" issuance).
            const effectiveBufferMs = lifetimeMs > this.refreshBufferMs
                ? this.refreshBufferMs
                : 0;
            return now >= this.cached.expiresAt - effectiveBufferMs;
        }
        // Priority 2 (fallback): if upstream didn't return expiresAt,
        // use refreshBufferMs as a soft TTL since last fetch.
        return now - this.fetchedAt >= this.refreshBufferMs;
    }
    async refresh() {
        this.logger?.debug?.(`${TAG} Fetching fresh credentials...`);
        try {
            const credential = await this.fetcher();
            this.cached = credential;
            this.fetchedAt = Date.now();
            this.logger?.debug?.(`${TAG} Credentials refreshed, bucket=${credential.bucket}, prefix=${credential.prefix}`);
            return credential;
        }
        catch (err) {
            // If we have stale cached credentials, return them as fallback
            if (this.cached) {
                this.logger?.warn(`${TAG} Failed to refresh credentials, using stale cache: ${err}`);
                return this.cached;
            }
            throw err;
        }
    }
}
// ============================
// PrefixedCredentialProvider — wraps a shared provider with per-instance prefix
// ============================
/**
 * Wraps a shared ICredentialProvider and overrides the `prefix` field
 * for per-instance path isolation. The underlying credentials (AK/SK/Token/
 * bucket/region) are shared and auto-refreshed by the inner provider.
 *
 * When invalidate() is called (e.g. on COS 403), it propagates to the
 * inner provider so all instances benefit from the credential refresh.
 *
 * IMPORTANT: returns the same wrapped object as long as the inner credential
 * hasn't changed (reference equality), so downstream consumers like
 * CosStorageBackend can safely cache COS SDK clients by identity check.
 */
export class PrefixedCredentialProvider {
    inner;
    prefix;
    cachedInner = null;
    cachedWrapped = null;
    constructor(inner, prefix) {
        this.inner = inner;
        this.prefix = prefix;
    }
    async getCosCredential() {
        const cred = await this.inner.getCosCredential();
        // Reuse the wrapped object as long as inner credential identity is the same.
        if (this.cachedWrapped && this.cachedInner === cred) {
            return this.cachedWrapped;
        }
        this.cachedInner = cred;
        this.cachedWrapped = { ...cred, prefix: this.prefix };
        return this.cachedWrapped;
    }
    invalidate() {
        this.cachedInner = null;
        this.cachedWrapped = null;
        this.inner.invalidate();
    }
}
// ============================
// Deployment-specific credential providers should live outside core storage.
// Users can plug in their own ICredentialProvider or wrap CachedCredentialProvider
// with a custom fetcher.
// ============================
/**
 * Parse COS endpoint URL to extract bucket and region.
 *
 * Supported formats:
 *   https://{bucket}.cos.{region}.myqcloud.com          (public)
 *   https://{bucket}.cos-internal.{region}.tencentcos.cn (internal/VPC)
 */
export function parseCosUrl(cosUrl) {
    const host = cosUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    // Public: {bucket}.cos.{region}.myqcloud.com
    const publicMatch = host.match(/^(.+?)\.cos\.(.+?)\.myqcloud\.com$/);
    if (publicMatch) {
        return { bucket: publicMatch[1], region: publicMatch[2] };
    }
    // Internal/VPC: {bucket}.cos-internal.{region}.tencentcos.cn
    const internalMatch = host.match(/^(.+?)\.cos-internal\.(.+?)\.tencentcos\.cn$/);
    if (internalMatch) {
        return { bucket: internalMatch[1], region: internalMatch[2] };
    }
    throw new Error(`${TAG} Cannot parse COS URL: ${cosUrl}`);
}
