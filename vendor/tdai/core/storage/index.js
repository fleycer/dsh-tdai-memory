/**
 * Storage — barrel re-export for the storage abstraction layer.
 *
 * This file is the open-source / standalone surface of the storage layer.
 * It only re-exports the interface, the local backend, and the generic
 * credential primitives.
 *
 * Optional remote object storage support is loaded dynamically by the storage
 * factory at runtime.
 */
export { StoragePaths } from "./types.js";
// Default implementation (always available)
export { LocalStorageBackend } from "./local-backend.js";
export { StorageAdapter } from "./adapter.js";
// Generic credential primitives (no cloud-vendor dependency)
export { MockCredentialProvider, StaticCredentialProvider, CachedCredentialProvider, PrefixedCredentialProvider, parseCosUrl, } from "./credential-provider.js";
// Factory (dynamically loads optional COS backend when requested)
export { createStorageBackend, createLocalStorageBackend, } from "./factory.js";
