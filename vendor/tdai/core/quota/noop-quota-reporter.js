/**
 * NoopQuotaReporter — default (open-source) quota reporter.
 *
 * Behaviour:
 *   - fetchQuota() returns null → QuotaManager treats this as "unlimited",
 *     so every checkMemoryQuota / checkCreditQuota call passes.
 *   - reportUsage() is a no-op (no remote billing in open-source builds).
 *
 * Use this in standalone / self-hosted deployments where there is no
 * billing system to report into.
 */
export class NoopQuotaReporter {
    async fetchQuota(_instanceId) {
        return null; // unlimited
    }
    async reportUsage(_instanceId, _memoryDelta, _creditDelta, _level) {
        // intentionally empty — default build does not bill
    }
}
