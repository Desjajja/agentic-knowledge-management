import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { resolveVault, json, pages, safe, hash } from '../src/storage.js';
import { createProposal, getProposal, inspectProposal, editProposal, applyProposal, showPage } from '../src/knowledge.js';
import { retrieveEvidence } from '../src/evidence.js';
import { knowledgeTools } from '../src/pi-tools.js';
const out = path.resolve('artifacts/recovery-validation-2026-10-15');
const root = path.join(out, 'workflow-akm');
if (!fs.existsSync(root)) fs.cpSync(path.join(out, 'test-akm'), root, { recursive: true });
const vault = resolveVault(root).dir, checks = [];
const check = async (id, fn) => { try { const result = await fn(); checks.push({ id, ok: true, result }); } catch (e) { checks.push({ id, ok: false, code: e.code, message: e.message }); } fs.writeFileSync(path.join(out,'workflow-checks.json'),json(checks)); };
let conversation, update;
await check('conversation-review-reject-unsupported-expansion', () => {
  const pending = JSON.parse(fs.readFileSync(path.join(out,'conversation-pending.json')));
  const p = getProposal(vault,pending.id);
  assert(p.items[0].content.includes('25 分钟') && p.items[0].content.includes('未被采纳'));
  conversation = editProposal(vault,p.id,p.revision,[{label:2,set:{state:'discarded'}}]);
  assert.equal(conversation.items[1].state,'discarded');
  return { rejectedLabel: 2, reason: '对话仅确认练习安排，没有提供第二条扩写的音乐知识，且 item:0 无效。' };
});
await check('conversation-commit-selected-only', () => {
  const receipt = applyProposal(vault,conversation.id,conversation.revision,[1]);
  assert.equal(receipt.pages.length,1);
  assert(!fs.existsSync(safe(vault,conversation.items[1].target)));
  return receipt;
});
await check('conversation-retrieve-final-decision', () => {
  const found = retrieveEvidence(vault,'每天练习多少分钟，是否购买新钢琴？',{domain:'音乐理论',k:3});
  const p=found.results.find(p=>p.title.includes('每日25分钟'));
  assert(p?.content.includes('暂不购买新钢琴'));
  assert(p.content.includes('两个小时') && p.content.includes('取消'));
  return {titles:found.results.map(p=>p.title)};
});
await check('update-review-preserves-existing-facts', () => {
  const pending=JSON.parse(fs.readFileSync(path.join(out,'update-pending.json'))),p=getProposal(vault,pending.id);
  assert(p.items[0].content.includes('增五度')&&p.items[0].content.includes('第一转位最低音为 E'));
  const old=showPage(vault,p.items[0].target);
  assert.equal(hash(fs.readFileSync(safe(vault,old.path))),p.expected[old.path]);
  update=createProposal(vault,{items:p.items},{expected:{[old.path]:old.hash}});
  return { refreshedProposal:update.id,reason:'对话写入改变了共享索引；确认原知识页未变后重新提案。' };
});
let receipt;
await check('update-commit-and-source-links', () => {
  receipt=applyProposal(vault,update.id,update.revision,[1]);
  const p=showPage(vault,update.items[0].target);
  assert(p.body.includes('第一转位最低音为 E'));
  for(const ref of p.props.source_refs){assert(/^\[[a-f0-9]{64}\]\(sources\/[a-f0-9]{64}\.txt\)$/.test(ref));const digest=ref.match(/[a-f0-9]{64}/)[0];assert(fs.existsSync(safe(vault,`sources/${digest}.txt`)));}
  return { sources:p.props.sources.length, refs:p.props.source_refs };
});
await check('repeated-commit-is-idempotent', () => {assert.equal(applyProposal(vault,update.id,update.revision,[1]).replayed,true);});
await check('updated-facts-retrievable', () => {const r=retrieveEvidence(vault,'C大三和弦第一转位最低音是什么？',{domain:'音乐理论',k:3});assert(r.results.some(p=>p.content.includes('第一转位最低音为 E')));return r.results.map(p=>p.title);});
await check('cross-domain-related-allowed', () => {
  const music=pages(vault).find(p=>p.domain==='音乐理论'),stats=pages(vault).find(p=>p.domain==='统计学');
  const p=createProposal(vault,{items:[{title:'练习数据统计的跨领域关联',domain:'音乐理论',content:'练习统计可关联统计学知识；此页仅验证同Vault跨领域链接。',related:[stats.path],tags:['测试'],aliases:[]}]});
  applyProposal(vault,p.id,p.revision,[1]);assert(showPage(vault,p.items[0].target).props.related[0].includes(stats.path.slice(0,-3)));
});
await check('domain-retrieval-filter', () => {const r=retrieveEvidence(vault,'统计 音程 方差',{domain:'统计学',k:5});assert(r.results.length&&r.results.every(p=>p.domain==='统计学'));});
await check('unreviewed-proposal-never-creates-page', () => {const p=createProposal(vault,{items:[{title:'待审核测试条目',domain:'统计学',content:'未确认不能写入正式知识。'}]});assert(!fs.existsSync(safe(vault,p.items[0].target)));});
await check('external-edit-rejects-stale-proposal', () => {
  const target=update.items[0].target,p=createProposal(vault,{items:[{title:update.items[0].title,domain:'音乐理论',action:'update',target,content:showPage(vault,target).body+'\n审阅更新'}]});
  fs.appendFileSync(safe(vault,target),'\n外部编辑保留。\n');assert.throws(()=>applyProposal(vault,p.id,p.revision,[1]),{code:'CONFLICT'});assert(showPage(vault,target).body.includes('外部编辑保留'));
});
await check('aggregate-deduplicates-discovered-page', async () => {
  const p=pages(vault).find(p=>p.domain==='统计学'),[tool]=knowledgeTools(vault,{discovered:new Map([[p.path,p.hash]])});
  const r=await tool.execute('',{query:p.title,reads:[{path:p.path,sections:[1]},{path:p.path,sections:[1]}]});assert.equal(r.details.results.filter(r=>r.path===p.path).length,1);
});
console.log(json({passed:checks.filter(c=>c.ok).length,total:checks.length,checks}));
