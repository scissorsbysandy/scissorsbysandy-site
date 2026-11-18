#!/usr/bin/env python3
"""
Where "Book" goes.

One switch for the whole site. Until the Square cutover every booking link
points at Booksy; setting booking.provider to "site" in prices.json points all
of them at the booking page instead, in a single deploy, with no stray link
left pointing at a system Sandy no longer uses.

Both build.py and build_pages.py ask this module, so there is one answer and
nowhere for a page to disagree.
"""

SITE_ORIGIN = "https://scissorsbysandy.com"
PROVIDERS = ("booksy", "site")


def cfg(D):
    b = D.get("booking") or {}
    provider = b.get("provider", "booksy")
    if provider not in PROVIDERS:
        raise SystemExit(
            f"prices.json: booking.provider must be one of {PROVIDERS}, not {provider!r}")
    return provider, b.get("site_path", "/book.html")


def link(D, service=None):
    """(href, extra attributes) for one booking link.

    `service` is a service dict from prices.json, or None for a general
    "Book Online" link. Booksy opens in a new tab because it is somebody
    else's site; the booking page is ours, so it does not.
    """
    provider, path = cfg(D)
    if provider == "booksy":
        vid = (service or {}).get("variantId")
        href = (D["booksy"]["widget_base"].replace("&", "&amp;") + vid) if vid \
               else D["booksy"]["profile_url"]
        return href, ' target="_blank" rel="noopener"'
    sid = (service or {}).get("id")
    return path + (("?service=" + sid) if sid else ""), ""


def absolute(D):
    """The booking URL written out in plain text, as in llms.txt."""
    provider, path = cfg(D)
    return D["booksy"]["profile_url"] if provider == "booksy" else SITE_ORIGIN + path
