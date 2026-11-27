#!/usr/bin/env python3
"""
Proves the one-line cutover actually works, in a throwaway copy of the site.

The cutover went live on Fri 27 Nov 2026 (booking.provider = "site" in
prices.json). This checks the live setup in a throwaway copy, then rehearses the
one-value rollback to Booksy and the switch forward again, so either move holds
no surprises. Nothing here touches the working tree.
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

    def site_state_checks(when):
        hrefs = booking_hrefs(site)
        check(f'{when}: every booking link goes to the booking page',
              hrefs and all((h or '').startswith('/book.html') for h, _ in hrefs),
              [h for h, _ in hrefs if not (h or '').startswith('/book.html')][:3])
        check(f'{when}: none opens in a new tab', not any(t for _, t in hrefs))
        leftover = []
        for dp, _d, fs in os.walk(site):
            for fn in fs:
                if fn.endswith(('.html', '.txt', '.xml', '.webmanifest')):
                    if 'booksy.com' in open(os.path.join(dp, fn), encoding='utf-8', errors='ignore').read():
                        leftover.append(os.path.relpath(os.path.join(dp, fn), site))
        check(f'{when}: no mention of booksy.com is left anywhere', not leftover, leftover)
        book = open(os.path.join(site, 'book.html'), encoding='utf-8').read()
        check(f'{when}: the booking page is not hidden from search', 'name="robots"' not in book)
        check(f'{when}: _headers does not hide it',
              '/book.html' not in open(os.path.join(site, '_headers'), encoding='utf-8').read())
        idx = open(os.path.join(site, 'index.html'), encoding='utf-8').read()
        m = re.search(r'"ReserveAction",\s*\n\s*"target":\s*"([^"]*)"', idx)
        check(f'{when}: what Google reads points at the booking page',
              m and m.group(1) == 'https://scissorsbysandy.com/book.html', m and m.group(1))
        rc, out = preflight(tmp)
        check(f'{when}: preflight passes', rc == 0,
              [l for l in out.splitlines() if 'FAIL' in l][:4])
        return hrefs

    # The cutover happened on Fri 27 Nov 2026: the live setting is "site".
    check('the live setting is the website booking page',
          json.load(open(os.path.join(tmp, 'pricing', 'prices.json')))['booking']['provider'] == 'site')
    build(tmp)
    live = site_state_checks('live')

    # Rollback rehearsal: one value back to "booksy" must restore the old links...
    set_provider(tmp, 'booksy')
    build(tmp)
    back = booking_hrefs(site)
    check('rollback: the same number of booking links survive', len(back) == len(live),
          f"{len(live)} -> {len(back)}")
    check('rollback: every booking link goes to Booksy',
          back and all('booksy.com' in (h or '') for h, _ in back), back[:2])
    check('rollback: and opens in a new tab', all(t for _, t in back))
    rc, _ = preflight(tmp)
    check('rollback: preflight passes', rc == 0)

    # ...and switching forward again must land exactly where the live site is.
    set_provider(tmp, 'site')
    build(tmp)
    again = site_state_checks('forward again')
    check('forward again: identical booking links to the live site', again == live)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{len(fails)} check(s) failed" if fails else "\nall checks pass")
sys.exit(1 if fails else 0)
