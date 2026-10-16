import fs from 'node:fs';
import path from 'node:path';
import { json, resolveVault, pages } from '../src/storage.js';
const out=path.resolve('artifacts/recovery-validation-2026-10-15');
const read=name=>JSON.parse(fs.readFileSync(path.join(out,`${name}.json`)));
const average=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
const median=values=>{if(!values.length)return null;const a=values.slice().sort((a,b)=>a-b);return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;};
const adapters={};
for(const name of ['adapter','adapter-directed','adapter-contextual']) {
  const records=read(`${name}-results`);
  const arms=Object.fromEntries(['native-tool','skill-cli'].map(arm=>{
    const a=records.filter(r=>r.arm===arm),pos=a.filter(r=>r.expected),neg=a.filter(r=>!r.expected);
    return [arm,{runs:a.length,positive:pos.length,triggeredPositive:pos.filter(r=>r.triggered).length,negative:neg.length,triggeredNegative:neg.filter(r=>r.triggered).length,failures:a.filter(r=>!r.ok).length,medianElapsedMs:median(a.map(r=>r.elapsedMs))}];
  }));
  const pairs=[];
  for(const a of records.filter(r=>r.arm==='native-tool')) {
    const b=records.find(r=>r.arm==='skill-cli'&&r.id===a.id&&r.repeat===a.repeat);
    if(!b||!a.ok||!b.ok||!a.triggered||!b.triggered)continue;
    const primary=r=>r.models.every(m=>m==='LongCat-Flash-Chat');
    const usage=r=>r.usage.every(u=>Number.isFinite(u.totalTokens))?r.usage.reduce((n,u)=>n+u.totalTokens,0):null;
    pairs.push({id:a.id,repeat:a.repeat,samePrimaryModel:primary(a)&&primary(b),nativeTokens:usage(a),skillTokens:usage(b),nativeElapsedMs:a.elapsedMs,skillElapsedMs:b.elapsedMs,nativeToolCalls:a.tools.length,skillToolCalls:b.tools.length});
  }
  const matched=pairs.filter(p=>p.samePrimaryModel&&p.nativeTokens!==null&&p.skillTokens!==null);
  adapters[name]={arms,pairs,matchedSameModelPairs:matched.length,matchedMeans:matched.length?{nativeTokens:average(matched.map(r=>r.nativeTokens)),skillTokens:average(matched.map(r=>r.skillTokens)),nativeElapsedMs:average(matched.map(r=>r.nativeElapsedMs)),skillElapsedMs:average(matched.map(r=>r.skillElapsedMs)),nativeToolCalls:average(matched.map(r=>r.nativeToolCalls)),skillToolCalls:average(matched.map(r=>r.skillToolCalls))}:null};
}
const runFiles=fs.readdirSync(path.join(out,'runs')).filter(f=>/^(ingest-|answer-|probe-|natural-supplement-tool\.json)/.test(f));
const runs=runFiles.map(f=>JSON.parse(fs.readFileSync(path.join(out,'runs',f))));
const attempts=runs.flatMap(r=>r.calls??[]).flatMap(c=>c.requests);
const summary={date:'2026-10-15',testVault:path.join(out,'test-akm/vaults/test-vault'),corpus:{sources:read('sources').filter(s=>s.ok).length,pages:pages(resolveVault(path.join(out,'test-akm')).dir).length},compatibility:read('compatibility'),retrieval:read('retrieval-evaluation').runs.map(({perQuery,...r})=>r),answerReview:read('answer-review').totals,workflowChecks:{total:read('workflow-checks').length,passed:read('workflow-checks').filter(c=>c.ok).length},liveAttempts:{total:attempts.length,recoveryActions:attempts.filter(r=>r.recovery&&r.recovery!=='stop').length,modelCounts:Object.fromEntries([...new Set(attempts.map(r=>r.model))].map(m=>[m,attempts.filter(r=>r.model===m).length]))},adapters,productionCheck:read('production-check')};
fs.writeFileSync(path.join(out,'summary.json'),json(summary));
console.log(json({corpus:summary.corpus,workflowChecks:summary.workflowChecks,adapters}));
