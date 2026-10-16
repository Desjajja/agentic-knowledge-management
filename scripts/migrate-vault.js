#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { atomicWrite, id, json, listFiles, readJSON, readPage, renderPage, rootDir, safe } from '../src/storage.js';
import { writeDomains } from '../src/domain.js';

function migrate(vault) {
  const domains = [];
  const projectFiles = listFiles(vault, 'projects').filter(file => file.endsWith('/project.json'));
  for (const file of projectFiles) {
    const manifest = readJSON(safe(vault, file));
    domains.push({ id: manifest.id ?? id('domain'), name: manifest.name, description: manifest.description || `知识领域：${manifest.name}`, aliases: manifest.aliases ?? [] });
  }
  for (const file of listFiles(vault, 'projects').filter(file => file.endsWith('.md') && path.basename(file) !== 'index.md')) {
    const page = readPage(vault, file);
    const props = { ...page.props, domain: page.props.domain ?? page.props.project ?? page.domain };
    delete props.project;
    if (Array.isArray(props.sources)) props.source_refs = props.sources.map(value => String(value).replace(/^\[\[sources\//, '').replace(/\]\]$/, ''));
    if (Array.isArray(props.source_refs)) props.source_refs = props.source_refs.map(value => String(value).replace(/^source:/, ''));
    delete props.sources;
    atomicWrite(safe(vault, file), renderPage(props, page.title, page.body));
  }
  const sourceDir = safe(vault, 'sources');
  const target = safe(vault, 'sources');
  fs.mkdirSync(target, { recursive: true });
  const rawDir = safe(vault, '.raw');
  if (fs.existsSync(rawDir)) for (const file of fs.readdirSync(rawDir)) {
    const from = path.join(rawDir, file);
    if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(target, `${file.replace(/\.txt$/, '')}.txt`));
  }
  fs.rmSync(safe(vault, '.akm/sources'), { recursive: true, force: true });
  for (const file of ['index.md']) if (fs.existsSync(safe(vault, file))) fs.renameSync(safe(vault, file), safe(vault, '.akm/index.md'));
  for (const file of listFiles(vault, 'projects').filter(file => path.basename(file) === 'index.md')) {
    const target = safe(vault, `.akm/indexes/${file.slice('projects/'.length)}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(safe(vault, file), target);
  }
  writeDomains(vault, domains);
  const manifestPath = safe(vault, 'vault.json');
  const manifest = readJSON(manifestPath);
  atomicWrite(manifestPath, json({ ...manifest, schema: 2 }));
  return { vault: manifest.name, domains: domains.map(d => d.name), pages: listFiles(vault, 'projects').filter(f => f.endsWith('.md')).length, graphSourcesRemoved: true };
}

const vault = rootDir(process.argv[2] ?? process.env.AKM_VAULT);
if (!fs.existsSync(safe(vault, 'vault.json'))) throw new Error(`Expected a Vault directory: ${vault}`);
process.stdout.write(`${JSON.stringify(migrate(vault), null, 2)}\n`);
