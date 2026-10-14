/**
 * StorageAdapter — adapts IStorageBackend to a fs-like interface
 * for compatibility with upper-layer code.
 *
 * Progressive migration strategy:
 *   Existing L2/L3/Recall code uses `fs.readFile(path.join(dataDir, ...))`.
 *   StorageAdapter provides equivalent method signatures, internally delegating
 *   to IStorageBackend, so existing code only needs to swap the import.
 *
 * Eventually, callers may inline IStorageBackend calls directly and
 * this adapter can be removed.
 */
export class StorageAdapter {
    backend;
    constructor(backend) {
        this.backend = backend;
    }
    get type() { return this.backend.type; }
    // ── fs.readFile replacement ──
    async readFile(key) {
        const obj = await this.backend.getObject(key);
        if (!obj)
            return null;
        return obj.content.toString("utf-8");
    }
    async readFileOrThrow(key) {
        const content = await this.readFile(key);
        if (content === null)
            throw new Error(`File not found: ${key}`);
        return content;
    }
    async readFileBuffer(key) {
        const obj = await this.backend.getObject(key);
        if (!obj)
            return null;
        return obj.content;
    }
    // ── fs.writeFile replacement ──
    async writeFile(key, content) {
        return this.backend.putObject(key, content);
    }
    // ── fs.appendFile replacement — atomic via backend.appendObject (CR-1 fix) ──
    /**
     * Append to a storage object atomically.
     *
     * CR-1 fix (2026-05-19): previously implemented as read-modify-write
     * (readFile + concat + putObject), which lost data under concurrency
     * (audit/exp1 reproduced 99% loss at 100 parallel writes). Now delegates
     * to backend.appendObject which uses:
     *   - LocalStorageBackend: POSIX fs.appendFile (O_APPEND atomic)
     *   - CosStorageBackend: COS Append Object API (server-side atomic + 409 retry)
     */
    async appendFile(key, content) {
        return this.backend.appendObject(key, content);
    }
    // ── fs.readdir replacement ──
    async readdir(prefix, suffix) {
        const result = await this.backend.listObjects(prefix, { maxKeys: 10000 });
        if (!suffix)
            return result.entries;
        return result.entries.filter(e => e.key.endsWith(suffix));
    }
    async readdirNames(prefix, suffix) {
        const entries = await this.readdir(prefix, suffix);
        return entries
            .filter(e => !e.isDirectory)
            .map((e) => {
            // Return filename without prefix
            const name = e.key.startsWith(prefix) ? e.key.slice(prefix.length) : e.key;
            return name;
        });
    }
    // ── fs.unlink replacement ──
    async unlink(key) {
        return this.backend.deleteObject(key);
    }
    // ── fs.rm (recursive) replacement ──
    async rmdir(prefix) {
        await this.backend.deleteByPrefix(prefix);
    }
    // ── fs.mkdir (recursive) replacement ──
    // No-op for object storage (directories are implicit).
    // For local backend, putObject auto-creates parent dirs.
    async mkdir(_prefix) {
        // No-op: directories are created implicitly on putObject
    }
    // ── fs.access replacement ──
    async exists(key) {
        return this.backend.exists(key);
    }
    // ── fs.stat replacement ──
    async stat(key) {
        const obj = await this.backend.getObject(key);
        if (!obj)
            return null;
        const lastModified = obj.lastModified?.getTime() ?? Date.now();
        return {
            key,
            size: obj.size ?? obj.content.length,
            lastModified,
            createdAt: lastModified,
        };
    }
    // ── fs.rename replacement ──
    async rename(sourceKey, destKey) {
        // CR-8 partial fix (2026-05-19): preserve contentType + metadata across rename.
        // The 3-step (get → put → delete) is still NOT atomic; if the process is killed
        // between put and delete, both source and dest will exist (data duplication).
        // A complete fix requires a native renameObject in IStorageBackend (using
        // POSIX fs.rename for local + COS x-cos-copy-source for remote). Tracked as
        // long-term work — see audit report H-6 (persona.md backup rotation).
        const obj = await this.backend.getObject(sourceKey);
        if (!obj)
            throw new Error(`Source not found: ${sourceKey}`);
        await this.backend.putObject(destKey, obj.content, {
            contentType: obj.contentType,
            metadata: obj.metadata,
        });
        await this.backend.deleteObject(sourceKey);
    }
    // ── fs.copyFile replacement ──
    async copyFile(sourceKey, destKey) {
        // CR-8 partial fix (2026-05-19): preserve contentType + metadata across copy.
        const obj = await this.backend.getObject(sourceKey);
        if (!obj)
            throw new Error(`Source not found: ${sourceKey}`);
        await this.backend.putObject(destKey, obj.content, {
            contentType: obj.contentType,
            metadata: obj.metadata,
        });
    }
    // ── Direct backend access ──
    getBackend() {
        return this.backend;
    }
}
