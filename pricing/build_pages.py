#!/usr/bin/env python3
"""
Scissors by Sandy — service pages.

Builds the four dedicated pages from prices.json plus the homepage:
    site/haircuts/index.html
    site/hot-towel-shaves/index.html
    site/facials-and-treatments/index.html
    site/weddings/index.html

Run automatically at the end of build.py, or on its own:  python3 build_pages.py

Everything a visitor could see disagree between pages is pulled from ONE place:
  - prices, durations, descriptions, Booksy deep links  -> prices.json
  - styles, promo bar, hours, footer, analytics          -> site/index.html
So a price change is one edit in prices.json, then build.py, and every page follows.
The preflight re-checks all of it before any deploy.
"""
import json, os, re, html

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, '..', 'site')
D = json.load(open(os.path.join(HERE, 'prices.json')))
WID = D['booksy']['widget_base'].replace('&', '&amp;')
PROF = D['booksy']['profile_url']
BASE = 'https://scissorsbysandy.com'
TEL = '<a href="tel:+18482305995">(848) 230-5995</a>'
SVC = {s['id']: s for c in D['categories'] for s in c['services']}
CAT = {s['id']: c for c in D['categories'] for s in c['services']}

# ---------------------------------------------------------------- the pages
# Copy is written in Sandy's voice: first person, warm, plain. Never ranks one
# service above another, never repeats her years outside Meet Sandy, never shows
# a review count, keeps Reuzel to haircuts, and says "deep pore cleanse", never
# "extractions", for the facial.
def P(i): return f"${SVC[i]['price']}"
def M(i): return f"{SVC[i]['minutes']} min"

PAGES = [
  dict(
    slug='haircuts', guide_sub='A quick guide', nav='Haircuts',
    title="Men's Haircuts in Old Bridge, NJ | Scissors by Sandy",
    desc="Scissor cuts, skin fades, crew cuts and kids' cuts in a private one-chair barber suite in Old Bridge, NJ. Every cut includes a wash. By appointment.",
    h1="Men's Haircuts", where="Old Bridge, NJ",
    tag="Scissor cuts · Fades · Crew cuts · Kids",
    intro="Every cut in my chair starts with a wash and a real conversation about what you want and how you wear your hair day to day. Then I take my time. It's one chair, so nobody is waiting on you and nothing gets rushed.",
    groups=[("The Cuts", ['executive','signature','freshfade','regiment','royalroots'],
             "In the chair, I use Reuzel hair products."),
            ("Color", ['greyblend'], None)],
    guide=("Which cut is yours?", [
        ("Scissors only", f"The Executive. Shaped entirely with shears, no clippers at all. Grows out softer. {M('executive')}."),
        ("Clippers and shears", f"The Signature. Both tools, blended so you can't see where one stops. {M('signature')}."),
        ("A skin fade", f"The Fresh Fade. Clippers only, from a bare skin line up. {M('freshfade')}."),
        ("Short and even", f"The Regiment. The classic crew cut, uniform rather than faded. {M('regiment')}."),
        ("Ages 12 and under", f"The Royal Roots. Patient and unhurried. {M('royalroots')}."),
    ]),
    quotes=["Anthony R.", "Danielle K."],
    faq=[
      ("Is a wash included?", "Yes. Every haircut on my menu includes a wash."),
      ("What makes The Executive different?", f"It's cut entirely with shears, no clippers and no guards, with every line judged by eye. That takes longer, about {M('executive')}, and the result grows out softer and sits more naturally."),
      ("Do you cut children's hair?", "Yes. The Royal Roots is a wash and cut for my youngest gentlemen, ages 12 and under. Patient, unhurried, and taken as seriously as any cut in the chair."),
      ("Can I add a shave or beard work to my cut?", f"Yes. My packages pair a cut with a hot towel shave or beard shaping for less than booking them separately, from {P('gentleman')} to {P('sovereign')}. You'll find them on the hot towel shaves page."),
    ],
    more=['hot-towel-shaves', 'facials-and-treatments', 'weddings'],
  ),
  dict(
    slug='hot-towel-shaves', guide_sub='A quick guide', nav='Shaves',
    title="Hot Towel Shaves in Old Bridge, NJ | Scissors by Sandy",
    desc="Traditional straight razor hot towel shaves and beard shaping in a private one-chair barber suite in Old Bridge, NJ. The Royal, The Majesty and The Statesman.",
    h1="Hot Towel Shaves", where="Old Bridge, NJ",
    tag="Straight razor · Warm towels · Beard shaping",
    intro="A real hot towel shave needs time, and in my suite there's nobody waiting behind you. Warm towels soften the beard, the straight razor does the rest, and you walk out feeling better than when you came in.",
    groups=[("Shaves & Beard", ['majesty','royal','statesman'], None),
            ("Pair It With a Cut", ['sovereign','regent','ambassador','officer','gentleman'], None)],
    guide=("Which one should I book?", [
        ("A close shave", f"The Royal. Warm towels, premium products, a straight razor shave and a beard trim. {M('royal')}."),
        ("The whole ritual", f"The Majesty. Everything in The Royal, plus facial steam, exfoliation and a customized mini facial to finish. {M('majesty')}."),
        ("Keeping the beard", f"The Statesman. Full beard sculpting with clippers and a hot towel, no straight razor. {M('statesman')}."),
    ]),
    quotes=["Jon D."],
    faq=[
      ("What's the difference between The Royal and The Majesty?", f"The Royal is a traditional straight razor shave with warm towels, premium products and a beard trim, in {M('royal')}. The Majesty takes {M('majesty')} and adds facial steam, exfoliation and a customized mini facial to finish."),
      ("I want to keep my beard. What should I book?", "The Statesman. It's full beard sculpting and detailing with clippers and a hot towel, shaped to your face, with no straight razor."),
      ("Can I get a shave and a haircut together?", f"Yes. The packages pair a cut with a shave or beard shaping for less than booking each on its own, from {P('gentleman')} for The Gentleman to {P('sovereign')} for The Sovereign."),
    ],
    more=['haircuts', 'facials-and-treatments', 'weddings'],
  ),
  dict(
    slug='facials-and-treatments', guide_sub='Thirty minutes, start to finish', nav='Treatments',
    title="Men's Facials & Treatments in Old Bridge, NJ | Scissors by Sandy",
    desc="A 30-minute men's mini facial, scalp treatment and nose, ear and eyebrow waxing in a private one-chair barber suite in Old Bridge, NJ. By appointment.",
    h1="Facials & Treatments", where="Old Bridge, NJ",
    tag="Mini facial · Scalp treatment · Waxing",
    intro="Not every visit has to be about the haircut. A thirty-minute facial, a scalp treatment, or a quick tidy of brows and ears, done privately in my suite with nobody else in the room. Book any of them on their own, or add them to your cut.",
    groups=[("Treatments", ['minifacial','scalp'], None),
            ("Waxing", ['nosewax','earwax','browwax'], None),
            ("With a Cut", ['diplomat'], None)],
    guide=("What to expect from the Mini Facial", [
        ("Steam and towels", "Warm steam and towels to relax the skin and open things up."),
        ("Cleanse", "A gentle cleanse and exfoliation, then a deep pore cleanse."),
        ("Finish", "A hydrating mask and a moisturizer suited to your skin."),
    ]),
    quotes=["Jim F."],
    faq=[
      ("How long is the Mini Facial?", f"Thirty minutes, {P('minifacial')}. It's relaxing on its own, or you can add it to any cut."),
      ("Can I add a treatment to my haircut?", f"Yes. Book them together and they're done in one visit. The Diplomat pairs The Signature cut with a Scalp Treatment for {P('diplomat')}."),
      ("How long does waxing take?", "About ten minutes each for nose, ear or eyebrow waxing, so they fit easily into any appointment."),
    ],
    more=['haircuts', 'hot-towel-shaves', 'weddings'],
  ),
  dict(
    slug='weddings', guide_sub='Planned with you, timed for the photos', nav='Weddings', wedding=True,
    title="Wedding Haircuts & Groom Packages in Old Bridge, NJ | Scissors by Sandy",
    desc="Groom and groomsmen packages in a private one-chair barber suite in Old Bridge, NJ: a trial cut, a wedding-week cut and shave, and a day-before touch-up.",
    h1="Weddings", where="Old Bridge, NJ",
    tag="For the groom and his party",
    intro="A wedding cut isn't a regular cut. I plan it with you, test it, and time it so it looks its best in every photo. Every appointment is private, one client at a time, in my own suite.",
    groups=[("Book Your Own Appointment", ['gentleman','ambassador'], "Wedding party rate: $10 off each when three or more of you book for the same wedding.")],
    guide=("The groom's timeline", [
        ("4 to 6 weeks out", "Consultation and trial cut. We settle the style and the timing together."),
        ("2 to 5 days before", "Wedding-week visit: your cut, The Majesty Hot Towel Shave or The Statesman for a beard, and a Scalp Treatment."),
        ("The day before", "A quick touch-up of the neckline and edges, so everything is crisp for the photos."),
    ]),
    quotes=["Ross M."],
    faq=[
      ("When should I book?", "Wedding weeks fill up fast. Reach out 2 to 3 months before the date."),
      ("When should I get my wedding haircut?", "Fades look sharpest cut 1 to 3 days before; tapers settle best about a week out. I'll set your timing at the consultation."),
      ("Can the whole wedding party come in together?", "Yes. The Wedding Party reserves the suite for the groom and four groomsmen for $595, on the day and time you choose. Additional groomsmen are $110 each, up to six of you in all."),
      ("Is there a deposit?", "Only for The Wedding Party, which is held with a 50% deposit, refundable up to 7 days before the date. The Groom and The Groomsmen need no deposit."),
    ],
    more=['haircuts', 'hot-towel-shaves', 'facials-and-treatments'],
  ),
]
BY = {p['slug']: p for p in PAGES}
LABEL = {'haircuts': "Haircuts", 'hot-towel-shaves': "Hot Towel Shaves",
         'facials-and-treatments': "Facials & Treatments", 'weddings': "Weddings"}
BLURB = {'haircuts': "Scissor cuts, fades, crew cuts and kids' cuts, every one with a wash.",
         'hot-towel-shaves': "Straight razor shaves, beard shaping, and cut and shave packages.",
         'facials-and-treatments': "The 30-minute mini facial, scalp treatment and waxing.",
         'weddings': "A trial cut, a wedding-week visit and a day-before touch-up."}

# ---------------------------------------------------------------- helpers
def esc(t): return html.escape(t, quote=False)
def text(h_): return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', h_))).strip()

def item(s):
    href = (WID + s['variantId']) if s.get('variantId') else PROF
    ds = f' data-service="{s["id"]}"' if s.get('variantId') else ''
    save = f' <span class="item-save">Save ${s["save"]}</span>' if s.get('save') else ''
    return ('      <div class="item">\n'
            f'      <div class="item-line"><span class="item-name">{s["name"]}</span>'
            f'<span class="leader" aria-hidden="true"></span><span class="item-price">${s["price"]}</span></div>\n'
            f'      <p class="item-dur">{s["minutes"]} min{save}</p>\n'
            f'      <p>{s["desc"]}</p>\n'
            f'      <a class="book-link" data-booksy{ds} href="{href}" target="_blank" rel="noopener">Book this service &rarr;</a>\n'
            '    </div>')

def grab(h_, pat, what):
    m = re.search(pat, h_, re.S)
    if not m: raise SystemExit(f"build_pages: could not find the {what} on the homepage")
    return m.group(1) if m.groups() else m.group(0)

EXTRA_CSS = """
  /* ===== service pages (generated by pricing/build_pages.py) ===== */
  body.sub .topstack{position:sticky;top:0}
  .crumbs{font-size:.7rem;letter-spacing:.18em;text-transform:uppercase;color:#c9cfd4;margin-bottom:1.6rem}
  .crumbs a{color:var(--gold);text-decoration:none}
  .page-hero{position:relative;overflow:hidden;text-align:center;color:var(--cream);
    padding:4.6rem 7vw 4.2rem;border-bottom:5px solid var(--gold-deep);
    background:radial-gradient(ellipse 70% 60% at 50% 0%, var(--navy-lift) 0%, rgba(44,84,122,0) 70%),
      linear-gradient(180deg,var(--navy) 0%,var(--navy-deep) 100%)}
  .page-hero img.mark{width:64px;height:auto;aspect-ratio:1;display:block;margin:0 auto 1.2rem;
    filter:drop-shadow(0 3px 14px rgba(0,0,0,.30))}
  .page-hero h1{font-size:clamp(1.7rem,5vw,3.1rem);letter-spacing:.16em;margin-bottom:.5rem;line-height:1.2}
  .page-hero .where{display:block;font-family:var(--sans);font-weight:300;font-size:.34em;letter-spacing:.42em;
    color:#cfd6db;-webkit-text-fill-color:#cfd6db;margin-top:.7rem}
  .page-hero .tagline{margin-bottom:1.6rem}
  .page-intro{max-width:60ch;margin:0 auto 2.2rem;font-family:var(--serif);font-size:1.22rem;line-height:1.7;color:var(--cream)}
  .page-hero .cta-row{margin-top:.2rem}
  .guide{background:var(--cream);border-top:5px solid var(--gold-deep);border-bottom:5px solid var(--gold-deep)}
  .guide-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:1.6rem;max-width:1080px;margin:0 auto}
  .guide-grid div{background:#fff;border:1px solid rgba(162,126,60,.45);padding:1.5rem 1.4rem;min-width:0}
  .guide-grid h3{font-family:var(--serif);font-weight:600;font-size:1.2rem;letter-spacing:.06em;color:var(--ink);margin-bottom:.45rem}
  .guide-grid p{font-size:.95rem;color:var(--ink-soft);line-height:1.65}
  .menu .cat-lead{text-align:center;margin:-1rem auto 1.6rem;font-family:var(--serif);font-style:italic;font-size:1.05rem;color:var(--ink-soft);max-width:60ch}
  .quote-grid.one{grid-template-columns:minmax(0,640px);justify-content:center}
  .quote-grid.two{grid-template-columns:repeat(2,minmax(0,1fr));max-width:900px}
  @media (max-width:900px){ .quote-grid.two{grid-template-columns:1fr} }
  .visit-strip{text-align:center}
  .more-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1.4rem;max-width:1000px;margin:0 auto}
  @media (max-width:820px){ .more-grid{grid-template-columns:1fr;max-width:520px} }
  .more-grid a{display:block;text-decoration:none;border:1px solid rgba(162,126,60,.55);padding:1.4rem 1.3rem;background:#fff;transition:border-color .2s,transform .2s}
  .more-grid a:hover{border-color:var(--gold-deep);transform:translateY(-2px)}
  .more-grid b{display:block;font-family:var(--serif);font-weight:600;font-size:1.2rem;letter-spacing:.08em;color:var(--ink);margin-bottom:.3rem}
  .more-grid span{font-size:.9rem;color:var(--ink-soft)}
  #more{background:var(--cream);border-top:5px solid var(--gold-deep)}
  @media (max-width:599px){
    .page-hero{padding:3.4rem 6vw 3.4rem}
    .page-hero h1{letter-spacing:.08em}
    .page-hero .where{letter-spacing:.24em;font-size:.4em}
    .page-intro{font-size:1.08rem}
    .page-hero .cta-row .btn{font-size:.72rem;padding:.85rem 1.3rem}
  }
"""

def build():
    home = open(os.path.join(SITE, 'index.html'), encoding='utf-8').read()
    css = grab(home, r'<style>(.*?)</style>', 'stylesheet')
    promo = grab(home, r'(<div class="promo-bar">.*?</div>)', 'promo bar')
    ga = grab(home, r'(<!-- Google Analytics 4 -->.*?</script>\s*<script>.*?</script>)', 'analytics block')
    hours = grab(home, r'<h3 class="visit-h">Hours</h3>\s*<p>(.*?)</p>', 'hours')
    footer = grab(home, r'(<footer>.*?</footer>)', 'footer')
    fonts = grab(home, r'(<link rel="preconnect" href="https://fonts\.googleapis\.com">.*?rel="stylesheet">)', 'font links')
    footer = footer.replace('href="#top"', 'href="/"')
    out = []
    for p in PAGES:
        url = f"{BASE}/{p['slug']}/"
        # ---- services
        menu = ['  <div class="menu">']
        offers = []
        for gname, ids, note in p['groups']:
            menu.append(f'    <h3>{gname}</h3>')
            if note and p.get('wedding'): menu.append(f'    <p class="cat-lead">{note}</p>')
            menu.append('    <div class="cat-items">')
            for i in ids:
                menu.append(item(SVC[i]))
                offers.append({"@type": "Offer", "name": text(SVC[i]['name']), "price": str(SVC[i]['price']),
                               "priceCurrency": "USD", "url": url})
            menu.append('    </div>')
            if note and not p.get('wedding'): menu.append(f'    <p class="cat-note">{note}</p>')
        menu.append('  </div>')
        # ---- guide
        gt, gitems = p['guide']
        guide = '\n'.join(f'    <div><h3>{esc(a)}</h3><p>{esc(b)}</p></div>' for a, b in gitems)
        # ---- quotes
        qcls = 'one' if len(p['quotes']) == 1 else 'two'
        def quote(name):  # verbatim from the homepage, so a review is never reworded
            m = re.search(r'<blockquote>((?:(?!<blockquote>).)*?)</blockquote>\s*<(?:cite|figcaption)>' + re.escape(name), home, re.S)
            if not m: raise SystemExit(f"build_pages: review by {name} not found on the homepage")
            return m.group(1).strip()
        quotes = '\n'.join(f'    <div class="quote">\n      <div class="stars">★★★★★</div>\n'
                           f'      <blockquote>{quote(c)}</blockquote>\n      <cite>{esc(c)}</cite>\n    </div>'
                           for c in p['quotes'])
        # ---- faq (visible text and schema built from the SAME strings, so they can't drift)
        faq_html = '\n'.join(f'      <details class="faq-item">\n        <summary>{esc(q)}</summary>\n'
                             f'        <p>{esc(a)}</p>\n      </details>' for q, a in p['faq'])
        faq_ld = {"@context": "https://schema.org", "@type": "FAQPage",
                  "mainEntity": [{"@type": "Question", "name": q,
                                  "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in p['faq']]}
        svc_ld = {"@context": "https://schema.org", "@type": "Service",
                  "name": f"{text(p['h1'])} in {p['where']}", "url": url,
                  "description": p['desc'],
                  "provider": {"@type": "BarberShop", "@id": BASE + "/#barbershop", "name": "Scissors by Sandy",
                               "url": BASE + "/", "telephone": "+18482305995",
                               "address": {"@type": "PostalAddress", "streetAddress": "3813 US 9 North, Suite 101",
                                           "addressLocality": "Old Bridge", "addressRegion": "NJ",
                                           "postalCode": "08857", "addressCountry": "US"}},
                  "areaServed": ["Old Bridge, NJ", "Matawan, NJ", "Marlboro, NJ", "Manalapan, NJ",
                                 "Monroe Township, NJ", "East Brunswick, NJ", "Sayreville, NJ", "Aberdeen, NJ"],
                  "offers": offers}
        crumbs_ld = {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": BASE + "/"},
            {"@type": "ListItem", "position": 2, "name": LABEL[p['slug']], "item": url}]}
        ld = '\n'.join(f'<script type="application/ld+json">\n{json.dumps(x, indent=2, ensure_ascii=False)}\n</script>'
                       for x in (svc_ld, crumbs_ld, faq_ld))
        # ---- nav
        navl = [('/', 'Home')] + [(f"/{q['slug']}/", q['nav']) for q in PAGES] + [('/#visit', 'Visit')]
        nav = '\n'.join(f'    <li><a href="{h_}"{" aria-current=\"page\"" if h_ == "/"+p["slug"]+"/" else ""}>{t}</a></li>'
                        for h_, t in navl)
        # ---- wedding packages block (wedding page only), copied from the homepage so the two never differ
        wed = ''
        if p.get('wedding'):
            wed = grab(home, r'(<div class="wed-grid">.*?</div>\s*</div>)\s*<div class="wed-know">', 'wedding packages')
            wed = ('<section id="weddings" aria-label="Wedding packages">\n'
                   '  <h2 class="sec-head">The Packages</h2>\n  <p class="sec-sub">Booked by call or text</p>\n  '
                   + wed + '\n  <div class="wed-cta"><a class="btn btn-gold" href="tel:+18482305995">'
                   'Call or Text (848) 230-5995 to Plan Your Date</a></div>\n</section>\n')
        more = '\n'.join(f'    <a href="/{s}/"><b>{esc(LABEL[s])}</b><span>{esc(BLURB[s])}</span></a>' for s in p['more'])
        book_btn = ('<a class="btn btn-gold" href="tel:+18482305995">Call or Text to Plan</a>\n'
                    f'    <a class="btn btn-line" href="#services">Groomsmen Services</a>') if p.get('wedding') else \
                   (f'<a class="btn btn-gold" href="{PROF}" data-booksy target="_blank" rel="noopener">Book Online</a>\n'
                    '    <a class="btn btn-line" href="tel:+18482305995">Call or Text</a>')
        svc_head = 'Groomsmen Services' if p.get('wedding') else 'Services &amp; Pricing'
        svc_sub = 'Bookable online' if p.get('wedding') else 'Every price, every duration'
        page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<!-- GENERATED by pricing/build_pages.py from prices.json and site/index.html. Do not edit by hand. -->
<title>{esc(p['title'])}</title>
  <link rel="canonical" href="{url}">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
  <link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <meta name="theme-color" content="#16293C">
  <meta name="description" content="{html.escape(p['desc'])}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Scissors by Sandy">
  <meta property="og:url" content="{url}">
  <meta property="og:title" content="{html.escape(p['title'])}">
  <meta property="og:description" content="{html.escape(p['desc'])}">
  <meta property="og:image" content="{BASE}/og-image.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:locale" content="en_US">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="preconnect" href="https://www.googletagmanager.com">
{fonts}
{ld}
<style>{css}{EXTRA_CSS}</style>
{ga}
</head>
<body class="sub">

<div class="topstack">
  {promo}
<nav aria-label="Main">
  <a class="nav-brand gold-grad" href="/">SCISSORS BY SANDY</a>
  <ul>
{nav}
  </ul>
</nav>
</div>

<header class="page-hero" id="top">
  <p class="crumbs"><a href="/">Home</a> &rsaquo; {esc(LABEL[p['slug']])}</p>
  <picture><source srcset="/sbs-emblem.webp" type="image/webp"><img class="mark" src="/sbs-emblem.png" alt="Scissors by Sandy emblem" width="230" height="230" decoding="async"></picture>
  <h1 class="gold-grad">{esc(p['h1'])}<span class="where">in {esc(p['where'])}</span></h1>
  <p class="tagline">{esc(p['tag'])}</p>
  <p class="page-intro">{esc(p['intro'])}</p>
  <div class="cta-row">
    {book_btn}
  </div>
  <p class="book-help">Trouble booking online? Call or text Sandy at {TEL}</p>
</header>

{wed}<section id="services">
  <h2 class="sec-head">{svc_head}</h2>
  <p class="sec-sub">{svc_sub}</p>
  <p class="responders">First responders get $5 off their total &mdash; every visit.</p>
{chr(10).join(menu)}
</section>

<section class="guide" id="guide">
  <h2 class="sec-head">{esc(gt)}</h2>
  <p class="sec-sub">{esc(p['guide_sub'])}</p>
  <div class="guide-grid">
{guide}
  </div>
</section>

<section id="words">
  <h2 class="sec-head">What Clients Say</h2>
  <p class="sec-sub">Rated 5.0 stars on Google</p>
  <div class="quote-grid {qcls}">
{quotes}
  </div>
  <p class="quote-note">Read every review on <a href="https://search.google.com/local/reviews?placeid=ChIJv508gQTPw4kRJdMmGQk01zw" target="_blank" rel="noopener">Google</a></p>
</section>

<section id="faq">
  <h2 class="sec-head">Common Questions</h2>
  <div class="faq-wrap">
{faq_html}
  </div>
</section>

<section id="visit" class="visit-strip">
  <h2 class="sec-head">Visit the Shop</h2>
  <p class="sec-sub">By appointment only</p>
  <div class="visit-grid">
    <div>
      <h3 class="visit-h">Location</h3>
      <p>The Shoppes at Old Bridge<br>3813 US 9 North, Suite 101<br>Old Bridge, NJ 08857</p>
      <p style="margin-top:.6rem"><a href="https://www.google.com/maps/search/?api=1&amp;query=Scissors+by+Sandy+Old+Bridge+NJ&amp;query_place_id=ChIJv508gQTPw4kRJdMmGQk01zw" target="_blank" rel="noopener" style="color:var(--gold-text);letter-spacing:.12em;text-transform:uppercase;font-size:.8rem">Get Directions &rarr;</a></p>
    </div>
    <div>
      <h3 class="visit-h">Hours</h3>
      <p>{hours}</p>
    </div>
    <div>
      <h3 class="visit-h">Book</h3>
      <p><a class="btn btn-gold" href="{PROF}" style="font-size:.72rem;padding:.75rem 1.8rem" data-booksy target="_blank" rel="noopener">Book Online</a></p>
      <p style="margin-top:.9rem">{TEL}</p>
      <p style="margin-top:.3rem;font-size:.85rem">Or call / text for an appointment, or if online booking gives you trouble</p>
    </div>
  </div>
</section>

<section id="more">
  <h2 class="sec-head">Also in the Chair</h2>
  <p class="sec-sub">More from the suite</p>
  <div class="more-grid">
{more}
  </div>
</section>

{footer}
</body>
</html>
"""
        d = os.path.join(SITE, p['slug']); os.makedirs(d, exist_ok=True)
        open(os.path.join(d, 'index.html'), 'w', encoding='utf-8').write(page)
        out.append(f"site/{p['slug']}/index.html")
    return out

if __name__ == '__main__':
    for f in build(): print('wrote', f)
