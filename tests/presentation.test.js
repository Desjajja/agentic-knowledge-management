import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderPage, safe } from '../src/storage.js';
import { fixture, item, add } from './helpers.js';
import { showPage } from '../src/knowledge.js';
import { knowledgeTools } from '../src/pi-tools.js';

test('single H1 and readable project/index metadata', t => {
  const { vault } = fixture(t);
  const text = renderPage({}, '新标题', '# Old title\n\n# Old title\n\n## 保留章节\n正文');
  assert.equal(text.match(/^# /gm).length, 1);
  assert(text.includes('## 保留章节'));
  add(vault, [item()]);
  assert.equal(showPage(vault, '同步架构').props.project, 'Alpha');
  assert(fs.readFileSync(safe(vault, 'projects/Alpha/index.md'), 'utf8').includes('[[projects/Alpha/同步架构|同步架构]]'));
  assert.equal(JSON.parse(fs.readFileSync(safe(vault, '.obsidian/app.json'))).showInlineTitle, false);
});
test('knowledge tools bound reads, reject undiscovered and changed pages', async t => {
  const { vault } = fixture(t);
  add(vault, [item(), item({ project: 'Beta', title: '秘密', content: '同步架构', tags: [] })]);
  const [, search, read] = knowledgeTools(vault, { project: 'Alpha' });
  await assert.rejects(read.execute('', { path: 'projects/Beta/秘密.md' }), { code: 'PAGE_NOT_DISCOVERED' });
  const results = await search.execute('', { query: '同步架构' });
  assert(results.details.results.every(p => p.project === 'Alpha'));
  const page = results.details.results[0].path;
  const chunk = await read.execute('', { path: page, limit: 2 });
  assert.equal(chunk.details.content.length, 2);
  assert.equal(chunk.details.contentTruncated, true);
  fs.appendFileSync(safe(vault, page), '\n用户修改');
  await assert.rejects(read.execute('', { path: page }), { code: 'CONFLICT' });
});
