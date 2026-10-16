"""Collect primary public texts, retain provenance; never touches ~/.akm."""
import concurrent.futures
import hashlib
import json
import pathlib
import re
import urllib.request
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts/recovery-validation-2026-10-15'
(OUT / 'inputs').mkdir(parents=True, exist_ok=True)
(OUT / 'collection').mkdir(exist_ok=True)

class Text(HTMLParser):
    def __init__(self):
        super().__init__(); self.parts = []; self.skip = 0
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'nav'): self.skip += 1
        if tag in ('p', 'h1', 'h2', 'h3', 'tr', 'br', 'li'): self.parts.append('\n\n')
    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'nav'): self.skip = max(0, self.skip - 1)
    def handle_data(self, text):
        if not self.skip: self.parts.append(text)

sources = []
old = ROOT / 'artifacts/distributed-systems-2026-10-12'
for source in json.loads((old / 'sources.json').read_text()):
    text = (old / 'inputs' / source['inputFile']).read_text()
    name = 'ds-' + source['inputFile']
    (OUT / 'inputs' / name).write_text(text)
    sources.append(dict(id='ds-' + source['id'], domain='分布式系统', file=name, title=source['title'], url=source['url'], author=source['author'], retrieved='2026-10-12', reused=True, ok=True, sha256=hashlib.sha256(text.encode()).hexdigest(), characters=len(text)))

specs = [
    ('music-triads', '音乐理论', 'Triads and seventh chords', 'https://raw.githubusercontent.com/OpenMusicTheory/openmusictheory.github.io/master/triads.md'),
    ('music-inversion', '音乐理论', 'Chord inversion', 'https://raw.githubusercontent.com/OpenMusicTheory/openmusictheory.github.io/master/inversion.md'),
    ('music-intervals', '音乐理论', 'Intervals', 'https://raw.githubusercontent.com/OpenMusicTheory/openmusictheory.github.io/master/intervals.md'),
    ('music-scales', '音乐理论', 'Major scales and key signatures', 'https://raw.githubusercontent.com/OpenMusicTheory/openmusictheory.github.io/master/scales.md'),
    ('stats-location', '统计学', 'Measures of Location', 'https://www.itl.nist.gov/div898/handbook/eda/section3/eda351.htm'),
    ('stats-scale', '统计学', 'Measures of Scale', 'https://www.itl.nist.gov/div898/handbook/eda/section3/eda356.htm'),
]
def collect(spec):
    sid, domain, title, url = spec
    entry = dict(id=sid, domain=domain, title=title, url=url, retrieved='2026-10-15', reused=False)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'AKM-public-corpus-validation/1.0'}), timeout=30) as response:
            raw = response.read(); entry.update(status=response.status, finalUrl=response.url)
        (OUT / 'collection' / (sid + ('.md' if url.endswith('.md') else '.html'))).write_bytes(raw)
        text = raw.decode('utf-8', errors='replace')
        if not url.endswith('.md'):
            parser = Text(); parser.feed(text); text = ''.join(parser.parts)
        text = re.sub(r'<!--.*?-->', '', text, flags=re.S)
        text = re.sub(r'\n{3,}', '\n\n', text).strip()
        if len(text) < 1000: raise ValueError('Extracted document too short')
        text = f'# {title}\n\nSource URL: {url}\nRetrieved: 2026-10-15\nAuthor: {"Open Music Theory" if domain == "音乐理论" else "NIST/SEMATECH e-Handbook"}\nExtraction: text; image-only examples/formulas are not transcribed.\n\n{text}\n'
        file = sid + '.md'; (OUT / 'inputs' / file).write_text(text)
        entry.update(ok=True, file=file, characters=len(text), sha256=hashlib.sha256(text.encode()).hexdigest(), rawSha256=hashlib.sha256(raw).hexdigest())
    except Exception as error: entry.update(ok=False, error=str(error))
    return entry

with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    sources.extend(pool.map(collect, specs))
(OUT / 'sources.json').write_text(json.dumps(sources, ensure_ascii=False, indent=2))
print(json.dumps([{k: s.get(k) for k in ('id', 'ok', 'characters', 'error')} for s in sources], ensure_ascii=False, indent=2))
