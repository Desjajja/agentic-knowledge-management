// Creates a Chinese presentation copy; original retrieval baseline remains reproducible.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { json, pages, renderPage, resolveVault, atomicWrite, readJSON } from '../src/storage.js';
import { runPi, answer } from '../src/pi.js';
const base = path.resolve('artifacts/ux-validation-2026-10-12');
const root = path.join(base, 'akm-root');
fs.mkdirSync(base, { recursive: true });
if (!fs.existsSync(root)) fs.cpSync(path.resolve('artifacts/distributed-systems-2026-10-12/akm-root'), root, { recursive: true });
const vault = resolveVault(root).dir;
const config = readJSON(path.join(root, 'workspaces/default/workspace.json'));
const input = readline.createInterface({ input: process.stdin });
const key = (await input.question('')).trim();
process.env[config.apiKeyEnv] = key;
const save = (name, value) => atomicWrite(path.join(base, name), json(value).replaceAll(key, '[REDACTED]'));
const manifest = pages(vault);
try {
  for (let i = 0; i < manifest.length; i += 3) {
    await Promise.all(manifest.slice(i, i + 3).map(async page => {
      const file = `translations/${page.id}.json`;
      if (fs.existsSync(path.join(base, file))) return;
      const trace = [];
      const response = await runPi(root, 'default', `Translate this knowledge page faithfully into Simplified Chinese. Keep all facts, dates, qualifications, formulas, source attributions and code. Do not summarize. Preserve original technical terms in parentheses where useful. Return ONLY JSON {"title":"Chinese title without filename-forbidden characters","content":"Chinese Markdown body without top-level H1"}. SOURCE=${json({ title: page.title, body: page.body })}`, { timeout: 300000, onTrace: v => trace.push(v) });
      const translated = JSON.parse(response.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
      save(file, { original: page.path, ...translated });
      save(`trace/translate-${page.id}.json`, trace);
      console.log(json({ stage: 'translated', title: translated.title }));
    }));
  }
  const mapping = new Map();
  for (const page of manifest) {
    const t = readJSON(path.join(base, `translations/${page.id}.json`));
    const title = t.title.replace(/[:/\\?*"<>|]/g, ' ');
    mapping.set(page.path.slice(0, -3), { title, path: `projects/${page.project}/${title}` });
  }
  if (new Set([...mapping.values()].map(x => x.path)).size !== manifest.length) throw new Error('Translation title collision');
  const relink = text => text.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, (all, target) => mapping.has(target) ? `[[${mapping.get(target).path}|${mapping.get(target).title}]]` : target.endsWith('/index') ? `[[${target}|${target.split('/').at(-2)}]]` : all);
  for (const page of manifest) {
    const t = readJSON(path.join(base, `translations/${page.id}.json`));
    const renamed = mapping.get(page.path.slice(0, -3));
    const props = { ...page.props, project: page.project, aliases: [...new Set([page.title, ...(page.props.aliases ?? [])])], related: (page.props.related ?? []).map(relink) };
    atomicWrite(path.join(vault, `${renamed.path}.md`), renderPage(props, renamed.title, relink(t.content)));
  }
  // Only remove the obsolete files in this newly created presentation copy.
  for (const page of manifest) if (!mapping.has(page.path.slice(0, -3)) || `${mapping.get(page.path.slice(0, -3)).path}.md` !== page.path) fs.unlinkSync(path.join(vault, page.path));
  for (const project of [...new Set(manifest.map(p => p.project))]) {
    atomicWrite(path.join(vault, `projects/${project}/index.md`), `# ${project}\n\n${[...mapping.values()].filter(p => p.path.startsWith(`projects/${project}/`)).map(p => `- [[${p.path}|${p.title}]]`).join('\n')}\n`);
  }
  atomicWrite(path.join(vault, 'index.md'), `# 知识库\n\n${[...new Set(manifest.map(p => p.project))].map(p => `- [[projects/${p}/index|${p}]]`).join('\n')}\n`);
  const appFile = path.join(vault, '.obsidian/app.json');
  atomicWrite(appFile, json({ ...(fs.existsSync(appFile) ? readJSON(appFile) : {}), showInlineTitle: false }));
  save('migration.json', { vault, pages: manifest.length, mapping: [...mapping], baselinePreserved: true });
  const traces = [];
  const output = await answer(root, 'default', vault, 'fencing token 应该由谁校验，随机 UUID 能替代它吗？', { project: '分布式系统', timeout: 300000, onTrace: v => traces.push(v) });
  save('answer.json', output); save('trace/answer.json', traces);
  console.log(json({ stage: 'finished', vault, answer: output.answer }));
} finally { delete process.env[config.apiKeyEnv]; input.close(); }
