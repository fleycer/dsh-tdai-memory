/**
 * TDAI Core — barrel re-export for core types and service facade.
 *
 * This module exports ONLY the host-neutral interfaces and the TdaiCore facade.
 * Host-specific adapters live in `../adapters/`.
 */
// TdaiCore service facade
export { TdaiCore } from "./tdai-core.js";
// Instance config provider (VDB per-instance pool + COS global).
// LocalConfigSource lives inline in instance-config-provider.ts; other
// deployments may provide their own IConfigSource implementation.
export { InstanceConfigProvider, LocalConfigSource, } from "./instance-config-provider.js";
// Store pool (per-instanceId Store instances)
export { StorePool } from "./store/store-pool.js";
// Storage backend (unified file/object abstraction).
// Optional remote object storage backends are loaded dynamically by
// createStorageBackend and are not re-exported from core.
export { LocalStorageBackend, StoragePaths, StorageAdapter, createStorageBackend, createLocalStorageBackend, MockCredentialProvider, StaticCredentialProvider, CachedCredentialProvider, PrefixedCredentialProvider, parseCosUrl, } from "./storage/index.js";
