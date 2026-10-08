# scissorsbysandy.com

The website for Scissors by Sandy, a private one-chair barber suite at
The Shoppes at Old Bridge, 3813 US 9 North, Suite 101, Old Bridge, NJ 08857.

## How this works

- `site/` is the live website. Netlify publishes it automatically whenever
  this repository changes.
- `pricing/prices.json` is the single source of truth for every price,
  duration and description. See `pricing/README.txt`.
- `pricing/preflight.py` runs before every deploy, on Netlify itself.
  If any check fails, Netlify refuses to publish and the current site stays up.
- Changes go to a branch with a pull request first. Netlify builds a free
  Deploy Preview for review; merging to `main` publishes (15 credits).

## Rules

1. Never hand-edit prices in `site/index.html`. Edit `prices.json`, run `build.py`.
2. `<lastmod>` in `site/sitemap.xml` is stamped automatically on every
   Netlify build (`pricing/stamp_sitemap.py`). No need to bump it by hand.
3. Images are cached for one day, so a replaced photo (same filename)
   shows up within a day. Never mark them `immutable`; preflight blocks it.
4. Do not upload the site to Netlify by hand any more. A manual upload is
   overwritten by the next change here.
