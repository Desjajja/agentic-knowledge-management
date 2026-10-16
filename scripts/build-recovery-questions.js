// Questions are labeled from original source concepts before inspecting results.
import fs from 'node:fs';
import path from 'node:path';
const out = path.resolve('artifacts/recovery-validation-2026-10-15');
const groups = [
 ['ds-s1', '分布式系统', [
  ['把数据库叫 CP 或 AP 为什么太粗糙？', ['CAP', '分区']],
  ['CAP 里的 availability 与日常 SLA 可用率是不是同一个概念？', ['可用', '响应']],
  ['网络没分区时还需要考虑一致性与延迟的取舍吗？', ['延迟', '一致性']],
  ['CP/AP labels versus practical database latency guarantees', ['CAP', '延迟']],
 ]],
 ['ds-s2', '分布式系统', [
  ['进程停顿超过租约期限，为什么拿过锁的客户端仍可能写坏数据？', ['租约', '停顿']],
  ['fencing token 必须由谁校验，才能挡住过期持锁者？', ['token', '存储']],
  ['为了效率加锁和为了正确性加锁，对锁失效的容忍有何不同？', ['效率', '正确性']],
  ['单调递增令牌和一个仅仅不递减的令牌，区别在哪里？', ['递增', '令牌']],
 ]],
 ['ds-s3', '分布式系统', [
  ['线性一致性怎样约束真实时间先后？', ['线性', '时间']],
  ['寄存器读写的 linearizability 是什么？', ['读', '写']],
  ['读者在一次写完成之后再读取，允许看见旧值吗？', ['写', '读']],
 ]],
 ['ds-s4', '分布式系统', [
  ['可串行化是否保证事务按照真实时间顺序排列？', ['串行', '时间']],
  ['serializability 与 strict serializability 的保证有何不同？', ['串行', '时间']],
  ['事务执行有重叠，为什么结果仍可以等价于串行执行？', ['事务', '串行']],
 ]],
 ['ds-s5', '分布式系统', [
  ['两个医生分别看到对方值班然后同时退出，快照隔离能防止吗？', ['写偏', '快照']],
  ['snapshot isolation 为什么还可能出现 write skew？', ['写偏', '快照']],
  ['快照隔离中的并发写冲突检查能防住所有可串行化异常吗？', ['冲突', '串行']],
 ]],
 ['ds-s6', '分布式系统', [
  ['严格可串行化对不重叠事务的实时顺序有何约束？', ['事务', '时间']],
  ['strong serializability 与 linearizability 怎样联系起来？', ['串行', '线性']],
  ['严格可串行化能否把整个数据库看成一个线性一致对象？', ['数据库', '对象']],
 ]],
 ['music-triads', '音乐理论', [
  ['大三和弦和小三和弦的三度结构分别是什么？', ['三度', '三和弦']],
  ['增三和弦和减三和弦怎样区分？', ['增', '减']],
  ['三和弦的根音、三音、五音分别指什么？', ['根音', '三音']],
  ['属七和弦由哪种三和弦与哪种七度构成？', ['七', '大三']],
  ['half-diminished seventh 与 fully diminished seventh 的差别？', ['半减', '减七']],
  ['罗马数字分析中大写与小写通常怎样表达和弦性质？', ['大写', '小写']],
 ]],
 ['music-inversion', '音乐理论', [
  ['音级集合的 TnI 反演怎样计算？', ['反演', 'n']],
  ['音级反演与通常的和弦低音转位是不是一回事？', ['音级', '反演']],
  ['反演时围绕 0—6 轴反射和移调的顺序是什么？', ['反射', '移调']],
  ['判断两个音级集合是否通过 TnI 关联，可以检查什么和？', ['和', 'n']],
  ['Debussy 沉没的教堂的两个片段，音程内容相同但怎样排列？', ['音程', '排列']],
  ['TnI 中的 n 表示什么，怎样由对应音级推出？', ['音级', 'n']],
 ]],
 ['music-intervals', '音乐理论', [
  ['音程的度数与性质分别怎样判断？', ['音程', '性质']],
  ['完全音程和大小音程有哪些类别？', ['完全', '音程']],
  ['音程转位以后度数相加等于多少？', ['转位', '九']],
  ['大三度转位后变成什么音程？', ['小六度', '转位']],
  ['复音程与单音程如何区分？', ['复音程', '单音程']],
 ]],
 ['music-scales', '音乐理论', [
  ['大调音阶的全音半音排列是什么？', ['全', '半']],
  ['调号中的升号与降号按什么顺序出现？', ['升号', '降号']],
  ['如何从升号调号推断大调主音？', ['升号', '主音']],
  ['怎么根据最后一个降号或倒数第二个降号识别大调？', ['降号', '大调']],
 ]],
 ['stats-location', '统计学', [
  ['含有很大离群值的数据，用均值还是中位数描述中心更稳健？', ['中位数', '异常']],
  ['重尾分布的均值为什么可能不是好位置估计？', ['均值', '尾']],
  ['trimmed mean 与 winsorized mean 有何差别？', ['截尾', '温莎']],
  ['直方图双峰时用单一平均数概括会掩盖什么？', ['峰', '位置']],
  ['mean median mode 三种位置指标有什么区别？', ['均值', '中位数']],
 ]],
 ['stats-scale', '统计学', [
  ['标准差与方差之间是什么关系？', ['标准差', '方差']],
  ['四分位距 IQR 如何计算？', ['四分位', '75']],
  ['MAD 为什么比标准差更不容易受异常值影响？', ['中位数', '绝对']],
  ['range 只依赖哪两个观测值，为什么对极端值敏感？', ['最大', '最小']],
  ['重尾数据应该考虑哪些稳健尺度估计？', ['稳健', 'MAD']],
 ]],
];
const questions = [];
for (const [source, domain, cases] of groups) for (const [query, requiredConcepts] of cases) {
  questions.push({ id: `q${String(questions.length + 1).padStart(2,'0')}`, query, expectedSources: [source], expectedDomain: domain, requiredConcepts, split: questions.length % 2 ? 'holdout' : 'development', answerTest: [0, 5, 11, 21, 27, 44].includes(questions.length) });
}
for (const query of ['鲸鱼迁徙时怎样导航？', '意大利烩饭怎么控制水量？', '黑洞霍金辐射的温度公式是什么？', '苹果树嫁接应该选几月份？', '法国大革命的财政背景是什么？', '电脑显卡驱动怎么升级？', '糖尿病的诊断标准是什么？', '月球引起海洋潮汐的原理是什么？', 'quasarzygomatic987654']) {
  questions.push({ id: `q${String(questions.length + 1).padStart(2,'0')}`, query, expectedSources: [], negative: true, split: questions.length % 2 ? 'holdout' : 'development', answerTest: query.includes('鲸鱼') || query.includes('quasar') });
}
fs.writeFileSync(path.join(out, 'questions.json'), JSON.stringify(questions, null, 2));
console.log(JSON.stringify({ questions: questions.length, positive: questions.filter(q => !q.negative).length, negative: questions.filter(q => q.negative).length }));
