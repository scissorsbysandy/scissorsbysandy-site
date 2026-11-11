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
      'sbs-emblem.png','sbs-emblem.webp','barber-pole.png','barber-pole.webp','barber-pole-sm.webp',
      'sandy-mordan.jpg','sandy-mordan.webp',
      'fonts/cormorant-garamond-latin.woff2','fonts/jost-latin.woff2','404.html','llms.txt',
      'gift-certificate-majesty.webp','gift-certificate-executive.webp','gift-certificate-sovereign.webp',
      'gift-video-poster.webp']
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

# ---------- 15. service pages (added 2026-10-31) ----------
# Pages built by build_pages.py. Each one repeats prices, Booksy links and FAQ
# answers, so each gets the same scrutiny as the homepage. A price change that
# skipped build.py would leave a page quoting the old price: that fails here.
PAGES=['haircuts','kids-haircuts','hot-towel-shaves','facials-and-treatments','weddings']
smx=open(os.path.join(SITE,'sitemap.xml')).read() if os.path.exists(os.path.join(SITE,'sitemap.xml')) else ''
titles={}; descs={}
for slug in PAGES:
    fp=os.path.join(SITE,slug,'index.html')
    if not os.path.exists(fp): bad(f"{slug}: page missing — run build.py"); continue
    g=open(fp,encoding='utf-8').read(); url=f"https://scissorsbysandy.com/{slug}/"; pf=[]
    vv=V(); vv.feed(g)
    if vv.st or vv.er: pf.append(f"HTML malformed {vv.st[:3]} {vv.er[:3]}")
    if f'<link rel="canonical" href="{url}">' not in g: pf.append("canonical missing or wrong")
    if f"<loc>{url}</loc>" not in smx: pf.append("not in sitemap.xml")
    if f'href="/{slug}/"' not in h: pf.append("homepage does not link to it")
    t=re.search(r'<title>(.*?)</title>',g); dsc=re.search(r'<meta name="description" content="([^"]+)"',g)
    if not t or not dsc: pf.append("title or description missing")
    else: titles[slug]=t.group(1); descs[slug]=dsc.group(1)
    if len(re.findall(r'<h1[ >]',g))!=1: pf.append("needs exactly one h1")
    # every priced item: right price, right duration, right Booksy button
    for blk in g.split('<div class="item">')[1:]:
        n=re.search(r'<span class="item-name">(.*?)</span>',blk); pr=re.search(r'<span class="item-price">\$(\d+)</span>',blk)
        du=re.search(r'<p class="item-dur">(\d+) min',blk); a=re.search(r'<a class="book-link"[^>]*>',blk)
        sv=byname.get(U(n.group(1))) if n else None
        if not sv: pf.append(f"unknown service {n and U(n.group(1))}"); continue
        if not pr or int(pr.group(1))!=sv['price']: pf.append(f"{sv['name']} shows ${pr and pr.group(1)}, prices.json says ${sv['price']}")
        if not du or int(du.group(1))!=sv['minutes']: pf.append(f"{sv['name']} duration wrong")
        ds=re.search(r'data-service="([^"]+)"',a.group(0)) if a else None; vid=re.search(r'variantId=(\d+)',a.group(0)) if a else None
        if not ds or ds.group(1)!=sv['id'] or not vid or vid.group(1)!=sv['variantId']: pf.append(f"{sv['name']} Book button opens the wrong service")
    if '<div class="item">' not in g: pf.append("no services listed")
    # booking safety, same rules as the homepage
    if re.search(r'<iframe[^>]*booksy',g,re.I): pf.append("Booksy iframe")
    if [x for x in re.findall(r'<a [^>]*target="_blank"[^>]*>',g) if 'noopener' not in x]: pf.append("new-tab link without noopener")
    if [x for x in re.findall(r'<a [^>]*href="https://booksy\.com[^"]*"[^>]*>',g) if 'target="_blank"' not in x]: pf.append("Booksy link not opening in a new tab")
    # what Google reads must match what visitors see
    gb=[]
    for m_ in re.finditer(r'<script type="application/ld\+json">(.*?)</script>',g,re.S):
        try: gb.append(json.loads(m_.group(1)))
        except Exception as e: pf.append(f"schema JSON invalid: {e}")
    gv=dict((norm(q),norm(a_)) for q,a_ in re.findall(r'<summary>(.*?)</summary>\s*<p>(.*?)</p>',g,re.S))
    gf=next((b for b in gb if b.get('@type')=='FAQPage'),{})
    gs={norm(q['name']):norm(q['acceptedAnswer']['text']) for q in gf.get('mainEntity',[])}
    if not gv or gv!=gs: pf.append("FAQ schema differs from the visible answers")
    if any(k in json.dumps(gb) for k in ('aggregateRating','"review"')): pf.append("self-serving review markup")
    for b_ in gb:
        for o in b_.get('offers',[]):
            sv=byname.get(o['name'])
            if not sv or str(sv['price'])!=o['price']: pf.append(f"schema offer {o['name']} ${o['price']} disagrees with prices.json")
    # house rules for copy
    if slug!='haircuts' and 'Reuzel' in g: pf.append("mentions Reuzel — shave and facial products are not Reuzel")
    if re.search(r'extraction',g,re.I): pf.append("says 'extraction' — the facial copy says deep pore cleanse")
    if re.search(r'\b\d+\s+(Google\s+)?reviews\b',re.sub(r'<[^>]+>','',g),re.I): pf.append("shows a review count — say 'Rated 5.0 stars on Google'")
    if '25+' in g or '25 years' in g: pf.append("repeats Sandy's years outside Meet Sandy")
    if 'G-76DN6KF3WB' not in g: pf.append("analytics missing")
    if 'Trouble booking online?' not in g: pf.append("booking-help line missing")
    # hours must be the homepage's hours
    hh=re.search(r'<h3 class="visit-h">Hours</h3>\s*<p>(.*?)</p>',h,re.S); gh=re.search(r'<h3 class="visit-h">Hours</h3>\s*<p>(.*?)</p>',g,re.S)
    if not hh or not gh or hh.group(1)!=gh.group(1): pf.append("hours differ from the homepage")
    # wedding prices are written on the homepage, not in prices.json: they must agree
    if slug=='weddings':
        hw=re.search(r'<div class="wed-grid">.*?<div class="wed-know">',h,re.S)
        if not hw or hw.group(0).split('<div class="wed-know">')[0].strip() not in g: pf.append("wedding packages differ from the homepage")
        for amt in ['$250','$595','$110','50% deposit','7 days']:
            if amt not in g or amt not in h: pf.append(f"wedding term {amt} missing on one of the two pages")
    for x in pf: bad(f"{slug}: {x}")
    if not pf: ok(f"/{slug}/ prices, Book buttons, FAQ schema, hours and house rules all check out")
dupT=[k for k in titles if list(titles.values()).count(titles[k])>1]; dupD=[k for k in descs if list(descs.values()).count(descs[k])>1]
(ok if not dupT and not dupD else bad)("every service page has its own title and description" if not dupT and not dupD else f"duplicate titles/descriptions: {dupT+dupD}")

# ---------- 16. home-screen install + IndexNow (added 2026-10-31) ----------
# The site installs to a phone's home screen like an app. If the manifest or an icon
# goes missing, phones quietly fall back to a blurry screenshot icon. IndexNow tells
# Bing (and ChatGPT search, which draws on Bing) about changed pages; it needs its
# key file at the site root.
mp=os.path.join(SITE,'manifest.webmanifest'); hp_=[]
try:
    mf=json.load(open(mp))
    for k in ('name','short_name','start_url','display','icons'):
        if not mf.get(k): hp_.append(f"manifest missing {k}")
    for ic in mf.get('icons',[]):
        if not os.path.exists(os.path.join(SITE,ic['src'].lstrip('/'))): hp_.append(f"icon file missing: {ic['src']}")
    if not any(ic.get('purpose')=='maskable' for ic in mf.get('icons',[])): hp_.append("no maskable icon (Android crops it badly)")
    for sc in mf.get('shortcuts',[]):
        if not sc['url'].startswith('/'): hp_.append(f"shortcut leaves the site: {sc['url']}")
except Exception as e: hp_.append(f"manifest unreadable: {e}")
pages_all=[('home',h)]+[(sl,open(os.path.join(SITE,sl,'index.html'),encoding='utf-8').read()) for sl in PAGES if os.path.exists(os.path.join(SITE,sl,'index.html'))]
for nm,pg in pages_all:
    if '<link rel="manifest" href="/manifest.webmanifest">' not in pg: hp_.append(f"{nm}: no manifest link")
keys=[f for f in os.listdir(SITE) if re.fullmatch(r'[0-9a-f]{32}\.txt',f)]
if not keys: hp_.append("IndexNow key file missing from the site root")
for f in keys:
    if open(os.path.join(SITE,f)).read().strip()!=f[:-4]: hp_.append(f"IndexNow key file {f} has the wrong contents")
for x in hp_: bad(x)
if not hp_: ok("home-screen install (manifest, icons) and IndexNow key are in place")

# ---------- 17. search and speed (added 2026-11-11) ----------
# The SEO and speed overhaul of 2026-11-11, written down as rules so none of it
# quietly comes undone. Before it, Google's own test (PageSpeed, phone) scored the
# homepage 83/100 for speed with a 4.4 s largest paint, because:
#   - a Google Fonts stylesheet held up the first paint by ~750 ms,
#   - the two first-screen images were 2 to 3 times heavier than they needed to be,
#   - the 178 KB analytics library downloaded alongside the first screen.
# And on the search side the homepage title and H1 never said "barber shop" or
# "Old Bridge", and three of the four service pages were not in Google's index.
BASE='https://scissorsbysandy.com'
def rd(*parts):
    fp=os.path.join(SITE,*parts)
    return open(fp,encoding='utf-8').read() if os.path.exists(fp) else ''
INFO=['gift-certificates']   # generated pages that are not service menus
indexable=[('home',h,BASE+'/')]+[(sl,rd(sl,'index.html'),f"{BASE}/{sl}/") for sl in PAGES+INFO]
p404=rd('404.html')
every=indexable+[('404',p404,None)]

# 17a. what Google shows in results: one clear title and description per page
sf=[]; seenT={}; seenD={}
for nm,pg,url in indexable:
    t=re.search(r'<title>(.*?)</title>',pg,re.S); d=re.search(r'<meta name="description" content="([^"]*)"',pg)
    tt=U(t.group(1)).strip() if t else ''; dd=U(d.group(1)).strip() if d else ''
    if not tt: sf.append(f"{nm}: no title")
    elif len(tt)>60: sf.append(f"{nm}: title is {len(tt)} characters, Google cuts it off after about 60: '{tt}'")
    if not dd: sf.append(f"{nm}: no meta description")
    elif not 70<=len(dd)<=160: sf.append(f"{nm}: description is {len(dd)} characters, keep it between 70 and 160")
    if tt in seenT: sf.append(f"{nm}: same title as {seenT[tt]}")
    if dd in seenD: sf.append(f"{nm}: same description as {seenD[dd]}")
    seenT[tt]=nm; seenD[dd]=nm
    if 'Old Bridge' not in tt: sf.append(f"{nm}: title does not say Old Bridge")
    if len(re.findall(r'<h1[ >]',pg))!=1: sf.append(f"{nm}: needs exactly one h1")
    if len(re.findall(r'<main[ >]',pg))!=1 or pg.count('</main>')!=1: sf.append(f"{nm}: needs exactly one <main> landmark")
    if f'<link rel="canonical" href="{url}">' not in pg: sf.append(f"{nm}: canonical should be {url}")
    if re.search(r'<meta name="robots"[^>]*noindex',pg,re.I): sf.append(f"{nm}: carries a noindex tag, Google would drop the page")
    if '<meta property="og:image" content="https://scissorsbysandy.com/og-image.jpg">' not in pg: sf.append(f"{nm}: no og:image (link previews would be blank)")
    if '<html lang="en">' not in pg: sf.append(f"{nm}: <html> has no lang")
h1=norm(re.search(r'<h1[^>]*>(.*?)</h1>',h,re.S).group(1)) if re.search(r'<h1[^>]*>(.*?)</h1>',h,re.S) else ''
ht=U(re.search(r'<title>(.*?)</title>',h).group(1))
if not ('Scissors by Sandy' in h1 and 'Old Bridge' in h1 and re.search(r'barber',h1,re.I)):
    sf.append(f"homepage h1 must name the shop, say barber, and say Old Bridge; it reads '{h1}'")
if not re.search(r'barber ?shop',ht,re.I): sf.append(f"homepage title must contain 'Barber Shop' (what people search): '{ht}'")
for x in sf: bad(x)
if not sf: ok(f"titles, descriptions, h1, <main> and canonical are right on all {len(indexable)} pages")

# 17b. structured data ties the pages together: one shop, one @id
sd=[]
if bs:
    if bs.get('@id')!=BASE+'/#barbershop': sd.append("BarberShop schema needs @id https://scissorsbysandy.com/#barbershop (the service pages point at it)")
    if bs.get('url')!=BASE+'/': sd.append(f"BarberShop url should match the canonical {BASE}/")
    for im in ([bs.get('logo')] if bs.get('logo') else [])+list(bs.get('image') or []):
        if not os.path.exists(os.path.join(SITE,im.replace(BASE+'/',''))): sd.append(f"schema image missing from the site: {im}")
ws=next((x for x in blocks if x.get('@type')=='WebSite'),None)
if not ws or ws.get('name')!='Scissors by Sandy' or ws.get('url')!=BASE+'/': sd.append("WebSite schema missing (it tells Google the site's name)")
for nm,pg,url in indexable[1:]:
    gb=[json.loads(m_.group(1)) for m_ in re.finditer(r'<script type="application/ld\+json">(.*?)</script>',pg,re.S)]
    sv_=next((x for x in gb if x.get('@type')=='Service'),None); bc=next((x for x in gb if x.get('@type')=='BreadcrumbList'),None)
    if not sv_ or (sv_.get('provider') or {}).get('@id')!=BASE+'/#barbershop': sd.append(f"{nm}: Service schema does not point at the shop's @id")
    if not bc or bc['itemListElement'][-1].get('item')!=url: sd.append(f"{nm}: breadcrumb schema missing or wrong")
for x in sd: bad(x)
if not sd: ok("schema: shop @id, WebSite name, and every service page linked back to the shop")

# 17c. fonts come from this site, and nothing outside it may hold up the first paint
sp_=[]
for nm,pg,url in every:
    head=pg[:pg.find('</head>')]
    if re.search(r'fonts\.(googleapis|gstatic)\.com',pg): sp_.append(f"{nm}: loads fonts from Google again (it cost ~750 ms before the first paint)")
    for f_ in ('/fonts/cormorant-garamond-latin.woff2','/fonts/jost-latin.woff2'):
        if f'<link rel="preload" href="{f_}" as="font" type="font/woff2" crossorigin>' not in head: sp_.append(f"{nm}: font not preloaded: {f_}")
        if f"url({f_})" not in pg: sp_.append(f"{nm}: @font-face for {f_} missing")
    if 'font-display:swap' not in pg: sp_.append(f"{nm}: fonts need font-display:swap so text shows immediately")
    if re.search(r'<link[^>]+rel="stylesheet"',head): sp_.append(f"{nm}: an external stylesheet in the <head> blocks the first paint; keep CSS inline")
    for s_ in re.findall(r'<script[^>]+src="[^"]+"[^>]*>',pg):
        if 'googletagmanager.com' in s_: sp_.append(f"{nm}: analytics is a <script src> tag again; it must be loaded after the page (see the GA block)")
        elif ' async' not in s_ and ' defer' not in s_: sp_.append(f"{nm}: script without async/defer blocks the page: {s_[:70]}")
    if 'G-76DN6KF3WB' not in pg: sp_.append(f"{nm}: analytics missing")
    elif not re.search(r"addEventListener\('load',\s*whenIdle\)",pg) or "googletagmanager.com/gtag/js?id=G-76DN6KF3WB'" not in pg:
        sp_.append(f"{nm}: analytics no longer waits for the page to finish loading")
if os.path.exists(hp):
    fr=re.search(r'^/fonts/\*\n((?:[ \t]+.*\n?)+)',hd_+'\n',re.M)
    if not fr or not re.search(r'max-age=(\d+)',fr.group(1)) or int(re.search(r'max-age=(\d+)',fr.group(1)).group(1))<2592000:
        sp_.append("_headers: /fonts/* needs a long Cache-Control (30 days or more) so returning visitors don't re-download fonts")
for x in sp_: bad(x)
if not sp_: ok("fonts self-hosted and preloaded, analytics deferred, nothing render-blocking on any page")

# 17d. weight budgets for what a phone actually downloads on the first screen
BUDGET={'barber-pole.webp':40,'barber-pole-sm.webp':22,'sbs-emblem.webp':16,'sandy-mordan.webp':32,
        'og-image.jpg':150,'favicon-32.png':4,'fonts/cormorant-garamond-latin.woff2':45,'fonts/jost-latin.woff2':32,
        'gift-certificate-majesty.webp':60,'gift-certificate-executive.webp':60,'gift-certificate-sovereign.webp':60,
        'gift-video-poster.webp':50}
wb=[f"{f_} is {os.path.getsize(os.path.join(SITE,f_))/1024:.0f} KB, budget {kb} KB: re-export it smaller"
    for f_,kb in BUDGET.items() if os.path.exists(os.path.join(SITE,f_)) and os.path.getsize(os.path.join(SITE,f_))>kb*1024]
for nm,pg,url in every:
    kb=len(pg.encode('utf-8'))/1024
    if kb>100: wb.append(f"{nm}: the page itself is {kb:.0f} KB, budget 100 KB")
    elif kb>85: warn(f"{nm}: page is {kb:.0f} KB, close to the 100 KB budget")
if '<source media="(max-width:599px)" srcset="barber-pole-sm.webp" type="image/webp">' not in hero: wb.append("hero: phones must get barber-pole-sm.webp (the pole is the largest thing painted first)")
if not re.search(r'<img class="hero-pole"[^>]*fetchpriority="high"',hero): wb.append("hero pole lost fetchpriority=high")
unsized=[m_[:80] for pg_ in [x[1] for x in every] for m_ in re.findall(r'<img [^>]*>',pg_) if ' width=' not in m_ or ' height=' not in m_]
if unsized: wb.append(f"images without width and height make the page jump as it loads: {unsized[:3]}")
for x in wb: bad(x)
if not wb: ok("first-screen images, fonts and page sizes are all within their weight budgets")

# 17e. crawlers: sitemap lists exactly the real pages, robots.txt lets them in, links all lead somewhere
cr=[]
locs=re.findall(r'<loc>([^<]+)</loc>',smx); wantlocs=[u for _,_,u in indexable]
if sorted(locs)!=sorted(wantlocs): cr.append(f"sitemap.xml should list exactly the {len(wantlocs)} pages; differs by {sorted(set(locs)^set(wantlocs))}")
rb=rd('robots.txt')
if not re.search(r'^Sitemap:\s*https://scissorsbysandy\.com/sitemap\.xml\s*$',rb,re.M): cr.append("robots.txt lost its Sitemap line")
if re.search(r'^Disallow:\s*/\s*$',rb,re.M): cr.append("robots.txt has 'Disallow: /' which hides the whole site from search engines")
home_ids=set(re.findall(r'\sid="([^"]+)"',h))
for nm,pg,url in every:
    for href in set(re.findall(r'href="(/[^"]*)"',pg)):
        path,_,frag=href.partition('#'); path=path.split('?')[0]
        tgt=os.path.join(SITE,path.lstrip('/'),'index.html') if path.endswith('/') else os.path.join(SITE,path.lstrip('/'))
        if not os.path.exists(tgt): cr.append(f"{nm}: link to {href} leads nowhere")
        elif frag and path=='/' and frag not in home_ids: cr.append(f"{nm}: link to {href} points at a section that does not exist")
for sl in PAGES+INFO:
    n_in=sum(1 for nm,pg,url in indexable if nm!=sl and f'href="/{sl}/"' in pg)
    if n_in<len(indexable)-1: cr.append(f"/{sl}/ is not linked from every other page ({n_in} of {len(indexable)-1}); Google finds and values pages through links")
for x in cr: bad(x)
if not cr: ok(f"sitemap lists exactly {len(wantlocs)} pages, robots.txt is open, every internal link resolves, every page links to every other")

# 17f. the "page not found" page and the plain-text summary for AI assistants
ex=[]
if not re.search(r'<meta name="robots" content="noindex">',p404): ex.append("404.html must carry noindex")
if 'href="/"' not in p404: ex.append("404.html must link back to the homepage")
rel=[u for u in re.findall(r'(?:href|src|srcset)="([^"]+)"',p404) if not re.match(r'(/|https?://|tel:|mailto:|#)',u)]
if rel: ex.append(f"404.html has relative addresses that break when shown at a deeper path: {rel[:3]}")
ll=rd('llms.txt')
for s in svc:
    if f"- {norm(s['name'])}: ${s['price']}, {s['minutes']} minutes." not in ll: ex.append(f"llms.txt out of date for {norm(s['name'])}: run build.py")
hh_=re.search(r'<h3 class="visit-h">Hours</h3>\s*<p>(.*?)</p>',h,re.S)
for line in (hh_.group(1).split('<br>') if hh_ else []):
    if norm(line) and f"- {norm(line)}" not in ll: ex.append(f"llms.txt hours differ from the homepage: {norm(line)}")
if '(848) 230-5995' not in ll or '3813 US 9 North, Suite 101' not in ll: ex.append("llms.txt lost the phone or address")
if re.search(r'\b\d+\s+(Google\s+)?reviews\b|25\+|25 years|extraction',ll,re.I): ex.append("llms.txt breaks a house rule (review count, years, or 'extraction')")
for x in ex: bad(x)
if not ex: ok("404 page and llms.txt are in place and agree with prices.json and the homepage hours")

# 17g. gift certificates: the page, the homepage picture, and the one-tap text
# Added 2026-11-11. The page exists to give the holiday posts and the commercial
# somewhere to land, and to show the certificate. Taps on its buttons are counted
# in Analytics as gift_click, so its worth can be judged with numbers.
gf=[]; gp=rd('gift-certificates','index.html')
SMS='sms:+18482305995?&amp;body='
for nm_,pg_ in (('gift page',gp),('homepage gift section',h[h.find('<section id="gift">'):h.find('</section>',h.find('<section id="gift">'))])):
    if SMS not in pg_ or 'data-gift="text"' not in pg_: gf.append(f"{nm_}: the Text Sandy button is missing or lost its pre-filled message")
    if 'data-gift="call"' not in pg_: gf.append(f"{nm_}: the Call button lost its gift tracking")
    if '/gift-certificate-majesty.webp' not in pg_: gf.append(f"{nm_}: the certificate picture is missing")
if 'href="/gift-certificates/"' not in h[h.find('<section id="gift">'):h.find('<footer')]: gf.append("homepage gift section does not link to the gift page")
if "gtag('event', 'gift_click'" not in h: gf.append("gift_click tracking removed from the analytics block")
if '<iframe' in gp: gf.append("gift page embeds a video frame directly: YouTube must load only when play is pressed (it adds over 1 MB)")
yt=re.search(r'<a class="yt"[^>]*>',gp)
if not yt or 'target="_blank"' not in yt.group(0) or 'noopener' not in yt.group(0) or 'data-yt="' not in yt.group(0): gf.append("gift page film link is missing or not a click-to-play link")
ggb=[json.loads(m_.group(1)) for m_ in re.finditer(r'<script type="application/ld\+json">(.*?)</script>',gp,re.S)]
vo=next((x for x in ggb if x.get('@type')=='VideoObject'),None)
if not vo or not os.path.exists(os.path.join(SITE,str(vo.get('thumbnailUrl','')).replace(BASE+'/',''))): gf.append("gift page VideoObject schema missing, or its thumbnail file is gone")
gvis=dict((norm(q),norm(a_)) for q,a_ in re.findall(r'<summary>(.*?)</summary>\s*<p>(.*?)</p>',gp,re.S))
gfq=next((x for x in ggb if x.get('@type')=='FAQPage'),{})
if not gvis or gvis!={norm(q['name']):norm(q['acceptedAnswer']['text']) for q in gfq.get('mainEntity',[])}: gf.append("gift page FAQ schema differs from the visible answers")
gtxt=norm(re.sub(r'<(script|style)[^>]*>.*?</\1>','',gp,flags=re.S))
if not re.search(r'two years',gtxt,re.I) or re.search(r'one year|1 year',gtxt,re.I): gf.append("gift page must say certificates are valid two years from purchase (that is what is printed on them)")
if re.search(r'signature',gtxt.replace('The Signature',''),re.I): gf.append("gift page uses 'signature' as an adjective; it collides with The Signature, a real service")
if re.search(r'supporting my small business|extraction|25\+|25 years|\b\d+\s+(Google\s+)?reviews\b',gtxt,re.I): gf.append("gift page breaks a house copy rule")
if 'Reuzel' in gp: gf.append("gift page mentions Reuzel")
ghh=re.search(r'<h3 class="visit-h">Hours</h3>\s*<p>(.*?)</p>',gp,re.S); hh0=re.search(r'<h3 class="visit-h">Hours</h3>\s*<p>(.*?)</p>',h,re.S)
if not ghh or not hh0 or ghh.group(1)!=hh0.group(1): gf.append("gift page hours differ from the homepage")
for amt in re.findall(r'\$(\d+)',gtxt):
    if int(amt) not in {s['price'] for s in svc}: gf.append(f"gift page quotes ${amt}, which is not a price in prices.json")
for x in gf: bad(x)
if not gf: ok("gift certificates: page, homepage picture, Text Sandy button, click-to-play film and tracking all in place")

# 17h. dated offers in the gold bar retire themselves, and may not outstay their date
# The bar carries "OFFER-ENDS yyyy-mm-dd". From the next day visitors see the
# standing line instead (a two-line script in the bar does it, so nothing stale
# is ever shown even if nobody touches the site). The preflight then refuses the
# next deploy until the expired offer is taken out, so it gets cleaned up.
of=[]; om=re.search(r'OFFER-ENDS (\d{4}-\d{2}-\d{2})',h)
if om:
    end=datetime.date.fromisoformat(om.group(1)); nxt=end+datetime.timedelta(days=1)
    if f"Date.parse('{nxt.isoformat()}T00:00:00-05:00')" not in h: of.append(f"promo bar says the offer ends {end} but its switch-off script uses a different date")
    strip=re.search(r'<p class="responders" id="weekday" data-offer>(.*?)</p>',h,re.S)
    if not strip or f"through {end.strftime('%B')} {end.day}" not in norm(strip.group(1)): of.append(f"the offer line in Services must say 'through {end.strftime('%B')} {end.day}'")
    if 'class="offer-default"' not in h or '.offer-over [data-offer]{display:none}' not in h: of.append("promo bar has no standing line to fall back to when the offer ends")
    left=(end-datetime.date.today()).days
    if left<0: of.append(f"the offer in the gold bar ended {end}. Visitors already see the standing line, but take the offer out of the promo bar and the Services section before deploying")
    elif left<=10: warn(f"the offer in the gold bar ends in {left} days ({end})")
elif 'data-offer' in h: of.append("promo bar has an offer with no OFFER-ENDS date")
bar=re.search(r'<div class="promo-bar">.*?</div>',h,re.S)
for nm,pg,url in every[1:]:
    if not bar or bar.group(0) not in pg: of.append(f"{nm}: promo bar differs from the homepage's: run build.py")
for x in of: bad(x)
if not of: ok("gold bar offer is dated, switches itself off, and is identical on every page" if om else "gold bar is identical on every page")

# ---------- report ----------
print("="*66); print("PREFLIGHT —", os.path.basename(IDX)); print("="*66)
for m in passes: print(f"  ok    {m}")
for m in warns:  print(f"  warn  {m}")
for m in fails:  print(f"  FAIL  {m}")
print("-"*66)
print(f"{len(passes)} passed, {len(warns)} warnings, {len(fails)} failures")
print("SAFE TO DEPLOY" if not fails else "DO NOT DEPLOY — fix the failures above")
sys.exit(1 if fails else 0)
