import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import YAML from 'yaml';

export class AkmError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
export function check(condition, message, code = 'INVALID_INPUT') {
  if (!condition) throw new AkmError(code, message);
}
export const hash = data => createHash('sha256').update(data).digest('hex');
export const id = prefix => `${prefix}-${randomUUID()}`;
export const json = value => `${JSON.stringify(value, null, 2)}\n`;
export function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new AkmError('INVALID_STATE', `Cannot read JSON: ${file}`, { reason: e.message }); }
}
export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function component(value, name = 'name') {
  check(typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 160, `Invalid ${name}`);
  check(!/[\\/\x00-\x1f\[\]#^|:*?<>]/u.test(value) && !['.', '..'].includes(value) && !/[. ]$/.test(value), `Unsafe ${name}: ${value}`);
  return value;
}
// Validate the root and descendants; OS ancestors such as macOS /var may be aliases.
export function safe(root, relative) {
  check(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative) && !relative.includes('\\'), 'Expected a relative path');
  check(!relative.split('/').some(p => !p || p === '.' || p === '..' || /[\x00-\x1f]/.test(p)), 'Unsafe relative path');
  const full = path.resolve(root, relative);
  let current = path.resolve(root);
  for (const part of ['', ...relative.split('/')]) {
    if (part) current = path.join(current, part);
    try { check(!fs.lstatSync(current).isSymbolicLink(), `Symlink is not allowed: ${current}`, 'UNSAFE_PATH'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return full;
}
export const contentHash = file => fs.existsSync(file) ? hash(fs.readFileSync(file)) : null;
export function listFiles(root, prefix = '') {
  const result = [];
  const base = prefix ? safe(root, prefix) : root;
  if (!fs.existsSync(base)) return result;
  for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    check(!entry.isSymbolicLink(), `Symlink is not allowed: ${relative}`, 'UNSAFE_PATH');
    if (entry.isDirectory()) result.push(...listFiles(root, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}
export function readPage(vault, relative) {
  const text = fs.readFileSync(safe(vault, relative), 'utf8');
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  let props = {};
  if (match) {
    try { props = YAML.parse(match[1]) ?? {}; }
    catch (e) { throw new AkmError('INVALID_PAGE', `Invalid frontmatter: ${relative}`, { reason: e.message }); }
    check(props && typeof props === 'object' && !Array.isArray(props), `Invalid frontmatter: ${relative}`, 'INVALID_PAGE');
  }
  const body = match ? text.slice(match[0].length) : text;
  const title = /^#\s+(.+)$/m.exec(body)?.[1] ?? path.basename(relative, '.md');
  const domain = props.domain ?? props.project ?? relative.split('/')[1];
  return { path: relative, id: props.id ?? relative, domain, project: domain, title, props, body, text, hash: hash(text), bodyStartLine: match ? match[0].split('\n').length : 1 };
}
export function renderPage(props, title, content) {
  let body = content.trim();
  // The renderer owns the page title, including translated/renamed titles.
  while (/^# [^\n]+(?:\n|$)/.test(body)) body = body.replace(/^# [^\n]+(?:\n|$)/, '').trimStart();
  return `---\n${YAML.stringify(props)}---\n\n# ${title}\n\n${body}\n`;
}
export function pages(vault) { return listFiles(vault, 'projects').filter(p => p.endsWith('.md') && path.basename(p) !== 'index.md').map(p => readPage(vault, p)); }
export function projects(vault) {
  return listFiles(vault, 'projects').filter(p => p.endsWith('/project.json')).map(p => ({ ...readJSON(safe(vault, p)), path: p.slice(0, -'/project.json'.length) }));
}
export function rootDir(value) { return path.resolve(value ?? process.env.AKM_HOME ?? path.join(os.homedir(), '.akm')); }
function createVaultDirectory(root, name) {
  component(name, 'vault name');
  const vault = safe(root, `vaults/${name}`);
  check(!fs.existsSync(vault), 'Vault destination already exists', 'ALREADY_EXISTS');
  for (const dir of ['inbox', '.raw', 'sources', 'projects', '.akm/ledgers', '.vault-meta/proposals', '.vault-meta/transactions', '.obsidian']) fs.mkdirSync(safe(vault, dir), { recursive: true });
  const manifest = { schema: 1, id: id('vault'), name, description: 'Local AKM knowledge vault' };
  atomicWrite(safe(vault, 'vault.json'), json(manifest));
  atomicWrite(safe(vault, '.obsidian/app.json'), json({ showInlineTitle: false }));
  atomicWrite(safe(vault, 'index.md'), '# 知识库\n\n');
  return manifest;
}
export function init(root, name = 'default') {
  safe(root, 'config.json');
  check(!fs.existsSync(path.join(root, 'config.json')), 'AKM is already initialized', 'ALREADY_EXISTS');
  const manifest = createVaultDirectory(root, name);
  const workspace = safe(root, 'workspaces/default');
  fs.mkdirSync(safe(workspace, '.pi'), { recursive: true });
  atomicWrite(safe(workspace, 'workspace.json'), json({ schema: 1, vaultId: manifest.id, activeVaultId: manifest.id }));
  atomicWrite(safe(root, 'config.json'), json({ schema: 1, defaultVault: manifest.id, defaultWorkspace: 'default' }));
  return { vault: manifest, workspace: 'default' };
}
export function importVault(root, sourcePath, name) {
  check(typeof sourcePath === 'string' && path.isAbsolute(sourcePath), 'Vault path must be absolute');
  const source = path.resolve(sourcePath);
  check(fs.existsSync(source) && fs.statSync(source).isDirectory(), 'Vault path must be a directory', 'INVALID_VAULT');
  check(!fs.lstatSync(source).isSymbolicLink(), 'Vault path cannot be a symlink', 'INVALID_VAULT');
  const chosen = component(name ?? path.basename(source), 'vault name');
  const target = safe(root, `vaults/${chosen}`);
  check(!fs.existsSync(target), 'Vault destination already exists', 'ALREADY_EXISTS');
  const markdown = listFiles(source).filter(file => file.endsWith('.md'));
  check(markdown.length > 0 || fs.existsSync(path.join(source, '.obsidian')), 'Directory is not a recognizable Obsidian Vault', 'INVALID_VAULT');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, errorOnExist: true, preserveTimestamps: true });
  const manifestPath = safe(target, 'vault.json');
  const manifest = fs.existsSync(manifestPath) ? readJSON(manifestPath) : { schema: 1, id: id('vault'), name: chosen, description: 'Imported Obsidian knowledge vault' };
  manifest.name = chosen;
  atomicWrite(manifestPath, json(manifest));
  const workspace = safe(root, 'workspaces/default');
  fs.mkdirSync(safe(workspace, '.pi'), { recursive: true });
  atomicWrite(safe(workspace, 'workspace.json'), json({ schema: 1, vaultId: manifest.id, activeVaultId: manifest.id }));
  atomicWrite(safe(root, 'config.json'), json({ schema: 1, defaultVault: manifest.id, defaultWorkspace: 'default' }));
  return { vault: manifest, source, directory: `vaults/${chosen}` };
}
export function createVault(root, name) {
  check(fs.existsSync(path.join(root, 'config.json')), 'AKM is not initialized; run akm init first', 'NOT_INITIALIZED');
  return { vault: createVaultDirectory(root, name) };
}
export function resolveWorkspace(root, name) {
  const config = readJSON(safe(root, 'config.json'));
  const selected = component(name ?? config.defaultWorkspace, 'workspace');
  const dir = safe(root, `workspaces/${selected}`);
  return { name: selected, dir, config: readJSON(safe(dir, 'workspace.json')) };
}
export function vaultList(root) {
  return listFiles(root, 'vaults').filter(p => p.split('/').length === 3 && p.endsWith('/vault.json')).map(p => ({ ...readJSON(safe(root, p)), directory: path.dirname(p) }));
}
export function resolveVault(root, selection, workspace) {
  const config = readJSON(safe(root, 'config.json'));
  const selected = selection ?? resolveWorkspace(root, workspace).config.activeVaultId ?? resolveWorkspace(root, workspace).config.vaultId ?? config.defaultVault;
  const matches = vaultList(root).filter(v => v.id === selected || v.name === selected);
  check(matches.length === 1, `Vault not found or ambiguous: ${selected}`, 'VAULT_NOT_FOUND');
  return { dir: safe(root, matches[0].directory), manifest: matches[0] };
}
export function setActiveVault(root, selection, workspace) {
  const current = resolveWorkspace(root, workspace);
  const selected = resolveVault(root, selection, current.name);
  const file = safe(root, `workspaces/${current.name}/workspace.json`);
  atomicWrite(file, json({ ...current.config, vaultId: selected.manifest.id, activeVaultId: selected.manifest.id }));
  return { workspace: current.name, vault: selected.manifest };
}
export function activeVaultStatus(root, workspace) {
  const current = resolveWorkspace(root, workspace);
  const selected = resolveVault(root, undefined, current.name);
  return { workspace: current.name, vault: selected.manifest };
}
export function revision(value) { const { revision: ignored, ...rest } = value; return hash(json(rest)); }
