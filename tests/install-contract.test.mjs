import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

assert.equal(manifest.optionalDependencies?.["node-llama-cpp"], undefined);
assert.equal(manifest.peerDependencies?.["node-llama-cpp"], "^3.19.1");
assert.equal(manifest.peerDependenciesMeta?.["node-llama-cpp"]?.optional, true);
console.log("install contract: native local embedding stays opt-in");

// v0.6.0 shipped a broken package: `files` missed offload-runtime.js, so a
// registry/git install had index.js importing a module that was never packed.
// Keep every runtime module of the dsh shell inside the whitelist.
const runtimeFiles = [
  "index.js",
  "recall-inject.js",
  "recall-runtime.js",
  "offload-runtime.js",
  "client.js",
  "cordis.patch.yml",
  "vendor",
];
for (const file of runtimeFiles) {
  assert.ok(manifest.files?.includes(file), `package.json "files" must include runtime module ${file}`);
}
console.log("install contract: all runtime modules are packed");
