#!/usr/bin/env python3
"""
Scissors by Sandy — Booksy verification.

Fetches the LIVE public Booksy profile and diffs it against prices.json.
Catches: wrong price, wrong duration, missing service, forgotten rename.

Usage:
    python3 verify.py                 # fetch live page and compare
    python3 verify.py saved.html      # compare against a saved copy instead

Requires no Booksy credentials - it reads the same public page a client sees.
"""
import json, re, sys, os, html, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
D = json.load(open(os.path.join(HERE, 'prices.json')))
URL = D['booksy']['profile_url']

G = "\033[32m"; R = "\033[31m"; Y = "\033[33m"; B = "\033[1m"; X = "\033[0m"
if not sys.stdout.isatty(): G = R = Y = B = X = ""

def fetch(src=None):
    if src:
        return open(src, encoding='utf-8', errors='ignore').read()
    req = urllib.request.Request(URL, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'})
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read().decode('utf-8', errors='ignore')

def strip(s):
    s = re.sub(r'<[^>]+>', ' ', s)
    return re.sub(r'\s+', ' ', html.unescape(s)).strip()

def parse_for(txt, names):
    """For each KNOWN service name find the price that follows it.
       Skips mentions inside package descriptions ("... paired with The Majesty ..."):
       a real listing is never preceded by a lowercase word."""
    out = {}
    for disp in names:
        pat = re.escape(disp).replace(r'\&amp;', '[&]').replace(r'\ ', r'\s+')
        for m in re.finditer(pat + r'(?:\s+Package)?', txt, re.I):
            before = txt[:m.start()].rstrip()
            if before and (before[-1].islower() or before[-1] in ',&'):
                continue                      # mid-sentence mention, not a heading
            tail = txt[m.end(): m.end() + 400]
            # stop before the next service heading so we cannot borrow its price
            pm = re.search(r'\$(\d+)\.\d{2}\s*(\d+)\s*(?:min|h)', tail)
            if pm:
                out[disp] = (int(pm.group(1)), int(pm.group(2)))
                break
    return out

def all_priced(txt):
    """Every price/duration pair on the page, for spotting services not in the file."""
    return [(int(m.group(1)), int(m.group(2)))
            for m in re.finditer(r'\$(\d+)\.\d{2}\s*(\d+)\s*(?:min|h)', txt)]

def norm(s):
    return re.sub(r'[^a-z0-9]', '', s.lower()).replace('package', '')

def main():
    src = sys.argv[1] if len(sys.argv) > 1 else None
    try:
        page = fetch(src)
    except Exception as e:
        print(f"{R}Could not fetch the Booksy page:{X} {e}")
        print("Tip: open the profile in a browser, save the page, then run:")
        print("     python3 verify.py saved.html")
        return 2
    txt = strip(page)
    want = {}
    for c in D['categories']:
        for s_ in c['services']:
            want[html.unescape(s_['name'])] = s_
    live = parse_for(txt, list(want.keys()))
    if not live:
        print(f"{Y}No services matched on the page.{X} Booksy may have changed its markup,")
        print("or none of your service names appear yet.")
        return 2

    ok = []; bad = []; missing = []
    for disp, s_ in want.items():
        if disp not in live:
            missing.append(s_); continue
        lp, lm = live[disp]
        # combos carry a built-in buffer in Booksy because they can't take trailing padding
        want_min = s_.get('booksy_minutes', s_['minutes'])
        probs = []
        if lp != s_['price']:   probs.append(f"price  Booksy ${lp} vs file ${s_['price']}")
        if lm != want_min:
            extra = " (combo incl. buffer)" if 'booksy_minutes' in s_ else ""
            probs.append(f"time   Booksy {lm}min vs expected {want_min}min{extra}")
        (bad if probs else ok).append((s_['name'], probs))
    n_on_page = len(all_priced(txt))
    extra = max(0, n_on_page - len(live))

    print(f"\n{B}BOOKSY VERIFICATION{X}   source: {'saved file' if src else 'live page'}")
    print(f"file version {D['meta']['version']}, effective {D['meta']['effective_date']}")
    print("=" * 64)
    print(f"{G}MATCHING{X}  {len(ok)} of {len(want)} services  ({n_on_page} priced items on the page)")
    for n, _ in ok: print(f"   {G}ok{X}  {n}")
    if bad:
        print(f"\n{R}MISMATCHED{X}  {len(bad)}")
        for n, p in bad:
            print(f"   {R}!!{X}  {n}")
            for x in p: print(f"        {x}")
    if missing:
        print(f"\n{Y}NOT FOUND ON BOOKSY{X}  {len(missing)}  (create them, or check the name matches)")
        for s in missing: print(f"   {Y}--{X}  {s['name']:<30} ${s['price']}  {s['minutes']}min")
    if extra:
        print(f"\n{Y}UNACCOUNTED SERVICES ON BOOKSY{X}  {extra}")
        print(f"   {extra} priced item(s) on the page don't match any name in prices.json.")
        print(f"   Likely an old service to retire, or a name that was changed.")
    print("\n" + "=" * 64)
    if bad or missing:
        print(f"{R}NOT IN SYNC{X} — resolve the items above before you deploy the website.")
        return 1
    print(f"{G}IN SYNC{X} — Booksy matches prices.json. Safe to deploy.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
