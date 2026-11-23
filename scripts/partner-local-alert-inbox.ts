import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LocalAlertEvent {
  schema_version: 1;
  environment: "production";
  event: "alert" | "recovery";
  delivery_key: string;
  alert_key: string;
  code: string;
  first_seen: string;
  last_seen: string;
  primary_owner: string;
  backup_owner: string;
}

export function pruneLocalAlertInbox(directory: string, currentKeys: Set<string>): void {
  const inbox = join(directory, "inbox");
  if (!existsSync(inbox)) return;
  for (const path of [directory, inbox]) {
    const st = lstatSync(path);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700)
      throw Error("Unsafe local alert inbox");
  }
  const names = new Set([...currentKeys].map(key => `${createHash("sha256").update(key).digest("hex")}.json`));
  for (const name of readdirSync(inbox)) {
    const temporary = /^\.[a-f0-9]{64}\.[0-9]+\.[0-9]+\.tmp$/.test(name);
    if (!temporary && (!/^[a-f0-9]{64}\.json$/.test(name) || names.has(name))) continue;
    const path = join(inbox, name), st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.())
      throw Error("Unsafe local alert entry");
    // Leave recent in-flight files alone; a crash must not permanently consume
    // an inbox capacity slot. Only this writer's old temporary pattern is eligible.
    if (temporary && Date.now() - st.mtimeMs < 86400000) continue;
    unlinkSync(path);
  }
  const fd = openSync(inbox, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// One bounded latest-event slot per current alert. This is a local inbox,
// never a claim that a human was paged or acknowledged the event.
export function persistLocalAlert(directory: string, event: LocalAlertEvent): void {
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.()
    || (parent.mode & 0o777) !== 0o700) throw Error("Unsafe local alert directory");
  const bytes = JSON.stringify(event);
  if (Buffer.byteLength(bytes) > 8192 || !/^[a-f0-9]{64}$/.test(event.delivery_key)
    || !event.alert_key || event.alert_key.length > 256) throw Error("Invalid local alert event");
  const inbox = join(directory, "inbox");
  mkdirSync(inbox, { mode: 0o700, recursive: true });
  const info = lstatSync(inbox);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()
    || (info.mode & 0o777) !== 0o700) throw Error("Unsafe local alert inbox");
  const key = createHash("sha256").update(event.alert_key).digest("hex");
  const target = join(inbox, `${key}.json`);
  if (!existsSync(target) && readdirSync(inbox).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length >= 1000)
    throw Error("Local alert inbox capacity exceeded");
  // Unique temporary names allow retry after a process died before rename.
  const temporary = join(inbox, `.${event.delivery_key}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let published = false;
  try {
    writeFileSync(fd, bytes + "\n");
    fsyncSync(fd);
    renameSync(temporary, target);
    published = true;
    const directoryFd = openSync(inbox, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } finally {
    closeSync(fd);
    if (!published) unlinkSync(temporary);
  }
}
