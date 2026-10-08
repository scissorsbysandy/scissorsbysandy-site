SCISSORS BY SANDY — PRICING SYSTEM
==================================

WHAT THIS IS
  prices.json  is the single source of truth for every price, duration and
  description. Nothing else should be hand-edited.

HOW TO CHANGE A PRICE
  1. Open prices.json
  2. Find the service. Move its current "price" value into "prev_price",
     then set "price" to the new figure.
  3. Run:   python3 build.py
  4. Commit and push to GitHub. Netlify runs the preflight and publishes.
  5. Work through CHECKLIST.txt for the platforms.

WHAT build.py DOES AUTOMATICALLY
  - rewrites the Services section of site/index.html
  - rebuilds every Booksy deep link from the variantIds
  - updates the priceRange in the search-engine structured data
  - writes CHECKLIST.txt

WHAT IT CHECKS BEFORE WRITING ANYTHING
  - no duplicate service ids
  - no price accidentally lowered
  - package savings actually equal components minus price
  - package durations actually equal the sum of their components
  If any check fails it stops and changes nothing.

WHAT IT CANNOT DO
  Booksy, Google, Yelp, Apple and Facebook have no reachable API,
  so those five are still entered by hand. CHECKLIST.txt tells you
  exactly what to type where. (Bing syncs from Google - no action.)

WHEN YOU CREATE A NEW SERVICE IN BOOKSY
  Copy its variantId from the booking URL into prices.json and re-run
  build.py. The website link stops falling back to the general profile
  and becomes a direct deep link to that service.


VERIFYING AGAINST BOOKSY  (verify.py)
  Checks that what is actually live on your Booksy page matches prices.json.
  It reads the same public profile page any client sees - no login, no API.

  Run it AFTER you finish updating Booksy, BEFORE you deploy the website:

      python3 verify.py

  If your network blocks the fetch, open your Booksy profile in a browser,
  save the page (Ctrl-S / Cmd-S), then:

      python3 verify.py saved.html

  It reports:
    ok  service matches on both price and duration
    !!  MISMATCH - price or duration differs, with both values shown
    --  in prices.json but not found on Booksy (not created yet?)
    ++  a priced item on Booksy with no matching name in prices.json
        (usually an old service that still needs renaming or retiring)

  Exit code 0 = in sync and safe to deploy.  1 = fix something first.

  It deliberately ignores service names that appear inside package
  descriptions, so "The Executive cut paired with The Majesty..." will not
  be mistaken for The Majesty's own listing.

WHAT IT CANNOT SEE
  variantIds. The Book buttons on the public page are JavaScript, so the
  ids never appear in the HTML. Grab those by hand once per new service:
  open the service on your public page, click Book, copy the number after
  variantId= in the URL, paste into prices.json, re-run build.py.


PREFLIGHT  (preflight.py)
  Run before EVERY deploy. Exit 0 = safe, exit 1 = do not ship.

      python3 preflight.py

  Checks, each one added because something actually broke once:
    - HTML well-formed, CSS/JS braces balanced
    - both schema blocks parse; priceRange matches the real min/max
    - every price on the page equals prices.json
    - every service has a variantId and the deep links are unique
    - the in-page SERVICE_IDS map matches prices.json  <-- this one shipped
      broken: a leftover script rewrites every booking href on page load,
      so a stale map silently sends clients to the general menu
    - no GA4 placeholder left behind
    - no known stale wording (Gift Cards, Groom & Relax, Back to School,
      "The Statesman beard trim")
    - every service in prices.json actually appears on the page
    - sitemap lastmod is today, or crawlers ignore the update
    - all 14 deploy files present
    - package savings and durations reconcile against their components

  Verified against deliberate breakage - all four test failures were caught.

  Preflight does NOT open a browser. Layout, overflow, contrast, tap
  targets and image sizing still need the render pass.
