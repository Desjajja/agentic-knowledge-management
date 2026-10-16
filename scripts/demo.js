import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-demo-'));
const cli = fileURLToPath(new URL('../bin/akm.js', import.meta.url));
function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: os.tmpdir(), env: { ...process.env, AKM_HOME: root }, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout).data;
}
try {
  run(['init']);
  const input = path.join(root, 'items.json');
  fs.writeFileSync(input, JSON.stringify({ items: [{ project: '项目 Alpha', title: '同步架构', content: '服务端负责最终同步状态，客户端保留临时缓存。', tags: ['sync'], aliases: ['server sync'] }] }));
  const create = run(['proposal', 'create', '--input', input]);
  console.log('新增提案:', create.items.map(i => ({ label: i.label, title: i.title, project: i.project, tags: i.tags })));
  run(['proposal', 'apply', create.id, '--revision', create.revision, '--items', '1']);
  console.log('首次检索:', run(['query', '--query', 'server sync']).results.map(r => r.citation));
  fs.writeFileSync(input, JSON.stringify({ items: [{ action: 'update', target: 'projects/项目 Alpha/同步架构.md', project: '项目 Alpha', title: '同步架构', content: '服务端负责最终同步状态。客户端通过事件版本号过滤过期更新。', tags: ['sync', 'versioning'] }] }));
  const update = run(['proposal', 'create', '--input', input]);
  run(['proposal', 'apply', update.id, '--revision', update.revision, '--items', '1']);
  const q = run(['query', '--query', '过滤过期更新']);
  console.log('修改后检索:', q.results.map(r => ({ citation: r.citation, line: r.snippet.startLine, excerpt: r.snippet.text })));
  const migrated = `${root}-moved`;
  fs.renameSync(root, migrated);
  try {
    const result = spawnSync(process.execPath, [cli, 'query', '--query', '版本号', '--root', migrated, '--json'], { cwd: os.tmpdir(), encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    console.log('整体目录迁移后:', JSON.parse(result.stdout).data.results.map(r => r.citation));
  } finally { fs.rmSync(migrated, { recursive: true, force: true }); }
  console.log('完成。演示使用临时知识库，未修改 ~/.akm，无模型密钥要求。');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
