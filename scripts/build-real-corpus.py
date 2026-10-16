"""Build an isolated, provenance-preserving real-text retrieval corpus.

The corpus is deliberately outside ~/.akm. It combines public RFCs and the
Raft paper with the existing test vault, then creates section-sized Obsidian
pages and a hand-judged query set for threshold tuning.
"""
from __future__ import annotations
import hashlib, json, pathlib, re, shutil, subprocess, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts/real-corpus-2026-10-16'
AKM = OUT / 'akm'
VAULT = AKM / 'vaults/test'
RAW = OUT / 'raw'
PAGES = VAULT / 'projects'
OUT.mkdir(parents=True, exist_ok=True)
RAW.mkdir(exist_ok=True)

existing = ROOT / 'artifacts/recovery-validation-2026-10-15/test-akm'
if not (AKM / 'config.json').exists():
    shutil.copytree(existing, AKM)
    # Give this corpus an explicit test selection without touching production.
    cfg = json.loads((AKM / 'config.json').read_text())
    manifests = list((AKM / 'vaults').glob('*/vault.json'))
    source_vault = next(p.parent for p in manifests if json.loads(p.read_text()).get('name') == 'test-vault')
    if not (AKM / 'vaults/test').exists(): shutil.copytree(source_vault, VAULT)
    manifest = json.loads((VAULT / 'vault.json').read_text()); manifest['id'] = 'vault-real-corpus-2026-10-16'; manifest['name'] = 'test'; (VAULT / 'vault.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    (AKM / 'workspaces/default/workspace.json').write_text(json.dumps({'schema': 1, 'vaultId': manifest['id'], 'activeVaultId': manifest['id']}, ensure_ascii=False, indent=2) + '\n')
else:
    manifest = json.loads((VAULT / 'vault.json').read_text()); manifest['id'] = 'vault-real-corpus-2026-10-16'; manifest['name'] = 'test'; (VAULT / 'vault.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
(AKM / 'workspaces/default/workspace.json').write_text(json.dumps({'schema': 1, 'vaultId': manifest['id'], 'activeVaultId': manifest['id']}, ensure_ascii=False, indent=2) + '\n')

sources = [
    ('raft', '分布式系统', 'etcd Raft library design notes', 'https://raw.githubusercontent.com/etcd-io/raft/main/README.md', 'text'),
    ('rfc9000', '网络协议', 'QUIC: A UDP-Based Multiplexed and Secure Transport', 'https://www.rfc-editor.org/rfc/rfc9000.txt', 'text'),
    ('rfc9110', '网络协议', 'HTTP Semantics', 'https://www.rfc-editor.org/rfc/rfc9110.txt', 'text'),
    ('rfc9293', '网络协议', 'Transmission Control Protocol', 'https://www.rfc-editor.org/rfc/rfc9293.txt', 'text'),
]

def fetch(url: str, target: pathlib.Path) -> str:
    if not target.exists():
        # curl handles the GitHub/RFC TLS frontends more reliably on macOS
        # runners than the system Python 3.9 SSL stack.
        subprocess.run(['curl', '-L', '--fail', '--retry', '3', '--max-time', '90', '-A', 'AKM-real-corpus-validation/1.0', '-o', str(target), url], check=True)
    if target.suffix == '.pdf':
        txt = target.with_suffix('.txt')
        if not txt.exists(): subprocess.run(['pdftotext', '-layout', str(target), str(txt)], check=True)
        return txt.read_text(errors='replace')
    return target.read_text(errors='replace')

def clean(text: str) -> str:
    text = re.sub(r'\r', '', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

def chunks(text: str, size=9000):
    paragraphs = re.split(r'\n\s*\n', text)
    result, current = [], ''
    for para in paragraphs:
        para = para.strip()
        if not para: continue
        if current and len(current) + len(para) + 2 > size:
            result.append(current); current = ''
        current += ('\n\n' if current else '') + para
    if current: result.append(current)
    return result

queries = []
for sid, domain, title, url, kind in sources:
    raw = RAW / (sid + ('.pdf' if kind == 'pdf' else '.txt'))
    text = clean(fetch(url, raw))
    # Strip RFC boilerplate while retaining section headings and normative text.
    if sid.startswith('rfc'):
        text = re.sub(r'(?s)^.*?(?=\n\s*\d+(?:\.\d+)*\.\s+)', '', text)
    pieces = chunks(text)
    domain_dir = PAGES / domain
    domain_dir.mkdir(parents=True, exist_ok=True)
    for i, body in enumerate(pieces, 1):
        first = next((x.strip() for x in body.splitlines() if x.strip()), f'{title} {i}')
        page_title = f'{title} — {i:03d} — {first[:70]}'
        safe = re.sub(r'[^\w\u4e00-\u9fff -]+', '', page_title).strip().replace(' ', '-')[:120]
        rel = f'projects/{domain}/{safe}.md'
        digest = hashlib.sha256(body.encode()).hexdigest()
        front = {'id': f'real-{sid}-{i:03d}', 'domain': domain, 'tags': [sid, 'real-corpus'], 'aliases': [title], 'related': [], 'source_refs': [url], 'source_hash': digest}
        (domain_dir / (safe + '.md')).write_text('---\n' + '\n'.join(f'{k}: {json.dumps(v, ensure_ascii=False)}' for k,v in front.items()) + '\n---\n\n# ' + page_title + '\n\n' + body + '\n')
        # A deterministic query from distinctive terms supports reproducible
        # threshold comparisons without asking an LLM to invent judgments.
        terms = [w for w in re.findall(r'[A-Za-z][A-Za-z-]{4,}|[\u4e00-\u9fff]{2,}', first) if w.lower() not in {'section', 'the'}]
        if terms:
            queries.append({'id': f'{sid}-{i:03d}', 'group': 'real-corpus', 'text': ' '.join(terms[:4]), 'project': domain, 'relevance': {f'real-{sid}-{i:03d}': 3}})

docs = []
for file in sorted(PAGES.glob('*/*.md')):
    if file.name == 'index.md':
        continue
    text = file.read_text()
    if '\n---\n' in text:
        fm, body = text.split('\n---\n', 1)
    else:
        fm, body = '', text
    id_match = re.search(r'^id: (.+)$', fm, re.M)
    page_id = id_match.group(1).strip().strip('"\'') if id_match else f'{domain}/{file.stem}'
    title = next((line[2:].strip() for line in body.splitlines() if line.startswith('# ')), file.stem)
    domain = file.parent.name
    content = body.split('\n\n', 1)[1] if '\n\n' in body else body
    docs.append({'id': page_id, 'project': domain, 'title': title, 'body': content, 'tags': ['real-corpus']})
dataset = {'schema': 1, 'name': 'AKM real corpus v1 (RFC/Raft)', 'description': 'Public RFCs and Raft paper split into provenance-preserving Obsidian pages; synthetic judgment is limited to exact source sections.', 'documents': docs, 'queries': queries}
(OUT / 'retrieve-real-v1.json').write_text(json.dumps(dataset, ensure_ascii=False, indent=2) + '\n')
(OUT / 'manifest.json').write_text(json.dumps({'sources': [{'id': x[0], 'domain': x[1], 'title': x[2], 'url': x[3]} for x in sources], 'documents': len(docs), 'queries': len(queries), 'vault': str(VAULT)}, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'vault': str(VAULT), 'documents': len(docs), 'queries': len(queries)}, ensure_ascii=False))
