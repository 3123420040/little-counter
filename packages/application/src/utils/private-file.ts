import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

/** Reads without following a final symlink; never includes content in errors. */
export function readPrivateFile(path: string, expectedUid = process.getuid?.()): string {
  if (!isAbsolute(path)) throw Error("Private path must be absolute");
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || parent.uid !== expectedUid) {
    throw Error("Private directory must be owned with mode 0700");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o777) !== 0o600 || st.uid !== expectedUid || st.size > 65536) {
      throw Error("Private file must be owned with mode 0600 and bounded size");
    }
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
