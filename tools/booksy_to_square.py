#!/usr/bin/env python3
"""
Booksy -> Square forward-book migration.

Reads a Booksy appointments CSV export, keeps the appointments that still
need to happen, groups a client's back-to-back services into ONE Square
booking with several segments, and writes the Square CreateBooking payloads.

It deliberately does not call Square itself: the payloads are reviewed, then
posted. Nothing is created by running this file.

Join key is the PHONE, never the name. Booksy's calendar and its export both
abbreviate surnames (a first name plus an initial), so matching on name silently
creates duplicate customers.
"""
import csv, json, sys, re
from datetime import datetime, timedelta

LOCATION = "LDGXV0WRF8BFN"
TEAM_MEMBER = "TMcPuss1Jbyk7-WC"

def norm_phone(p):
    """Booksy writes '+1 7324078738'; Square stores '+17324078738'."""
    if not p or p == "null":
        return None
    d = re.sub(r"\D", "", p)
    if len(d) == 10:
        d = "1" + d
    return "+" + d if d else None

def load(path, cutover):
    """Appointments from `cutover` onward that are still expected to happen."""
    keep = []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if (r.get("status") or "").strip() not in ("Confirmed",):
                continue
            start = datetime.strptime(r["booked_from"], "%Y-%m-%d %H:%M:%S")
            if start.date() < cutover:
                continue
            phone = norm_phone(r.get("customer_card_phone"))
            if not phone:
                continue  # no join key: must be handled by hand
            keep.append({
                "start": start,
                "end": datetime.strptime(r["booked_till"], "%Y-%m-%d %H:%M:%S"),
                "phone": phone,
                "name": (r.get("customer_first_name") or "").strip(),
                "service": (r.get("service_name") or "").strip(),
            })
    return sorted(keep, key=lambda a: (a["phone"], a["start"]))

def group(rows, gap_minutes=0):
    """Back-to-back services for one phone become one visit."""
    visits = []
    for a in rows:
        if visits:
            last = visits[-1]
            if (last["phone"] == a["phone"]
                    and 0 <= (a["start"] - last["end"]).total_seconds() / 60 <= gap_minutes):
                last["services"].append(a["service"])
                last["end"] = a["end"]
                continue
        visits.append({"phone": a["phone"], "name": a["name"], "start": a["start"],
                       "end": a["end"], "services": [a["service"]]})
    return sorted(visits, key=lambda v: v["start"])

def payload(visit, svcmap, customer_id, versions=None):
    segs = []
    for s in visit["services"]:
        var = svcmap.get(s)
        if not var:
            raise KeyError(f"no Square id for service {s!r}")
        seg = {"service_variation_id": var, "team_member_id": TEAM_MEMBER}
        if versions and var in versions:
            seg["service_variation_version"] = versions[var]
        segs.append(seg)
    return {
        "booking": {
            "location_id": LOCATION,
            "customer_id": customer_id,
            "start_at": visit["start"].strftime("%Y-%m-%dT%H:%M:%S-05:00"),
            "appointment_segments": segs,
            "customer_note": "Moved from Booksy at cutover",
        }
    }

if __name__ == "__main__":
    csv_path, cut = sys.argv[1], datetime.strptime(sys.argv[2], "%Y-%m-%d").date()
    svcmap = json.load(open("/tmp/svcmap.json"))
    rows = load(csv_path, cut)
    visits = group(rows)
    print(f"{len(rows)} appointments -> {len(visits)} visits\n")
    for v in visits:
        print(f'{v["start"]:%a %d %b %H:%M}  {v["name"]:22} {v["phone"]:13} '
              f'{" + ".join(v["services"])}')
    missing = {s for v in visits for s in v["services"] if s not in svcmap}
    print("\nUNMAPPED SERVICES:", missing or "none")
