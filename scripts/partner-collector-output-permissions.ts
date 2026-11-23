import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from "node:fs";
import { join } from "node:path";

const outputs = ["access", "security", "traces", "metrics"] as const;

/**
 * The collector's file exporter recreates an output with its process umask
 * after rotation. The enclosing backend directory stays private; this check
 * restores the stronger file-mode contract during every retention tick.
 */
export function enforceCollectorOutputPermissions(directory: string): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Collector output owner is unavailable");
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
      parent.uid !== uid || (parent.mode & 0o777) !== 0o700) {
    throw new Error("Unsafe collector backend directory");
  }

  let repaired = 0;
  for (const name of outputs) {
    const path = join(directory, `${name}.jsonl`);
    let stable = false;
    for (let attempt = 0; attempt < 3 && !stable; attempt++) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let inode: number;
      try {
        const file = fstatSync(fd);
        if (!file.isFile() || file.nlink !== 1 || file.uid !== uid)
          throw new Error("Unsafe collector output file");
        inode = file.ino;
        if ((file.mode & 0o777) !== 0o600) {
          fchmodSync(fd, 0o600);
          repaired++;
        }
      } finally {
        closeSync(fd);
      }
      const current = lstatSync(path);
      stable = current.isFile() && !current.isSymbolicLink() &&
        current.nlink === 1 && current.uid === uid &&
        current.ino === inode && (current.mode & 0o777) === 0o600;
    }
    if (!stable) throw new Error("Collector output rotated during permission check");
  }
  return repaired;
}
