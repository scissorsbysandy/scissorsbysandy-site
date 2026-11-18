#!/usr/bin/env python3
"""
Proves the one-line cutover actually works, in a throwaway copy of the site.

On Jan 1 the only change should be booking.provider: "booksy" -> "site" in
prices.json. This runs that change for real and checks the result, so the day
itself holds no surprises. Nothing here touches the working tree.
"""
import json, os, re, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fails = []
def check(label, cond, detail=''):
    if cond: print(f"PASS  {label}")
    else:
        fails.append(label); print(f"FAIL  {label}")
        if detail: print('        ' + str(detail)[:300])

def booking_hrefs(site):
    out = []
    for dp, _d, fs in os.walk(site):
        for fn in fs:
            if fn.endswith('.html'):
                g = open(os.path.join(dp, fn), encoding='utf-8').read()
                for tag in re.findall(r'<a[^>]*data-booksy[^>]*>', g):
                    m = re.search(r'href="([^"]*)"', tag)
                    out.append((m.group(1) if m else None, 'target=' in tag))
    return out

def build(tmp):
    r = subprocess.run([sys.executable, 'build.py'], cwd=os.path.join(tmp, 'pricing'),
                       capture_output=True, text=True)
    if r.returncode: raise SystemExit('build failed:\n' + r.stdout + r.stderr)
    return r.stdout

def preflight(tmp):
    r = subprocess.run([sys.executable, 'preflight.py'], cwd=os.path.join(tmp, 'pricing'),
                       capture_output=True, text=True)
    return r.returncode, r.stdout

def set_provider(tmp, value):
    p = os.path.join(tmp, 'pricing', 'prices.json')
    s = open(p, encoding='utf-8').read()
    s = re.sub(r'("provider":\s*")[a-z]+(")', lambda m: m.group(1) + value + m.group(2), s, count=1)
    open(p, 'w', encoding='utf-8').write(s)
    assert json.load(open(p))['booking']['provider'] == value

tmp = tempfile.mkdtemp(prefix='cutover-')
try:
    for d in ('site', 'pricing'):
        shutil.copytree(os.path.join(ROOT, d), os.path.join(tmp, d),
                        ignore=shutil.ignore_patterns('__pycache__'))
    site = os.path.join(tmp, 'site')

    build(tmp)
    before = booking_hrefs(site)
    rc, _ = preflight(tmp)
    check('starts clean on Booksy', rc == 0)
    check('every booking link goes to Booksy',
          before and all('booksy.com' in (h or '') for h, _ in before), before[:2])
    check('and opens in a new tab', all(t for _, t in before))

    # the whole cutover: one value
    set_provider(tmp, 'site')
    build(tmp)
    after = booking_hrefs(site)

    check('the same number of booking links survive', len(after) == len(before),
          f"{len(before)} -> {len(after)}")
    check('every one now goes to the booking page',
          after and all((h or '').startswith('/book.html') for h, _ in after),
          [h for h, _ in after if not (h or '').startswith('/book.html')][:3])
    check('none opens in a new tab any more', not any(t for _, t in after))

    leftover = []
    for dp, _d, fs in os.walk(site):
        for fn in fs:
            if fn.endswith(('.html', '.txt', '.xml', '.webmanifest')):
                if 'booksy.com' in open(os.path.join(dp, fn), encoding='utf-8', errors='ignore').read():
                    leftover.append(os.path.relpath(os.path.join(dp, fn), site))
    check('no mention of booksy.com is left anywhere', not leftover, leftover)

    book = open(os.path.join(site, 'book.html'), encoding='utf-8').read()
    check('the booking page is no longer hidden from search', 'name="robots"' not in book)
    check('and _headers stops hiding it',
          '/book.html' not in open(os.path.join(site, '_headers'), encoding='utf-8').read())
    idx = open(os.path.join(site, 'index.html'), encoding='utf-8').read()
    m = re.search(r'"ReserveAction",\s*\n\s*"target":\s*"([^"]*)"', idx)
    check('what Google reads points at the booking page',
          m and m.group(1) == 'https://scissorsbysandy.com/book.html', m and m.group(1))

    rc, out = preflight(tmp)
    check('preflight passes after the cutover', rc == 0,
          [l for l in out.splitlines() if 'FAIL' in l][:4])

    # and it is reversible, in case the day goes wrong
    set_provider(tmp, 'booksy')
    build(tmp)
    rc, _ = preflight(tmp)
    check('it can be switched back', rc == 0 and booking_hrefs(site) == before)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{len(fails)} check(s) failed" if fails else "\nall checks pass")
sys.exit(1 if fails else 0)
