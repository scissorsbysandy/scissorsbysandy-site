#!/usr/bin/env python3
"""
Scissors by Sandy — pre-deploy preflight.
Every check below exists because something actually went wrong once.
Run before ANY deploy.  Exit 0 = safe to ship.
"""
import json, re, os, sys, html, datetime
from html.parser import HTMLParser

HERE=os.path.dirname(os.path.abspath(__file__))
SITE=os.path.join(HERE,'..','site')
IDX=os.path.join(SITE,'index.html')
P=json.load(open(os.path.join(HERE,'prices.json')))
fails=[]; warns=[]; passes=[]
def ok(m): passes.append(m)
def bad(m): fails.append(m)
def warn(m): warns.append(m)

h=open(IDX, encoding='utf-8').read()
svc=[s for c in P['categories'] for s in c['services']]

# ---------- 1. structure ----------
VOID={'img','br','hr','meta','link','input','source','path','svg'}
class V(HTMLParser):
    def __init__(s): super().__init__(); s.st=[]; s.er=[]
    def handle_starttag(s,t,a):
        if t=='svg': s.st.append(t); return
        if t in VOID: return
        s.st.append(t)
    def handle_endtag(s,t):
        if t in VOID and t!='svg': return
        if not s.st: s.er.append(t); return
        if s.st[-1]==t: s.st.pop()
        else: s.er.append(t)
v=V(); v.feed(h)
(ok if not v.st and not v.er else bad)("HTML well-formed" if not v.st and not v.er else f"HTML malformed: unclosed {v.st[:4]} stray {v.er[:4]}")
(ok if h.count('{')==h.count('}') else bad)(f"CSS/JS braces balanced ({h.count('{')})" if h.count('{')==h.count('}') else "braces unbalanced")

# ---------- 2. structured data ----------
blocks=[]
for m in re.finditer(r'<script type="application/ld\+json">(.*?)</script>', h, re.S):
    try: blocks.append(json.loads(m.group(1)))
    except Exception as e: bad(f"schema JSON invalid: {e}")
types=[b.get('@type') for b in blocks]
(ok if 'BarberShop' in types else bad)("BarberShop schema present" if 'BarberShop' in types else "BarberShop schema MISSING")
(ok if 'FAQPage' in types else warn)("FAQPage schema present" if 'FAQPage' in types else "FAQPage schema missing")
bs=next((b for b in blocks if b.get('@type')=='BarberShop'), None)
if bs:
    lo=min(s['price'] for s in svc); hi=max(s['price'] for s in svc)
    want=f"${lo}-${hi}"
    (ok if bs.get('priceRange')==want else bad)(f"priceRange {want}" if bs.get('priceRange')==want else f"priceRange is {bs.get('priceRange')}, should be {want}")
    # Google flags review markup a business puts on its OWN site as a critical
    # "Invalid object type for field <parent_node>" error — LocalBusiness and
    # Organization are ineligible for star snippets from self-serving reviews.
    # Search Console reported exactly this on 2026-10-06.  Never re-add it.
    selfserve=[k for k in ('aggregateRating','review','reviews') if k in bs]
    (ok if not selfserve else bad)("no self-serving review markup on BarberShop"
        if not selfserve else f"SELF-SERVING REVIEW MARKUP on BarberShop: {selfserve} — Google rejects this as a critical Review-snippet error")

    # The schema's map pin shipped 3.5 miles north of the shop (40.4181,-74.2957,
    # up toward Sayreville) and sat there unnoticed until 2026-10-08.  It sent
    # Google a location that contradicted its own Business Profile pin.
    # Canonical point = Google's own place record for Suite 101.
    import math
    PIN=(40.3671664,-74.3027377); PLACE_ID="ChIJv508gQTPw4kRJdMmGQk01zw"
    g=bs.get('geo') or {}
    try:
        glat,glon=float(g['latitude']),float(g['longitude'])
        p1,p2=math.radians(glat),math.radians(PIN[0])
        a=(math.sin((p2-p1)/2)**2+math.cos(p1)*math.cos(p2)*math.sin(math.radians(PIN[1]-glon)/2)**2)
        off=2*6371000*math.asin(math.sqrt(a))
        (ok if off<=150 else bad)(f"geo pin on the shop ({off:.0f} m from Google's pin)" if off<=150
            else f"GEO PIN WRONG: {glat},{glon} is {off/1609:.1f} miles from the shop — Google's pin is {PIN[0]},{PIN[1]}")
    except (KeyError,TypeError,ValueError):
        bad("geo coordinates missing or unreadable in BarberShop schema")
    hm=str(bs.get('hasMap',''))
    (ok if PLACE_ID in hm else bad)("hasMap points at the shop's Google place" if PLACE_ID in hm
        else f"hasMap does not carry the shop's place id {PLACE_ID}")
    pc=str((bs.get('address') or {}).get('postalCode',''))
    (ok if pc=='08857' else bad)("postal code 08857" if pc=='08857' else f"postal code is '{pc}', should be 08857")

# ---------- 3. prices on page match the source file ----------
page_prices=re.findall(r'<span class="item-price">\$(\d+)</span>', h)
file_prices=[str(s['price']) for s in svc]
(ok if page_prices==file_prices else bad)(f"all {len(svc)} prices match prices.json" if page_prices==file_prices else f"PRICE MISMATCH page={page_prices} file={file_prices}")

# ---------- 4. deep links (this one shipped broken once) ----------
ids=[s['variantId'] for s in svc if s.get('variantId')]
missing=[s['name'] for s in svc if not s.get('variantId')]
found=re.findall(r'variantId=(\d+)', h)
(ok if not missing else warn)("every service has a variantId" if not missing else f"no variantId: {missing}")
(ok if len(set(found))==len(set(ids)) else bad)(f"{len(set(found))} unique deep links in markup" if len(set(found))==len(set(ids)) else f"deep links {len(set(found))} vs {len(set(ids))} expected")
# the in-page SERVICE_IDS map silently overwrote hrefs once — it must agree
m=re.search(r'var SERVICE_IDS = \{(.*?)\};', h, re.S)
if m:
    mapped=dict(re.findall(r'"([^"]+)":"(\d+)"', m.group(1)))
    expect={s['id']:s['variantId'] for s in svc if s.get('variantId')}
    (ok if mapped==expect else bad)("in-page SERVICE_IDS map matches prices.json"
        if mapped==expect else f"SERVICE_IDS map STALE — it overwrites hrefs on load. diff={set(expect.items())^set(mapped.items())}")
else: warn("no SERVICE_IDS map found (fine if the script was removed)")

# ---------- 5. analytics ----------
(ok if 'G-XXXXXXXXXX' not in h else bad)("no GA4 placeholder" if 'G-XXXXXXXXXX' not in h else "GA4 PLACEHOLDER still present")
(ok if re.search(r'G-[A-Z0-9]{8,}', h) else warn)("GA4 measurement id present" if re.search(r'G-[A-Z0-9]{8,}', h) else "no GA4 id")

# ---------- 5b. gallery styling must survive ----------
# The #suite / .gallery rules are deliberately kept with NO markup using them,
# ready for the professional photos.  They look like dead code and have already
# been nearly stripped once.  The user asked on 2026-10-06 that they be kept.
for sel in ['#suite{', '.gallery{', '.gallery img{']:
    if sel not in h: bad(f"gallery styling removed: {sel} — the user asked to keep it for the new photos")
if all(s_ in h for s_ in ['#suite{', '.gallery{', '.gallery img{']):
    ok("gallery styling preserved for the new photos")

# ---------- 6. stale copy ----------
STALE=['Gift Cards','Groom & Relax','The Statesman beard trim','Back to School','G-XXXXXXXXXX']
for s_ in STALE:
    if s_ in h: bad(f"stale text on page: '{s_}'")
if not any(s_ in h for s_ in STALE): ok("no known stale strings")
for s in svc:
    n=html.unescape(s['name'])
    if n not in html.unescape(h): bad(f"service missing from page: {n}")

# ---------- 7. sitemap freshness ----------
sp=os.path.join(SITE,'sitemap.xml')
if os.path.exists(sp):
    sm=open(sp).read()
    lm=re.search(r'<lastmod>([\d-]+)</lastmod>', sm)
    if lm:
        age=(datetime.date.today()-datetime.date.fromisoformat(lm.group(1))).days
        (ok if age<=1 else bad)(f"sitemap lastmod is current ({lm.group(1)})" if age<=1
             else f"sitemap lastmod {lm.group(1)} is {age} days old — crawlers will skip the update")
else: bad("sitemap.xml missing")

# ---------- 8. required files ----------
need=['index.html','sitemap.xml','robots.txt','_headers','og-image.jpg',
      'favicon-32.png','favicon-192.png','apple-touch-icon.png',
      'sbs-emblem.png','sbs-emblem.webp','barber-pole.png','barber-pole.webp',
      'sandy-mordan.jpg','sandy-mordan.webp']
for f in need:
    if not os.path.exists(os.path.join(SITE,f)): bad(f"missing file: {f}")
if all(os.path.exists(os.path.join(SITE,f)) for f in need): ok(f"all {len(need)} deploy files present")

# ---------- 9. package arithmetic ----------
byid={s['id']:s for s in svc}
for s in svc:
    if 'components' in s:
        comp=sum(byid[x]['price'] for x in s['components'])
        if comp-s['price']!=s['save']: bad(f"{s['name']}: save ${s['save']} but components-price = ${comp-s['price']}")
        mins=sum(byid[x]['minutes'] for x in s['components'])
        if mins!=s['minutes']: bad(f"{s['name']}: {s['minutes']}min but components total {mins}min")
if not any('components' in s for s in svc) or not [f for f in fails if 'save $' in f or 'min but' in f]:
    ok("package savings and durations reconcile")

# ---------- report ----------
print("="*66); print("PREFLIGHT —", os.path.basename(IDX)); print("="*66)
for m in passes: print(f"  ok    {m}")
for m in warns:  print(f"  warn  {m}")
for m in fails:  print(f"  FAIL  {m}")
print("-"*66)
print(f"{len(passes)} passed, {len(warns)} warnings, {len(fails)} failures")
print("SAFE TO DEPLOY" if not fails else "DO NOT DEPLOY — fix the failures above")
sys.exit(1 if fails else 0)
