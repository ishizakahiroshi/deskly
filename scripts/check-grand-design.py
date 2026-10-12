"""Check the fixed design entry; --local also checks local work and evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


class Links(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: set[str] = set()
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if values.get('id'):
            self.ids.add(values['id'])
        if tag == 'a' and values.get('href'):
            self.links.append(values['href'])


def main() -> int:
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument('--local', action='store_true')
    options = args.parse_args()
    root = Path(__file__).resolve().parents[1]
    page = root / 'docs/design_deskly-grand-design.html'
    parser = Links()
    parser.feed(page.read_text(encoding='utf-8'))
    errors: list[str] = []
    checked = 0
    for link in parser.links:
        url = urlsplit(link)
        if url.scheme or url.netloc:
            continue
        target = (page.parent / unquote(url.path)).resolve() if url.path else page
        local = target.is_relative_to((root / 'docs/local').resolve())
        if local and not options.local:
            continue
        checked += 1
        if not target.is_file():
            errors.append(f'missing link: {link}')
        elif url.fragment and target.suffix == '.html':
            dest = Links()
            dest.feed(target.read_text(encoding='utf-8'))
            if unquote(url.fragment) not in dest.ids:
                errors.append(f'missing anchor: {link}')
    if options.local:
        index = root / 'docs/local/reference_deskly-design-sources.md'
        if not index.is_file():
            errors.append('local source registry is missing')
        else:
            for payload in re.findall(r'<!-- source: (.*?) -->', index.read_text(encoding='utf-8')):
                record = json.loads(payload)
                target = (root / record['path']).resolve()
                if not target.is_file():
                    errors.append(f"missing source: {record['id']}")
                elif hashlib.sha256(target.read_bytes()).hexdigest() != record['sha256']:
                    errors.append(f"source changed; review and update design: {record['id']}")
            plan = root / 'docs/local/plan_deskly-grand-design.md'
            if not plan.is_file() or '../design_deskly-grand-design.html' not in plan.read_text(encoding='utf-8'):
                errors.append('work entry does not link back to the fixed design')
    for error in errors:
        print(error)
    print(f'design links checked={checked}, errors={len(errors)}, local={options.local}')
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
