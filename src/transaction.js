import fs from 'node:fs';
import os from 'node:os';
import { AkmError, atomicWrite, check, contentHash, hash, id, json, listFiles, readJSON, safe } from './storage.js';

function unfinished(vault) {
  return listFiles(vault, '.vault-meta/transactions').filter(p => p.endsWith('.json')).map(p => ({ path: p, ...readJSON(safe(vault, p)) })).filter(j => j.state === 'prepared');
}
export function assertReadable(vault) {
  check(!fs.existsSync(safe(vault, '.vault-meta/lock.json')), 'Vault is busy; retry the query', 'VAULT_BUSY');
  check(unfinished(vault).length === 0, 'Interrupted transaction needs recovery', 'RECOVERY_REQUIRED');
}
export function withLock(vault, action, { recovery = false } = {}) {
  const lockPath = safe(vault, '.vault-meta/lock.json');
  let fd;
  try { fd = fs.openSync(lockPath, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new AkmError('VAULT_BUSY', 'Vault is busy; recover a stale lock explicitly'); throw e; }
  try {
    fs.writeFileSync(fd, json({ pid: process.pid, host: os.hostname(), created: new Date().toISOString() }));
    fs.fsyncSync(fd);
    if (!recovery) check(unfinished(vault).length === 0, 'Interrupted transaction needs recovery', 'RECOVERY_REQUIRED');
    return action();
  } finally { fs.closeSync(fd); fs.unlinkSync(lockPath); }
}
function rollback(vault, journal) {
  // Check everything before restoring anything. Do not erase an unrelated Obsidian edit.
  for (const write of journal.writes) {
    const current = contentHash(safe(vault, write.path));
    check(current === write.beforeHash || current === hash(Buffer.from(write.after, 'base64')), `Recovery conflict: ${write.path}`, 'RECOVERY_CONFLICT');
  }
  for (const write of [...journal.writes].reverse()) {
    const target = safe(vault, write.path);
    if (write.before === null) { if (fs.existsSync(target)) fs.unlinkSync(target); }
    else atomicWrite(target, Buffer.from(write.before, 'base64'));
  }
}
// Caller holds the Vault lock. expected includes read-only transaction dependencies too.
export function commit(vault, writes, expected, options = {}) {
  check(writes.length > 0 && writes.length <= 256, 'Invalid transaction size');
  check(new Set(writes.map(w => w.path)).size === writes.length, 'Duplicate transaction target');
  for (const [relative, digest] of Object.entries(expected)) {
    check(contentHash(safe(vault, relative)) === digest, `Target changed: ${relative}; create a new proposal`, 'CONFLICT');
  }
  let size = 0;
  const journalWrites = writes.map(w => {
    check(Object.hasOwn(expected, w.path), `Missing precondition: ${w.path}`);
    const file = safe(vault, w.path);
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const after = Buffer.from(w.content);
    size += after.length + (before?.length ?? 0);
    return { path: w.path, before: before?.toString('base64') ?? null, beforeHash: before ? hash(before) : null, after: after.toString('base64') };
  });
  check(size <= 16 * 1024 * 1024, 'Transaction exceeds MVP 16 MiB bound');
  const journal = { schema: 1, id: id('op'), state: 'prepared', writes: journalWrites };
  const journalPath = safe(vault, `.vault-meta/transactions/${journal.id}.json`);
  atomicWrite(journalPath, json(journal));
  try {
    for (let i = 0; i < journalWrites.length; i++) {
      const w = journalWrites[i];
      check(contentHash(safe(vault, w.path)) === w.beforeHash, `Target changed during commit: ${w.path}`, 'CONFLICT');
      atomicWrite(safe(vault, w.path), Buffer.from(w.after, 'base64'));
      options.afterWrite?.(i, journal);
    }
    journal.state = 'committed';
    atomicWrite(journalPath, json(journal));
  } catch (e) {
    try { rollback(vault, journal); journal.state = 'rolled_back'; atomicWrite(journalPath, json(journal)); }
    catch (recoveryError) { throw new AkmError('RECOVERY_REQUIRED', 'Commit failed; recovery needed', { reason: e.message, recovery: recoveryError.message }); }
    throw e;
  }
  return { operationId: journal.id, changed: writes.map(w => w.path) };
}
export function recover(vault, { clearStaleLock = false } = {}) {
  const lockPath = safe(vault, '.vault-meta/lock.json');
  if (fs.existsSync(lockPath)) {
    check(clearStaleLock, 'Explicit --clear-stale-lock is required', 'VAULT_BUSY');
    const lock = readJSON(lockPath);
    check(lock.host === os.hostname() && Number.isSafeInteger(lock.pid) && lock.pid > 0, 'Cannot establish ownership of lock', 'VAULT_BUSY');
    let alive = true;
    try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    check(!alive, 'Lock owner is still alive', 'VAULT_BUSY');
    fs.unlinkSync(lockPath);
  }
  return withLock(vault, () => {
    const restored = [];
    for (const journal of unfinished(vault)) {
      rollback(vault, journal);
      journal.state = 'rolled_back';
      const { path: relative, ...record } = journal;
      atomicWrite(safe(vault, relative), json(record));
      restored.push(journal.id);
    }
    return { restored };
  }, { recovery: true });
}
