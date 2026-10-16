import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const output = path.resolve(process.argv[2]);
const calls = JSON.parse(fs.readFileSync(path.join(output, 'model-calls.json')));
const read = file => fs.existsSync(path.join(output, file)) ? JSON.parse(fs.readFileSync(path.join(output, file))) : null;
const median = values => {
  const a = values.filter(Number.isFinite).sort((a,b) => a-b);
  return a.length ? (a[Math.floor((a.length-1)/2)]+a[Math.ceil((a.length-1)/2)])/2 : null;
};
function usage(runs) {
  const complete = runs.length > 0 && runs.every(r => r.usageComplete);
  return {
    usageComplete: complete,
    knownTotalTokens: runs.reduce((n,r) => n+(r.knownUsage?.totalTokens??0),0),
    knownPromptTokens: runs.reduce((n,r) => n+(r.knownUsage?.input??0)+(r.knownUsage?.cacheRead??0)+(r.knownUsage?.cacheWrite??0),0),
    modelRequests: runs.reduce((n,r) => n+r.requestCount,0),
    tools: runs.reduce((n,r) => n+r.tools.length,0),
    promptTokens: complete ? runs.reduce((n,r) => n+r.usage.input+r.usage.cacheRead+r.usage.cacheWrite,0) : null,
    totalTokens: complete ? runs.reduce((n,r) => n+r.usage.totalTokens,0) : null,
  };
}
const rows = [];
for (const question of ['q01','q03']) for (let repeat=1; repeat<=5; repeat++) for (const strategy of ['A','B','C']) {
  const stage = `abc-${question}-${repeat}-${strategy}`;
  const data = read(`abc/${stage}.json`), failure = read(`failures/${stage}.json`);
  const runs = calls.filter(r => r.stage === stage || r.stage.startsWith(stage+'-retry'));
  rows.push({stage,strategy,question,repeat,status:data?'answer_returned':failure?'failed':'pending',failure:failure?.code??null,elapsedMs:data?.elapsedMs??null,modelElapsedMs:runs.length?runs.reduce((n,r)=>n+r.elapsedMs,0):null,...usage(runs)});
}
const stats = {};
for (const strategy of ['A','B','C']) {
  const selected = rows.filter(r=>r.strategy===strategy), returned = selected.filter(r=>r.status==='answer_returned');
  stats[strategy] = {
    planned: selected.length, returned: returned.length, failed: selected.filter(r=>r.status==='failed').length, pending:selected.filter(r=>r.status==='pending').length,
    // Performance comparison excludes failed tasks; denominators and all-attempt cost are explicit.
    promptTokensMedian:median(returned.map(r=>r.promptTokens)),totalTokensMedian:median(returned.map(r=>r.totalTokens)),elapsedMsMedian:median(returned.map(r=>r.elapsedMs)),modelRequestsMedian:median(returned.map(r=>r.modelRequests)),toolCallsMedian:median(returned.map(r=>r.tools)),
    allAttemptCost:usage(calls.filter(r=>r.stage.startsWith('abc-') && new RegExp(`-${strategy}(?:-retry\\d+)?$`).test(r.stage))),
    byQuestion:Object.fromEntries(['q01','q03'].map(q=>{const s=selected.filter(r=>r.question===q),a=s.filter(r=>r.status==='answer_returned');return [q,{planned:s.length,returned:a.length,failed:s.filter(r=>r.status==='failed').length,promptTokensMedian:median(a.map(r=>r.promptTokens)),elapsedMsMedian:median(a.map(r=>r.elapsedMs))}];})),
  };
}
const corpusHashes = {};
for (const label of ['english','chinese']) {
  const file=path.join(output,label,'corpus.json');
  if(fs.existsSync(file)) corpusHashes[label]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
const completeTriples = rows.filter(r=>r.strategy==='A' && rows.filter(v=>v.question===r.question&&v.repeat===r.repeat).every(v=>v.status==='answer_returned')).map(r=>({question:r.question,repeat:r.repeat}));
const pairedStats = Object.fromEntries(['A','B','C'].map(strategy=>{const selected=rows.filter(r=>r.strategy===strategy&&completeTriples.some(t=>t.question===r.question&&t.repeat===r.repeat));return [strategy,{samples:selected.length,promptTokensMedian:median(selected.map(r=>r.promptTokens)),elapsedMsMedian:median(selected.map(r=>r.elapsedMs))}];}));
const summary = {corpusHashes,sessions:calls.length,http200:calls.filter(r=>r.httpStatus===200).length,completedSessions:calls.filter(r=>r.status==='completed').length,...usage(calls),failedSessions:calls.filter(r=>r.status!=='completed').map(r=>({stage:r.stage,status:r.status,kind:r.failureKind})),answers:Object.fromEntries(['english','chinese'].map(l=>[l,fs.existsSync(path.join(output,l))?fs.readdirSync(path.join(output,l)).filter(f=>/^q\d+\.json$/.test(f)).length:0])),abc:{rows,stats,paired:{completeTriples,stats:pairedStats},comparison:Object.fromEntries(['A','B'].map(base=>[base,{promptReduction:stats.C.promptTokensMedian&&stats[base].promptTokensMedian?1-stats.C.promptTokensMedian/stats[base].promptTokensMedian:null,latencyReduction:stats.C.elapsedMsMedian&&stats[base].elapsedMsMedian?1-stats.C.elapsedMsMedian/stats[base].elapsedMsMedian:null}]))},note:'Prompt tokens include input+cacheRead+cacheWrite. Missing usage is null. Performance medians cover returned answers only, not a claim of correctness. Failed/pending denominators and all-attempt cost are included. Ten planned observations per strategy across two questions; no stable p95 claim. HTTP success does not score quality; rejected citations may follow completed model sessions.'};
fs.writeFileSync(path.join(output,'performance-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({...summary,abc:{stats,comparison:summary.abc.comparison}},null,2));
