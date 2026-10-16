// Explicit review decisions after reading generated drafts against public sources.
// Restricted to the disposable validation vault. Original proposals/traces stay.
import fs from 'node:fs';
import path from 'node:path';
import { resolveVault, json, pages } from '../src/storage.js';
import { getProposal, editProposal, applyProposal, createProposal } from '../src/knowledge.js';
const out = path.resolve('artifacts/recovery-validation-2026-10-15');
const vault = resolveVault(path.join(out, 'test-akm')).dir;
const ledger = JSON.parse(fs.readFileSync(path.join(out, 'ingestion.json')));
const reviewFile = path.join(out, 'review-decisions.json');
const reviews = fs.existsSync(reviewFile) ? JSON.parse(fs.readFileSync(reviewFile)) : [];
for (const row of ledger.filter(r => r.ok)) {
  if (reviews.some(r => r.source === row.source && r.receipt)) continue;
  const proposal = getProposal(vault, row.proposal);
  if (proposal.items.every(i => i.state !== 'proposed')) {
    reviews.push({ source: row.source, proposal: proposal.id, notes: ['已经完成审核与提交；原始模型输出见 runs，修订内容见 proposal。'], receipt: proposal.receipts.at(-1) });
    fs.writeFileSync(reviewFile, json(reviews)); continue;
  }
  const edits = [], notes = [];
  for (const item of proposal.items) {
    let content = item.content, title = item.title;
    if (row.source === 'ds-s1') {
      content = '历史来源限定：以下软件行为是 Martin Kleppmann 2015-05-11 博文中的论述，不代表当前版本已经验证。\n\n' + content;
      notes.push('保留历史版本边界，避免以2015年软件行为代表当前版本。');
    }
    if (row.source === 'ds-s2') {
      content = '来源限定与争议：以下是 Martin Kleppmann 2016-02-08 的分析与建议；2016-02-09 更新提到 Salvatore 的反驳，作者仍坚持结论，且明确双方博文并未接受学术同行评审。有关 Redis 实现的陈述不能直接当作当前版本事实。\n\n' + content;
      if (item.label === 2) {
        content = content.replace('拒绝任何token小于等于当前最大值的请求', '拒绝 token 小于已处理最大值的陈旧请求；原文没有要求一律拒绝等值 token').replace('资源服务器必须主动检查并拒绝非递增的token请求', '资源服务器必须检查并拒绝 token 倒退（更小）的请求；锁服务每次授锁的 token 则必须严格递增');
        notes.push('纠正 lower→小于等于、非递增 的比较符强化。');
      }
    }
    if (row.source === 'ds-s3' && item.label === 2) {
      edits.push({ label: item.label, set: { state: 'discarded' } }); notes.push('拒绝重复条目及原文未给出的金融场景扩写。'); continue;
    }
    if (row.source === 'ds-s3' && item.label === 3) {
      content = content.replace('若操作 A 在真实时间中先于操作 B 完成', '若操作 A 在真实时间中完成后，操作 B 才开始');
      notes.push('纠正 RealTime：完成先于开始，而非只比较完成时间。');
    }
    if (row.source === 'music-inversion') {
      title = '音级集合反演与TnI变换';
      content = content.replaceAll('和弦转位（Chord inversion）', '音级集合反演（pitch-class inversion）').replaceAll('转位', '反演');
      content = '术语边界：本文讨论后调性音级集合的反演，不是以根音、三音、五音为低音区分的和弦转位。来源原题为 Inversion，采集器先前误加的 Chord inversion 标题不作为依据。\n\n' + content;
      notes.push('纠正采集标题与同名术语误导；图中的例子需查看原图，不将推导例子冒充原文。');
    }
    if (row.source === 'music-triads' && item.label === 2) {
      content = content.replace(/在自然小调中[^。]+。/, '原文的小调表同时含自然与升高第七级的用法：i、iv 为小三和弦，ii°、vii° 为减三和弦，III、V、VI、VII 为大三和弦；V、vii° 使用升高的第七级，不应把整张表称为严格的自然小调。');
      notes.push('纠正小调 ii° 大小写、vii 与VII混淆以及自然小调标签。');
    }
    if (row.source === 'music-triads' && item.label === 3) {
      content = content.replace('小调音阶上的i⁷、iv⁷为小七和弦，ii⁷为半减七，III⁷、VI⁷为大七，V⁷、VII⁷为属七，vii°⁷为减七和弦', '原文小调表中的 i⁷、iv⁷ 为小七和弦，ii⦰⁷ 为半减七，III⁷、VI⁷ 为大七，V⁷、VII⁷ 为属七，vii°⁷ 为减七和弦（表含升高第七级的用法）');
    }
    if (row.source === 'music-scales' && item.label === 3) content = content.replace('由七个全音（W）和半音（H）', '在一个八度内由七次级进（全音 W 或半音 H）');
    if (row.source === 'music-scales' && item.label === 5) content = content.replace('伊奥利亚调式（aeolian mode）', '爱奥利亚调式（Aeolian mode）').replace('由七个全音（W）和半音（H）', '在一个八度内由七次级进（全音 W 或半音 H）');
    if (row.source === 'stats-scale' && item.label === 3) content = content.replace('Tukey lambda 分布的极差限制在 (-1/λ, 1/λ)', 'Tukey lambda 分布的取值范围限制在 (-1/λ, 1/λ)，不是说样本极差属于此区间');
    if (content !== item.content || title !== item.title) edits.push({ label: item.label, set: { content, title } });
  }
  // Earlier independent drafts shared a stale domain index. Re-propose the
  // reviewed content against the current snapshot, without editing preconditions.
  let revised = createProposal(vault, { items: proposal.items });
  if (edits.length) revised = editProposal(vault, revised.id, revised.revision, edits);
  const selected = revised.items.filter(i => i.state === 'proposed').map(i => i.label);
  const receipt = applyProposal(vault, revised.id, revised.revision, selected);
  reviews.push({ source: row.source, proposal: proposal.id, refreshedProposal: revised.id, notes: [...new Set(notes)], edits, selected, receipt });
  fs.writeFileSync(reviewFile, json(reviews));
}
fs.writeFileSync(path.join(out, 'review-decisions.json'), json(reviews));
console.log(json({ reviewed: reviews.length, pages: pages(vault).length, corrections: reviews.filter(r => r.edits?.length).length }));
