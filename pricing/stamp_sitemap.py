#!/usr/bin/env python3
"""
Stamp site/sitemap.xml <lastmod> with today's date.

Runs automatically as the first step of every Netlify build (netlify.toml),
so the date always matches the day the change actually goes live. Before this,
it had to be bumped by hand: a preview approved a day or two later would have
been blocked by the preflight's freshness check, and a forgotten bump tells
search engines nothing changed.
"""
import datetime, os, re
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'site', 'sitemap.xml')
s = open(p).read()
today = datetime.date.today().isoformat()
s2, n = re.subn(r'<lastmod>[\d-]+</lastmod>', f'<lastmod>{today}</lastmod>', s)
if n != 1:
    raise SystemExit(f"sitemap.xml: expected exactly one <lastmod>, found {n}")
open(p, 'w').write(s2)
print(f"sitemap lastmod -> {today}")
