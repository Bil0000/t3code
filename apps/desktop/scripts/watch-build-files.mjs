import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function watchBuildFiles(directory, files, onChange) {
  const readHash = (filename) => {
    try {
      return NodeCrypto.hash("sha256", NodeFS.readFileSync(NodePath.join(directory, filename)));
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  };
  const hashes = new Map([...files].map((filename) => [filename, readHash(filename)]));

  return NodeFS.watch(directory, { persistent: true }, (_eventType, filename) => {
    if (typeof filename !== "string" || !files.has(filename)) return;
    const hash = readHash(filename);
    if (hash === hashes.get(filename)) return;
    hashes.set(filename, hash);
    onChange();
  });
}
