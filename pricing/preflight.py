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

# ---------- 10. menu order and per-service booking links (added 2026-10-08) ----------
# Parse the rendered menu category by category, item by item.
U=html.unescape
menu=h[h.find('<div class="menu">'):h.find('</section>',h.find('<div class="menu">'))]
cats=[(U(m.group(1)),m.start()) for m in re.finditer(r'<h3>(.*?)</h3>',menu)]
want_cats=[U(c['name']) for c in P['categories']]
(ok if [c for c,_ in cats]==want_cats else bad)(
    f"menu categories in prices.json order, starting with {want_cats[0]}" if [c for c,_ in cats]==want_cats
    else f"MENU ORDER WRONG: page {[c for c,_ in cats]} vs prices.json {want_cats}")
# Luis's rule (2026-10-08): haircuts open the menu, and every category reads high to low
(ok if want_cats and want_cats[0]=='Precision Haircuts' else bad)(
    "Precision Haircuts is the first category" if want_cats and want_cats[0]=='Precision Haircuts'
    else f"first category is {want_cats[:1]}, should be Precision Haircuts")
unsorted=[U(c['name']) for c in P['categories'] if [s['price'] for s in c['services']]!=sorted([s['price'] for s in c['services']],reverse=True)]
(ok if not unsorted else bad)("every category lists prices high to low" if not unsorted else f"not high-to-low: {unsorted}")
# Each item's OWN button must carry its own service id and variantId. The older check
# compared sets, so two swapped links (Executive opening Signature) would have passed.
byname={U(s['name']):s for s in svc}
wrong=[]
for blk in menu.split('<div class="item">')[1:]:
    n=re.search(r'<span class="item-name">(.*?)</span>',blk); a=re.search(r'<a class="book-link"[^>]*>',blk)
    if not n or not a: wrong.append("unparseable item"); continue
    s=byname.get(U(n.group(1)))
    ds=re.search(r'data-service="([^"]+)"',a.group(0)); vid=re.search(r'variantId=(\d+)',a.group(0))
    if not s: wrong.append(f"{U(n.group(1))}: not in prices.json"); continue
    if not ds or ds.group(1)!=s['id'] or not vid or vid.group(1)!=s['variantId']:
        wrong.append(f"{s['name']}: button says {ds and ds.group(1)}/{vid and vid.group(1)}, should be {s['id']}/{s['variantId']}")
(ok if not wrong and len(byname)==len(svc) else bad)(f"each of the {len(svc)} Book buttons opens its own service" if not wrong
    else f"BOOK BUTTON MISMATCH: {wrong}")
# Reuzel is haircuts only (Luis, 2026-10-08): never let it drift near shaves or the facial
hs=h.find('<h3>Precision Haircuts</h3>'); he=h.find('<h3>',hs+5) if hs>=0 else -1
reu=[m.start() for m in re.finditer('Reuzel',h)]
inside=[x for x in reu if hs>=0 and hs<x<he]
(ok if reu and len(inside)==len(reu) else bad)("Reuzel mentioned only within Precision Haircuts" if reu and len(inside)==len(reu)
    else ("Reuzel line missing from Precision Haircuts" if not reu else "REUZEL mentioned outside Precision Haircuts — shave and facial products are not Reuzel"))

# ---------- 11. Booksy must open in a new tab, never inside the page ----------
# An on-site iframe trapped clients in endless Booksy registration loops (browsers block
# third-party cookies in frames). All booking links open booksy.com in a new tab.
(ok if not re.search(r'<iframe[^>]*booksy',h,re.I) else bad)("no Booksy iframe" if not re.search(r'<iframe[^>]*booksy',h,re.I)
    else "BOOKSY IFRAME on the page — this caused the registration loop; open in a new tab instead")
bl=re.findall(r'<a [^>]*href="https://booksy\.com[^"]*"[^>]*>',h)
nt=[x[:60] for x in bl if 'target="_blank"' not in x or 'noopener' not in x]
(ok if bl and not nt else bad)(f"all {len(bl)} Booksy links open in a new tab" if bl and not nt else f"Booksy link not opening in a new tab: {nt}")
prof=P['booksy']['profile_url']
badprof=[u for u in re.findall(r'href="(https://booksy\.com/en-us/[^"]+)"',h) if u!=prof]
(ok if not badprof else bad)("general Book links all point at the Booksy profile" if not badprof else f"unexpected Booksy profile URL: {badprof}")

# ---------- 12. what Google reads must match what visitors see ----------
# Google requires FAQ and hours markup to match the visible page; a mismatch can cost
# the rich result. The gift-certificate answer had drifted (straight vs curly quotes).
def norm(t): return re.sub(r'\s+',' ',U(re.sub(r'<[^>]+>','',t))).strip()
vis=dict((norm(q),norm(a)) for q,a in re.findall(r'<summary>(.*?)</summary>\s*<p>(.*?)</p>',h,re.S))
fq=next((b for b in blocks if b.get('@type')=='FAQPage'),{})
sch={norm(q['name']):norm(q['acceptedAnswer']['text']) for q in fq.get('mainEntity',[])}
diff=[q for q in set(vis)|set(sch) if vis.get(q)!=sch.get(q)]
(ok if not diff else bad)(f"FAQ schema matches the {len(vis)} visible answers word for word" if not diff else f"FAQ SCHEMA DIFFERS from the page: {diff}")
canc=next((a for q,a in vis.items() if 'cancel' in q.lower()),'')
pen=re.findall(r'\b(charge[ds]?|fee|fees|penalt\w*|deposit)\b',canc,re.I)
(ok if canc and not pen else bad)("cancellation answer is a courtesy request, no fees" if canc and not pen
    else ("cancellation FAQ missing" if not canc else f"CANCELLATION FAQ mentions {pen} — policy is courtesy only, no fees (Luis, 2026-10-08)"))
if bs:
    DAYS=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
    def t12(x):
        hh,mm=map(int,x.split(':')); return f"{(hh-1)%12+1}{':%02d'%mm if mm else ''} {'AM' if hh<12 else 'PM'}"
    shown={}
    for d,txt in re.findall(r'(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday): ([^<]+)',h): shown.setdefault(d,txt.strip())
    sched={}
    for o in bs.get('openingHoursSpecification',[]):
        for d in ([o['dayOfWeek']] if isinstance(o['dayOfWeek'],str) else o['dayOfWeek']):
            sched[d]='Closed' if o['opens']==o['closes']=='00:00' else f"{t12(o['opens'])} – {t12(o['closes'])}"
    hd=[f"{d}: page '{shown.get(d)}' vs schema '{sched.get(d)}'" for d in DAYS if shown.get(d)!=sched.get(d)]
    (ok if not hd else bad)("hours on the page match the schema for all 7 days" if not hd else f"HOURS MISMATCH: {hd}")

# ---------- 13. links, anchors, directions ----------
ids=re.findall(r'\sid="([^"]+)"',h)
dups=sorted({i for i in ids if ids.count(i)>1})
dead=sorted({a for a in re.findall(r'href="#([^"]+)"',h) if a not in ids})
(ok if not dups and not dead else bad)("in-page anchors all resolve, no duplicate ids" if not dups and not dead
    else f"anchor problems: dead {dead} duplicate {dups}")
blank=[x[:70] for x in re.findall(r'<a [^>]*target="_blank"[^>]*>',h) if 'noopener' not in x]
(ok if not blank else bad)("every new-tab link has rel=noopener" if not blank else f"new-tab links missing noopener: {blank}")
dirs=re.findall(r'href="(https://www\.google\.com/maps[^"]+)"',h)
(ok if dirs and all(PLACE_ID in d for d in dirs) else bad)("Get Directions opens the shop's own Google listing" if dirs and all(PLACE_ID in d for d in dirs)
    else f"directions link not tied to place id {PLACE_ID}: {dirs}")

# ---------- 14. images and caching ----------
hero=h[h.find('<header'):h.find('</header>')]
lazyhero=re.findall(r'<img[^>]*loading="lazy"[^>]*>',hero)
(ok if not lazyhero else bad)("no lazy-loading on the first-screen images" if not lazyhero else "hero image is lazy-loaded — it's above the fold, load it immediately")
noalt=[m for m in re.findall(r'<img [^>]*>',h) if ' alt=' not in m]
(ok if not noalt else bad)("every image has alt text" if not noalt else f"images missing alt: {noalt}")
hp=os.path.join(SITE,'_headers')
if os.path.exists(hp):
    hd_='\n'.join(l for l in open(hp).read().splitlines() if not l.lstrip().startswith('#'))
    (ok if 'immutable' not in hd_.lower() else bad)("no year-long 'immutable' caching on reusable image names" if 'immutable' not in hd_.lower()
        else "_headers marks images immutable — replaced photos (same filename) would stay stale for a year")
    rules=re.split(r'^(?=/)',hd_,flags=re.M)
    cc=[r.splitlines()[0] for r in rules if re.search(r'^\s+cache-control',r,re.I|re.M)]
    def covers(a,b):  # could one path pattern match the same file as another?
        ra=re.escape(a).replace(r'\*','.*'); return re.fullmatch(ra,b.replace('*','x')) or re.fullmatch(re.escape(b).replace(r'\*','.*'),a.replace('*','x'))
    ov=[(a,b) for i,a in enumerate(cc) for b in cc[i+1:] if covers(a,b)]
    (ok if not ov else bad)("only one Cache-Control rule can match any file" if not ov
        else f"overlapping Cache-Control rules {ov} — Netlify merges them into one doubled header")

# ---------- report ----------
print("="*66); print("PREFLIGHT —", os.path.basename(IDX)); print("="*66)
for m in passes: print(f"  ok    {m}")
for m in warns:  print(f"  warn  {m}")
for m in fails:  print(f"  FAIL  {m}")
print("-"*66)
print(f"{len(passes)} passed, {len(warns)} warnings, {len(fails)} failures")
print("SAFE TO DEPLOY" if not fails else "DO NOT DEPLOY — fix the failures above")
sys.exit(1 if fails else 0)
