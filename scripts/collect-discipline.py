"""Convert already fetched primary-source HTML into inspectable AKM inbox text."""
import hashlib
import json
import pathlib
import re
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'artifacts/distributed-systems-2026-10-12'


class ArticleParser(HTMLParser):
    def __init__(self, is_blog):
        super().__init__(convert_charrefs=True)
        self.is_blog = is_blog
        self.depth = 0
        self.skip_depth = 0
        self.parts = []
        self.title_depth = 0
        self.title_parts = []

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == 'h1':
            self.title_depth += 1
        if not self.depth and tag == 'div' and (
            attrs.get('id') == 'content' if self.is_blog else attrs.get('class') == 'content'
        ):
            self.depth = 1
            return
        if not self.depth:
            return
        if tag == 'div':
            self.depth += 1
        if tag in ('script', 'style', 'iframe'):
            self.skip_depth += 1
        if tag in ('p', 'div', 'blockquote', 'ul', 'ol', 'pre', 'br'):
            self.parts.append('\n\n')
        if tag in ('h1', 'h2', 'h3', 'h4'):
            self.parts.append('\n\n' + '#' * int(tag[1]) + ' ')
        if tag == 'li':
            self.parts.append('\n- ')

    def handle_endtag(self, tag):
        if tag == 'h1':
            self.title_depth = max(0, self.title_depth - 1)
        if not self.depth:
            return
        if tag in ('script', 'style', 'iframe'):
            self.skip_depth = max(0, self.skip_depth - 1)
        if tag == 'div':
            self.depth -= 1
        if tag in ('p', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4'):
            self.parts.append('\n\n')

    def handle_data(self, value):
        if self.title_depth:
            self.title_parts.append(value)
        if self.depth and not self.skip_depth:
            self.parts.append(value)


manifest = json.loads((OUTPUT / 'collection/fetch-manifest.json').read_text())
source_dir = OUTPUT / 'inputs'
source_dir.mkdir(exist_ok=True)
sources = []
for entry in manifest:
    blog = 'kleppmann' in entry['finalUrl']
    parser = ArticleParser(blog)
    parser.feed((OUTPUT / 'collection' / entry['htmlFile']).read_text())
    title = re.sub(r'\s+', ' ', ''.join(parser.title_parts)).strip()
    if not blog:
        title = title.removeprefix('JEPSEN').strip()
    text = ''.join(parser.parts)
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n[ \t]+', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    if blog:
        text = text.split('If you found this post useful')[0].strip()
    assert len(text) > 1000, f'Incomplete article: {entry["id"]}'
    author = 'Martin Kleppmann' if blog else 'Jepsen'
    published = {'s1': '2015-05-11', 's2': '2016-02-08'}.get(entry['id'], 'not stated')
    document = f'# {title}\n\nAuthor: {author}\nPublished: {published}\nSource URL: {entry["finalUrl"]}\nRetrieved: 2026-10-12\n\n{text}\n'
    name = f'{entry["id"]}.md'
    (source_dir / name).write_text(document)
    sources.append({**entry, 'title': title, 'author': author, 'published': published,
                    'inputFile': name, 'inputSha256': hashlib.sha256(document.encode()).hexdigest(),
                    'characters': len(document), 'words': len(document.split())})
(OUTPUT / 'sources.json').write_text(json.dumps(sources, indent=2, ensure_ascii=False))
print(json.dumps([{k: source[k] for k in ('id', 'title', 'inputFile', 'characters', 'words')} for source in sources], indent=2))
