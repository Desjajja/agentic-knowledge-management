import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, check, component, contentHash, hash, id, json, listFiles, pages, projects, readJSON, readPage, renderPage, revision, safe } from './storage.js';
import { assertReadable, commit, withLock } from './transaction.js';
import { fidelityIssues } from './source.js';
import { domainList } from './domain.js';

const proposalPath = proposalId => `.vault-meta/proposals/${component(proposalId, 'proposal ID')}.json`;
function strings(value, field) {
  check(value === undefined || (Array.isArray(value) && value.every(x => typeof x === 'string' && x.trim() && x.length < 500)), `${field} must be a string array`);
  return [...new Set(value ?? [])];
}
function normalizeItem(raw, label, vault) {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'Invalid item');
  const action = raw.action ?? 'create';
  check(['create', 'update'].includes(action), 'Action must be create or update');
  const domain = component(raw.domain ?? raw.project, 'domain');
  const title = component(raw.title, 'title');
  check(typeof raw.content === 'string' && raw.content.trim() && Buffer.byteLength(raw.content) <= 1024 * 1024, 'Content is required (max 1 MiB)');
  const target = action === 'create' ? `projects/${domain}/${title}.md` : raw.target;
  check(typeof target === 'string' && target.startsWith(`projects/${domain}/`) && target.endsWith('.md') && path.basename(target) !== 'index.md', 'Target must be a knowledge page in its domain');
  safe(vault, target);
  check(action === 'create' ? !fs.existsSync(safe(vault, target)) : fs.existsSync(safe(vault, target)), `Target does not match ${action}: ${target}`, 'TARGET_EXISTS');
  const sources = raw.sources ?? [{ kind: 'manual', name: title, content: raw.content }];
  check(Array.isArray(sources) && sources.length > 0 && sources.length <= 50, 'At least one source is required');
  for (const source of sources) {
    check(source && ['manual', 'document', 'conversation'].includes(source.kind), 'Invalid source kind');
    check(typeof source.name === 'string' && typeof source.content === 'string' && source.content.length > 0 && Buffer.byteLength(source.content) <= 2 * 1024 * 1024, 'Invalid source (max 2 MiB)');
  }
  return { label, id: id('item'), action, domain, project: domain, title, target, content: raw.content.trim(), tags: strings(raw.tags, 'tags').map(x => x.replace(/^#/, '')), aliases: strings(raw.aliases, 'aliases'), related: strings(raw.related, 'related'), sources, state: 'proposed' };
}
function snapshot(vault, items) {
  const expected = {};
  for (const item of items) {
    for (const p of [item.target, `projects/${item.domain}/project.json`, `projects/${item.domain}/index.md`, 'index.md']) expected[p] = contentHash(safe(vault, p));
  }
  return expected;
}
export function createProposal(vault, input, { expected = {} } = {}) {
  check(Array.isArray(input.items) && input.items.length > 0 && input.items.length <= 50, 'items must contain 1–50 entries');
  return withLock(vault, () => {
    for (const [relative, digest] of Object.entries(expected)) check(contentHash(safe(vault, relative)) === digest, `Source context changed: ${relative}`, 'CONFLICT');
    const items = input.items.map((raw, i) => normalizeItem(raw, i + 1, vault));
    check(new Set(items.map(i => i.target)).size === items.length, 'Multiple items target the same page; merge them first');
    const proposal = { schema: 1, id: id('proposal'), created: new Date().toISOString(), items, expected: snapshot(vault, items), receipts: [] };
    proposal.revision = revision(proposal);
    atomicWrite(safe(vault, proposalPath(proposal.id)), json(proposal));
    return inspectProposal(vault, proposal.id, { locked: true });
  });
}
export function getProposal(vault, proposalId) {
  const proposal = readJSON(safe(vault, proposalPath(proposalId)));
  check(proposal.revision === revision(proposal), 'Proposal was modified outside AKM', 'INVALID_STATE');
  return proposal;
}
export function inspectProposal(vault, proposalId, { locked = false } = {}) {
  if (!locked) return withLock(vault, () => inspectProposal(vault, proposalId, { locked: true }));
  const proposal = getProposal(vault, proposalId);
  const known = new Set(domainList(vault).map(p => p.name));
  const allPages = pages(vault);
    return { id: proposal.id, revision: proposal.revision, items: proposal.items.map(i => ({ label: i.label, state: i.state, title: i.title, content: i.content, domain: i.domain, project: i.domain, newDomain: !known.has(i.domain), newProject: !known.has(i.domain), tags: i.tags, aliases: i.aliases, related: i.related.map(link => {
    const resolved = resolveLink(vault, link, allPages, proposal.items.filter(x => x.state === 'proposed'));
    return { link, state: resolved ? (fs.existsSync(safe(vault, `${resolved}.md`)) ? 'existing' : 'proposed') : 'missing' };
  }), action: i.action, target: i.target, sourceCount: i.sources.length, issues: fidelityIssues(i.content, i.sources), before: i.action === 'update' && fs.existsSync(safe(vault, i.target)) ? readPage(vault, i.target).body : undefined })), receipts: proposal.receipts };
}
export function editProposal(vault, proposalId, expectedRevision, edits) {
  check(Array.isArray(edits) && edits.length > 0, 'edits must be a nonempty array');
  return withLock(vault, () => {
    const proposal = getProposal(vault, proposalId);
    check(proposal.revision === expectedRevision, 'Review the current proposal revision', 'STALE_REVISION');
    for (const edit of edits) {
      if (edit.op === 'merge') {
        check(Array.isArray(edit.labels) && edit.labels.length >= 2 && new Set(edit.labels).size === edit.labels.length && edit.labels.includes(edit.into), 'Merge requires unique labels including survivor');
        const merging = edit.labels.map(n => proposal.items.find(i => i.label === n));
        check(merging.every(i => i?.state === 'proposed'), 'Merge targets must be proposed');
        const survivor = merging.find(i => i.label === edit.into);
        check(merging.every(i => i.domain === survivor.domain), 'Cannot merge across domains', 'CROSS_DOMAIN');
        check(merging.every(i => i.action === 'create' || i.target === survivor.target), 'Merging separate archived pages is outside this iteration');
        check(typeof edit.content === 'string' && edit.content.trim(), 'Reviewed merged body is required');
        const sources = [...new Map(merging.flatMap(i => i.sources).map(s => [hash(json(s)), s])).values()];
        const removed = merging.filter(i => i !== survivor);
        const mergedTargets = new Set(merging.map(i => i.target.slice(0, -3)));
        const redirect = link => {
          const resolved = resolveLink(vault, link, pages(vault), proposal.items.filter(i => i.state === 'proposed'));
          return mergedTargets.has(resolved) ? `item:${survivor.label}` : link;
        };
        const related = [...new Set(merging.flatMap(i => i.related).map(redirect))].filter(l => l !== `item:${survivor.label}`);
        const redirected = new Map(proposal.items.filter(i => i.state === 'proposed' && !merging.includes(i)).map(i => [i, [...new Set(i.related.map(redirect))]]));
        const normalized = normalizeItem({ ...survivor, content: edit.content, sources, related, tags: [...new Set(merging.flatMap(i => i.tags))], aliases: [...new Set(merging.flatMap(i => i.aliases))] }, survivor.label, vault);
        Object.assign(survivor, normalized, { id: survivor.id });
        for (const i of removed) i.state = 'discarded';
        for (const [i, links] of redirected) i.related = links;
        continue;
      }
      const item = proposal.items.find(i => i.label === edit.label);
      check(item?.state === 'proposed', `Item [${edit.label}] is not editable`);
      const allowed = ['title', 'content', 'domain', 'project', 'tags', 'aliases', 'related', 'state'];
      check(edit.set && Object.keys(edit.set).every(k => allowed.includes(k)), 'Unsupported edit property');
      const candidate = { ...item, ...edit.set };
      check(['proposed', 'discarded', 'deferred'].includes(candidate.state), 'Invalid item state');
      if (item.action === 'update') check((candidate.domain ?? candidate.project) === item.domain, 'Moving an existing page between domains is outside MVP');
      const normalized = normalizeItem(candidate, item.label, vault);
      if (candidate.content !== item.content) normalized.sources.push({ kind: 'manual', name: 'User revision', content: candidate.content });
      Object.assign(item, normalized, { id: item.id, state: candidate.state });
      // Preserve earlier preconditions; never silently accept an external change.
      for (const [p, h] of Object.entries(snapshot(vault, [item]))) if (!Object.hasOwn(proposal.expected, p)) proposal.expected[p] = h;
    }
    const active = proposal.items.filter(i => i.state === 'proposed');
    check(new Set(active.map(i => i.target)).size === active.length, 'Duplicate active page targets');
    proposal.revision = revision(proposal);
    atomicWrite(safe(vault, proposalPath(proposalId)), json(proposal));
    return inspectProposal(vault, proposalId, { locked: true });
  });
}
export function resolveLink(vault, value, existing = pages(vault), proposed = []) {
  if (/^item:\d+$/.test(value)) return proposed.find(i => i.label === Number(value.slice(5)))?.target.slice(0, -3);
  let link = value.replace(/^\[\[/, '').replace(/\]\]$/, '');
  link = link.split('|')[0];
  check(!link.includes('#') && !link.includes('^'), 'MVP related links must reference whole pages');
  link = link.replace(/\.md$/, '');
  const candidates = [...new Set([...existing.map(p => p.path.slice(0, -3)), ...proposed.map(p => p.target.slice(0, -3)), ...projects(vault).map(p => `${p.path}/index`)])];
  const exact = candidates.filter(p => p === link);
  if (exact.length === 1) return exact[0];
  const matches = candidates.filter(p => p === `projects/${link}` || path.basename(p) === link);
  check(matches.length <= 1, `Ambiguous related page: ${value}`, 'AMBIGUOUS_LINK');
  return matches[0];
}
export function applyProposal(vault, proposalId, expectedRevision, labels, options = {}) {
  check(Array.isArray(labels) && labels.length > 0 && labels.every(Number.isSafeInteger) && new Set(labels).size === labels.length, 'Choose unique item labels');
  return withLock(vault, () => {
    const proposal = getProposal(vault, proposalId);
    // Repeated acknowledgement of exactly the same revision/items is idempotent.
    const prior = proposal.receipts.find(r => r.approvedRevision === expectedRevision && json([...r.labels].sort()) === json([...labels].sort()));
    if (prior) return { ...prior, replayed: true };
    check(proposal.revision === expectedRevision, 'Review the current proposal revision', 'STALE_REVISION');
    const selected = labels.map(n => proposal.items.find(i => i.label === n));
    check(selected.every(i => i?.state === 'proposed'), 'Selected item is missing, discarded or already applied');
    const writes = new Map();
    const expected = {};
    const existing = pages(vault);
    const put = (p, content) => {
      writes.set(p, content);
      expected[p] = Object.hasOwn(proposal.expected, p) ? proposal.expected[p] : contentHash(safe(vault, p));
    };
    const sourceRecords = [];
    for (const item of selected) {
      check(fidelityIssues(item.content, item.sources).length === 0, 'Proposal has unresolved source fidelity issues; review and edit before applying', 'FIDELITY_REVIEW');
      const links = item.related.map(l => {
        const target = resolveLink(vault, l, existing, selected);
        check(target, `Related page does not exist or is not selected: ${l}`, 'UNRESOLVED_LINK');
        const relative = `${target}.md`;
        if (!Object.hasOwn(expected, relative)) expected[relative] = Object.hasOwn(proposal.expected, relative) ? proposal.expected[relative] : contentHash(safe(vault, relative));
        const title = selected.find(p => p.target === relative)?.title ?? existing.find(p => p.path === relative)?.title ?? path.basename(target);
        return `[[${target}|${title}]]`;
      });
      const sourceLinks = [];
      for (const source of item.sources) {
        const bytes = Buffer.from(source.content);
        const digest = hash(bytes);
        const raw = `.raw/${digest}.txt`;
        const record = `sources/${digest}.txt`;
        if (!fs.existsSync(safe(vault, raw))) put(raw, bytes);
        else check(contentHash(safe(vault, raw)) === digest, 'Raw source integrity failure', 'INVALID_STATE');
        if (!fs.existsSync(safe(vault, record))) put(record, bytes);
        sourceLinks.push(digest);
        sourceRecords.push({ item: item.id, sourceId: digest, kind: source.kind, raw, support: source.support });
      }
      const old = item.action === 'update' ? readPage(vault, item.target) : null;
      const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
      const sourceIds = [...new Set([...array(old?.props.sources), ...array(old?.props.source_refs), ...sourceLinks].flatMap(value => String(value).match(/[a-f0-9]{64}/g) ?? []))];
      put(item.target, renderPage({ ...old?.props, id: old?.props.id ?? id('page'), domain: item.domain, project: item.domain, tags: item.tags, aliases: item.aliases, related: links, sources: sourceIds, source_refs: sourceIds.map(digest => `[${digest}](sources/${digest}.txt)`) }, item.title, item.content));
      item.state = 'applied';
    }
    const domainEntries = domainList(vault);
    for (const item of selected) if (!domainEntries.some(d => d.name === item.domain)) domainEntries.push({ id: id('domain'), name: item.domain, description: `知识领域：${item.domain}`, aliases: [] });
    put('.akm/domains.json', json({ schema: 1, domains: domainEntries }));
    const knownProjects = projects(vault);
    for (const project of [...new Set(selected.map(i => i.domain))]) {
      const manifestPath = `projects/${project}/project.json`;
      if (!fs.existsSync(safe(vault, manifestPath))) put(manifestPath, json({ schema: 1, id: id('project'), name: project, description: '' }));
      const oldIndexPath = `projects/${project}/index.md`;
      const oldIndex = fs.existsSync(safe(vault, oldIndexPath)) ? fs.readFileSync(safe(vault, oldIndexPath), 'utf8') : `# ${project}\n\n`;
      const additions = selected.filter(i => i.domain === project && i.action === 'create').map(i => `- [[${i.target.slice(0, -3)}|${i.title}]]`);
      put(oldIndexPath, `${oldIndex.trimEnd()}\n${additions.length ? `\n${additions.join('\n')}\n` : ''}`);
    }
    const newProjects = [...new Set(selected.map(i => i.project))].filter(n => !knownProjects.some(p => p.name === n));
    if (newProjects.length) {
      const index = fs.readFileSync(safe(vault, 'index.md'), 'utf8');
      put('index.md', `${index.trimEnd()}\n\n${newProjects.map(n => `- [[projects/${n}/index|${n}]]`).join('\n')}\n`);
    }
    const receiptId = id('receipt');
    put(`.akm/ledgers/${receiptId}.json`, json({ schema: 1, id: receiptId, proposalId, sources: sourceRecords, labels, approvedRevision: expectedRevision }));
    const receipt = { id: receiptId, labels, approvedRevision: expectedRevision, pages: selected.map(i => i.target), changed: [...writes.keys()] };
    proposal.receipts.push(receipt);
    for (const [p, content] of writes) if (Object.hasOwn(proposal.expected, p)) proposal.expected[p] = hash(content);
    proposal.revision = revision(proposal);
    put(proposalPath(proposalId), json(proposal));
    expected[proposalPath(proposalId)] = contentHash(safe(vault, proposalPath(proposalId)));
    const result = commit(vault, [...writes].map(([p, content]) => ({ path: p, content })), expected, options);
    return { ...receipt, operationId: result.operationId, revision: proposal.revision };
  });
}
export function showPage(vault, value) {
  return withLock(vault, () => {
    const link = resolveLink(vault, value);
    check(link, `Page not found: ${value}`, 'PAGE_NOT_FOUND');
    return readPage(vault, `${link}.md`);
  });
}
