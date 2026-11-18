#!/usr/bin/env python3
"""
Scissors by Sandy — pricing build.
Edit prices.json ONLY, then run:  python3 build.py
Regenerates the website services section and prints the platform checklist.
"""
import json, re, sys, os, datetime
HERE=os.path.dirname(os.path.abspath(__file__))
SITE=os.path.join(HERE,'..','site','index.html')
D=json.load(open(os.path.join(HERE,'prices.json')))
import booking
WID=D['booksy']['widget_base'].replace('&','&amp;')
PROF=D['booksy']['profile_url']

def validate():
    errs=[]; ids={}
    byid={s['id']:s for c in D['categories'] for s in c['services']}
    for c in D['categories']:
        for s in c['services']:
            if s['id'] in ids: errs.append(f"duplicate id {s['id']}")
            ids[s['id']]=1
            if s['price']<=0: errs.append(f"{s['name']}: bad price")
            if s.get('prev_price') and s['price']<s['prev_price']:
                errs.append(f"{s['name']}: price DROPPED {s['prev_price']} -> {s['price']}")
            if 'components' in s:
                comp=sum(byid[x]['price'] for x in s['components'])
                if comp-s['price']!=s['save']:
                    errs.append(f"{s['name']}: save says ${s['save']} but components ${comp} - price ${s['price']} = ${comp-s['price']}")
                mins=sum(byid[x]['minutes'] for x in s['components'])
                if mins!=s['minutes']:
                    errs.append(f"{s['name']}: duration {s['minutes']}min but components total {mins}min")
    return errs

def services_html():
    out=['  <div class="menu">']
    for c in D['categories']:
        out.append(f'    <h3>{c["name"]}</h3>')
        out.append('    <div class="cat-items">')
        for s in c['services']:
            href,href_attrs=booking.link(D,s)
            ds=f' data-service="{s["id"]}"' if s.get('variantId') else ''
            save=f' <span class="item-save">Save ${s["save"]}</span>' if s.get('save') else ''
            out.append('      <div class="item">')
            out.append(f'      <div class="item-line"><span class="item-name">{s["name"]}</span>'
                       f'<span class="leader" aria-hidden="true"></span>'
                       f'<span class="item-price">${s["price"]}</span></div>')
            out.append(f'      <p class="item-dur">{s["minutes"]} min{save}</p>')
            out.append(f'      <p>{s["desc"]}</p>')
            out.append(f'      <a class="book-link" data-booksy{ds} href="{href}"{href_attrs}>Book this service &rarr;</a>')
            out.append('    </div>')
        out.append('    </div>')
        if c.get('note'):
            out.append(f'    <p class="cat-note">{c["note"]}</p>')
        if c.get('more'):
            more=c['more'] if isinstance(c['more'],list) else [c['more']]
            out.append('    <p class="cat-more">'+' '.join(f'<a href="{m["href"]}">{m["label"]} &rarr;</a>' for m in more)+'</p>')
    out.append('  </div>')
    return "\n".join(out)

def service_ids_js():
    """The page has a script that rewrites every [data-booksy] href on load from its
       own SERVICE_IDS map. If that map is stale it silently discards our links,
       so regenerate it from prices.json too."""
    rows=[]
    for c in D['categories']:
        for s_ in c['services']:
            if s_.get('variantId'):
                rows.append(f'"{s_["id"]}":"{s_["variantId"]}"')
    out=[]
    for i in range(0,len(rows),4):
        out.append("      "+",".join(rows[i:i+4]))
    provider, site_path = booking.cfg(D)
    if provider == 'booksy':
        head=(f'var WIDGET  = "{D["booksy"]["widget_base"]}";\n'
              f'    var PROFILE = "{D["booksy"]["profile_url"]}";\n')
        body="var SERVICE_IDS = {\n"+",\n".join(out)+"\n    };"
    else:
        head='var WIDGET  = "";\n    var PROFILE = "";\n'
        body="var SERVICE_IDS = {};"
    return head+f'    var BOOKING = "{provider}", SITE_PATH = "{site_path}";\n    '+body

def patch_site():
    if not os.path.exists(SITE): return "site/index.html not found — skipped"
    h=open(SITE).read()
    m=re.search(r'var WIDGET\s*=.*?var SERVICE_IDS = \{.*?\};', h, re.S)
    if m: h=h[:m.start()]+service_ids_js()+h[m.end():]
    a=h.find('  <div class="menu">')
    if a<0: return "menu block not found — skipped"
    sec_end=h.find('</section>',a)
    b=h.rfind('</div>',a,sec_end)+6
    h=h[:a]+services_html()+h[b:]
    lo=min(s['price'] for c in D['categories'] for s in c['services'])
    hi=max(s['price'] for c in D['categories'] for s in c['services'])
    m=re.search(r'"priceRange":\s*"([^"]*)"',h)
    if m: h=h[:m.start(1)]+f"${lo}-${hi}"+h[m.end(1):]
    open(SITE,'w').write(h)
    return f"site/index.html updated — priceRange ${lo}-${hi}"

A_TAG = re.compile(r'<a\b[^>]*\bdata-booksy\b[^>]*>', re.I)
BY_ID = {s['id']: s for c in D['categories'] for s in c['services']}

def retarget(tag):
    """Point one [data-booksy] anchor wherever booking.py says bookings go."""
    m = re.search(r'data-service="([^"]*)"', tag)
    href, attrs = booking.link(D, BY_ID.get(m.group(1)) if m else None)
    if re.search(r'\bhref="[^"]*"', tag):
        tag = re.sub(r'\bhref="[^"]*"', lambda _: 'href="' + href + '"', tag, count=1)
    else:
        tag = tag[:2] + ' href="' + href + '"' + tag[2:]
    # Rebuild target/rel rather than edit them: an internal link must not keep
    # the new-tab attributes Booksy needed.
    tag = re.sub(r'\s*\btarget="[^"]*"', '', tag)
    tag = re.sub(r'\s*\brel="[^"]*"', '', tag)
    return tag[:-1].rstrip() + attrs + '>'

NOINDEX_META = '  <meta name="robots" content="noindex,nofollow">\n'
HEADERS_BLOCK = ("""
# Booking page for the Square cutover. Live bookings still go through Booksy, so
# this page is not linked and must not be indexed until the swap.
/book.html
  X-Robots-Tag: noindex, nofollow
""")

def patch_booking_visibility():
    """While bookings go to Booksy the booking page is a private rehearsal and
       must stay out of search. The moment it becomes the real thing it has to
       be indexable, so this follows the same switch rather than waiting to be
       remembered on the day."""
    prov,_ = booking.cfg(D)
    want = (prov == 'booksy')
    notes=[]
    bp = os.path.join(HERE,'..','site','book.html')
    if os.path.exists(bp):
        b=open(bp,encoding='utf-8').read(); has = 'name="robots"' in b
        if want and not has:
            # after charset, so the character encoding still comes first
            b=b.replace('<meta charset="utf-8">','<meta charset="utf-8">\n'+NOINDEX_META.strip(),1)
            notes.append('book.html noindex added')
        elif not want and has:
            b=re.sub(r'\n?[ \t]*<meta name="robots"[^>]*>','',b); notes.append('book.html noindex removed')
        open(bp,'w',encoding='utf-8').write(b)
    hp = os.path.join(HERE,'..','site','_headers')
    if os.path.exists(hp):
        hh=open(hp,encoding='utf-8').read(); has = '/book.html' in hh
        if want and not has:
            hh=hh.rstrip('\n')+'\n'+HEADERS_BLOCK; notes.append('_headers noindex added')
        elif not want and has:
            hh=hh.replace(HEADERS_BLOCK,''); notes.append('_headers noindex removed')
        open(hp,'w',encoding='utf-8').write(hh)
    return ('booking page visibility: ' + ', '.join(notes)) if notes else \
           f"booking page visibility already correct for {prov}"

def patch_booking_schema():
    """What Google reads has to move with the links. The ReserveAction target is
       the booking URL search engines and assistants hand to people, and the
       sameAs entry points at a profile that stops being watched at cutover."""
    bp = os.path.join(HERE,'..','site','index.html')
    h = open(bp,encoding='utf-8').read()
    prov,_ = booking.cfg(D)
    target = booking.absolute(D)
    notes=[]
    m = re.search(r'("@type":\s*"ReserveAction",\s*\n\s*"target":\s*")([^"]*)(")', h)
    if m and m.group(2) != target:
        h = h[:m.start(2)] + target + h[m.end(2):]; notes.append(f'ReserveAction -> {target}')
    same = '    "' + D['booksy']['profile_url'] + '",\n'
    if prov == 'booksy' and same not in h:
        h = h.replace('  "sameAs": [\n', '  "sameAs": [\n' + same, 1); notes.append('Booksy listed in sameAs')
    elif prov != 'booksy' and same in h:
        h = h.replace(same, '', 1); notes.append('Booksy dropped from sameAs')
    open(bp,'w',encoding='utf-8').write(h)
    return ('schema: ' + ', '.join(notes)) if notes else 'schema already points at the right place'

def patch_booking_links():
    """Every booking link on every page, generated or hand-written, follows the
       one switch in prices.json. Hand-written ones are the reason this exists:
       the generators never see them, so at cutover they would quietly go on
       pointing at Booksy."""
    root = os.path.join(HERE, '..', 'site')
    changed, total = [], 0
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            if not fn.endswith('.html'):
                continue
            fp = os.path.join(dirpath, fn)
            h = open(fp, encoding='utf-8').read()
            n = len(A_TAG.findall(h))
            if not n:
                continue
            total += n
            out = A_TAG.sub(lambda m: retarget(m.group(0)), h)
            if out != h:
                open(fp, 'w', encoding='utf-8').write(out)
                changed.append(os.path.relpath(fp, root))
    prov, _ = booking.cfg(D)
    return f"{total} booking links point at {prov}" + (f" — rewrote {', '.join(changed)}" if changed else " — all already correct")

def checklist():
    ch=[s for c in D['categories'] for s in c['services']
        if s.get('prev_price') is not None and s['price']!=s['prev_price']]
    new=[s for c in D['categories'] for s in c['services'] if s.get('prev_price') is None]
    ren=[s for c in D['categories'] for s in c['services'] if s.get('booksy_rename_from')]
    L=[]
    L.append("="*62)
    L.append(f"PLATFORM CHECKLIST — effective {D['meta']['effective_date']}")
    L.append("="*62)
    if ch:
        L.append("\nPRICE CHANGES  (update on every platform)")
        for s in ch: L.append(f"   {s['name']:<30} ${s['prev_price']:>3}  ->  ${s['price']}")
    if new:
        L.append("\nNEW SERVICES  (create in Booksy first, then paste variantId into prices.json)")
        for s in new: L.append(f"   {s['name']:<30} ${s['price']:>3}   {s['minutes']} min")
    if ren:
        L.append("\nRENAME IN BOOKSY  (edit the name — do NOT delete, it keeps the variantId)")
        for s in ren: L.append(f"   {s['booksy_rename_from']}  ->  {s['name']}")
    L.append("\nUPDATE ON:  [ ] Booksy   [ ] Google   [ ] Yelp   [ ] Apple   [ ] Facebook")
    L.append("            (Bing syncs from Google — no action)")
    miss=[s['name'] for c in D['categories'] for s in c['services'] if not s.get('variantId')]
    if miss:
        L.append(f"\nMISSING BOOKSY DEEP LINKS ({len(miss)}) — these fall back to the profile URL:")
        for m_ in miss: L.append(f"   {m_}")
    return "\n".join(L)

if __name__=="__main__":
    e=validate()
    if e:
        print("VALIDATION FAILED:"); [print("   !",x) for x in e]; sys.exit(1)
    print("validation passed\n")
    print(patch_site())
    import build_pages
    for f in build_pages.build(): print("rebuilt", f)
    print(patch_booking_links())
    print(patch_booking_visibility())
    print(patch_booking_schema()); print()
    print(checklist())
    open(os.path.join(HERE,'CHECKLIST.txt'),'w').write(checklist()+"\n")
