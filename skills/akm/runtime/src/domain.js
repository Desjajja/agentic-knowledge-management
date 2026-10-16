import fs from 'node:fs';
import { atomicWrite, check, component, id, json, pages, projects, readJSON, safe } from './storage.js';

const registryPath = '.akm/domains.json';
function normalize(raw) {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'Invalid domain');
  const name = component(raw.name, 'domain name');
  check(typeof raw.description === 'string' && raw.description.trim() && raw.description.length <= 4000, 'Domain description is required');
  return { id: raw.id ?? id('domain'), name, description: raw.description.trim(), aliases: [...new Set((raw.aliases ?? []).map(String).filter(Boolean))] };
}
function registry(vault) {
  const file = safe(vault, registryPath);
  if (fs.existsSync(file)) return readJSON(file);
  const domains = projects(vault).map(p => ({ id: p.id ?? id('domain'), name: p.name, description: p.description ?? '', aliases: p.aliases ?? [] }));
  return { schema: 1, domains };
}
export function domainList(vault) {
  const counts = new Map();
  for (const page of pages(vault)) counts.set(page.domain, (counts.get(page.domain) ?? 0) + 1);
  return registry(vault).domains.map(d => ({ ...d, documentCount: counts.get(d.name) ?? 0 }));
}
export function domainShow(vault, name) {
  const found = domainList(vault).find(d => d.name === name || d.id === name || d.aliases?.includes(name));
  check(found, `Domain not found: ${name}`, 'DOMAIN_NOT_FOUND');
  return found;
}
export function domainSearch(vault, query) {
  check(typeof query === 'string' && query.trim(), 'Domain search query is required');
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return domainList(vault).map(d => ({ ...d, score: terms.reduce((n, t) => n + (JSON.stringify(d).toLowerCase().includes(t) ? 1 : 0), 0) })).filter(d => d.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
export function ensureDomain(vault, raw) {
  const item = normalize(raw);
  const current = registry(vault);
  const existing = current.domains.find(d => d.name === item.name || d.id === item.id);
  if (existing) {
    check(existing.description === item.description, `Domain already exists with a different description: ${item.name}`, 'DOMAIN_CONFLICT');
    return existing;
  }
  const next = { ...current, domains: [...current.domains, item] };
  atomicWrite(safe(vault, registryPath), json(next));
  return item;
}
export function writeDomains(vault, domains) {
  atomicWrite(safe(vault, registryPath), json({ schema: 1, domains: domains.map(normalize) }));
}
