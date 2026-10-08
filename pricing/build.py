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
            href=(WID+s['variantId']) if s.get('variantId') else PROF
            ds=f' data-service="{s["id"]}"' if s.get('variantId') else ''
            save=f' <span class="item-save">Save ${s["save"]}</span>' if s.get('save') else ''
            out.append('      <div class="item">')
            out.append(f'      <div class="item-line"><span class="item-name">{s["name"]}</span>'
                       f'<span class="leader" aria-hidden="true"></span>'
                       f'<span class="item-price">${s["price"]}</span></div>')
            out.append(f'      <p class="item-dur">{s["minutes"]} min{save}</p>')
            out.append(f'      <p>{s["desc"]}</p>')
            out.append(f'      <a class="book-link" data-booksy{ds} href="{href}" target="_blank" rel="noopener">Book this service &rarr;</a>')
            out.append('    </div>')
        out.append('    </div>')
        if c.get('note'):
            out.append(f'    <p class="cat-note">{c["note"]}</p>')
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
    return "var SERVICE_IDS = {\n"+",\n".join(out)+"\n    };"

def patch_site():
    if not os.path.exists(SITE): return "site/index.html not found — skipped"
    h=open(SITE).read()
    m=re.search(r'var SERVICE_IDS = \{.*?\};', h, re.S)
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
    print(patch_site()); print()
    print(checklist())
    open(os.path.join(HERE,'CHECKLIST.txt'),'w').write(checklist()+"\n")
