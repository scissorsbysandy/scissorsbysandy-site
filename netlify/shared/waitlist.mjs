/**
 * The waitlist.
 *
 * A client who cannot find a time that suits them on a day can join the list
 * for that day. When a time opens up (a cancellation, a moved appointment,
 * Sandy freeing up time), everyone waiting for that day whose visit now fits
 * gets an email at the same moment. First to book gets it. Luis chose that
 * (28 Nov 2026): no picking favourites, no holds, any date.
 *
 * Why not Square's own waitlist: it only exists on Square's booking site, which
 * is switched off on purpose, and the Bookings API has no waitlist at all.
 *
 * Storage is Netlify Blobs, one record per day ("d/2026-12-06" -> entries), so
 * the only writes that can collide are two people joining the same day at the
 * same moment, and those are retried against the fresh copy.
 *
 * What "a time opened up" means: every entry remembers the times that were
 * already open for it the last time we looked (`seen`). A time that is open now
 * and was not then is new, and is what the email offers. Looking again simply
 * replaces `seen`, so a time that is taken and later freed again is news again.
 *
 * Every function here takes its outside world (the store, the availability
 * lookup, the mailer, the clock) as arguments, so the tests can run it whole.
 */

export const SHOP_TZ = 'America/New_York';
export const WINDOWS = {
  any:       { label: 'Any time',  from: 0,       to: 24 * 60 },
  morning:   { label: 'Morning',   from: 0,       to: 12 * 60 },
  afternoon: { label: 'Afternoon', from: 12 * 60, to: 16 * 60 },
  evening:   { label: 'Evening',   from: 16 * 60, to: 24 * 60 },
};
const MAX_PER_DAY = 40;          // a full day of a one-chair shop never needs more
const MAX_DAYS_AHEAD = 366;      // "any date", within reason
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/* ---------- shop time ---------------------------------------------------- */

function parts(date) {
  const o = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(date)) o[p.type] = p.value;
  return o;
}
/** 'YYYY-MM-DD' of an instant, on the shop's calendar. */
export function shopDate(instant) {
  const o = parts(new Date(instant));
  return `${o.year}-${o.month}-${o.day}`;
}
/** Minutes past midnight of an instant, on the shop's clock. */
export function shopMinute(instant) {
  const o = parts(new Date(instant));
  return (Number(o.hour) % 24) * 60 + Number(o.minute);
}
/** The UTC instant of a shop-local wall time (handles daylight saving). */
function shopInstant(day, minute) {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(minute / 60), minute % 60);
  // What the shop's clock reads at `guess`, versus what we wanted it to read.
  const o = parts(new Date(guess));
  const read = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute);
  return new Date(guess - (read - guess)).toISOString();
}
/** Start and end of a shop day, as instants Square understands. */
export function dayRange(day) {
  const [y, m, d] = day.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { from: shopInstant(day, 0), to: shopInstant(next, 0) };
}

/** Every start time open for this visit on this shop day. */
async function openOn(availability, services, day) {
  const { from, to } = dayRange(day);
  const list = await availability(services, from, to);
  return [...new Set(list)].filter(iso => shopDate(iso) === day).sort();
}

/* ---------- small helpers ------------------------------------------------ */

const key = (day) => 'd/' + day;
const clean = (s, n = 80) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const okEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());
const randomId = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))]
  .map(b => b.toString(16).padStart(2, '0')).join('');

/** The times open for this entry's visit, inside the part of the day they asked for. */
function inWindow(slots, windowName) {
  const w = WINDOWS[windowName] || WINDOWS.any;
  return slots.filter(iso => { const m = shopMinute(iso); return m >= w.from && m < w.to; }).sort();
}

/**
 * Read one day, change it, write it back only if nobody else wrote in between.
 * `change` gets the current entries and returns the new list (or null to leave
 * the day alone). Retries a few times on a collision.
 */
async function update(store, day, change) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const got = await store.getWithMetadata(key(day), { type: 'json' });
    const entries = Array.isArray(got?.data) ? got.data : [];
    const next = await change(entries.map(e => ({ ...e })));
    if (next == null) return entries;
    if (!next.length) { await store.delete(key(day)); return next; }
    const res = got
      ? await store.setJSON(key(day), next, { onlyIfMatch: got.etag })
      : await store.setJSON(key(day), next, { onlyIfNew: true });
    if (res?.modified !== false) return next;
  }
  throw bad('The waitlist is busy just now. Please try again in a moment', 409);
}

/* ---------- joining and leaving ----------------------------------------- */

/**
 * Put someone on the list for a day.
 *
 * Refuses if a time that suits them is already open (they should just book it),
 * so the list only ever holds people who genuinely could not get in. Joining
 * again for the same day with the same phone updates their entry rather than
 * adding a second one.
 */
export async function join(input, { store, availability, toE164, now = Date.now() }) {
  const day = String(input.date || '');
  if (!DAY_RE.test(day)) throw bad('Please choose a day');
  const today = shopDate(now);
  if (day < today) throw bad('That day has already passed');
  if (day > shopDate(now + MAX_DAYS_AHEAD * 864e5)) throw bad('That day is too far ahead for the waitlist');

  const services = (Array.isArray(input.services) ? input.services : String(input.services || '').split(','))
    .map(s => String(s).trim()).filter(Boolean);
  if (!services.length || services.length > 6) throw bad('Please choose your services first');
  const windowName = WINDOWS[input.window] ? input.window : 'any';

  const first = clean(input.firstName, 40), last = clean(input.lastName, 40);
  if (!first || !last) throw bad('Please enter your first and last name');
  const phone = toE164(input.phone);
  if (!phone) throw bad('Please enter a 10-digit mobile number');
  const email = clean(input.email, 120).toLowerCase();
  if (!okEmail(email)) throw bad('Please enter your email so I can tell you when a time opens');

  const all = await openOn(availability, services, day);
  const open = inWindow(all, windowName);
  if (open.length) {
    throw Object.assign(bad('Good news: there is a time open that day', 409), { open });
  }

  let entry;
  const saved = await update(store, day, (entries) => {
    const mine = entries.find(e => e.phone === phone);
    if (!mine && entries.length >= MAX_PER_DAY) throw bad('The waitlist for that day is full. Please call or text Sandy at (848) 230-5995');
    entry = {
      id: mine?.id || randomId(8),
      token: mine?.token || randomId(16),
      createdAt: mine?.createdAt || new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      day, services, window: windowName,
      firstName: first, lastName: last, phone, email,
      note: clean(input.note, 300),
      // Every time open for this visit that day, in or out of their window,
      // so joining never sets off an email by itself and anything opening
      // inside their window later is recognised as new.
      seen: all,
      notified: mine?.notified || 0,
    };
    return [...entries.filter(e => e !== mine), entry];
  });
  return { entry, updated: entry.createdAt !== entry.updatedAt, waiting: saved.length };
}

/** Take someone off the list, from the link in their email. */
export async function leave({ day, id, token }, { store }) {
  if (!DAY_RE.test(String(day || '')) || !id || !token) throw bad('That link is not complete');
  let found = null;
  await update(store, day, (entries) => {
    found = entries.find(e => e.id === id && e.token === token) || null;
    if (!found) return null;
    return entries.filter(e => e !== found);
  });
  return { removed: !!found, entry: found };
}

/** Someone booked that day: they no longer need the list for it. */
export async function removeBooked({ day, phone }, { store }) {
  if (!DAY_RE.test(String(day || '')) || !phone) return 0;
  let n = 0;
  await update(store, day, (entries) => {
    const keep = entries.filter(e => e.phone !== phone);
    n = entries.length - keep.length;
    return n ? keep : null;
  });
  return n;
}

/* ---------- looking for openings --------------------------------------- */

/**
 * Check every day anyone is waiting for. Past days are cleared away.
 * Returns what it did, for the logs and the tests.
 *
 * The record is written before any email goes out: if the email step fails the
 * worst case is one missed email, never the same email sent twice.
 */
export async function sweep({ store, availability, mail, phonesBooked = null, now = Date.now(), only = null }) {
  const today = shopDate(now);
  const { blobs = [] } = await store.list({ prefix: 'd/' });
  const report = { days: 0, cleared: 0, notified: [] };

  for (const { key: k } of blobs) {
    const day = k.slice(2);
    if (!DAY_RE.test(day)) continue;
    if (day < today) { await store.delete(k); report.cleared++; continue; }
    if (only && !only.includes(day)) continue;
    report.days++;

    const lookups = new Map();                 // one Square call per distinct visit
    const openFor = (services) => {
      const sig = services.join(',');
      if (!lookups.has(sig)) lookups.set(sig, openOn(availability, services, day).then(
        list => list.filter(iso => Date.parse(iso) > now),
        () => null));                          // a failed lookup changes nothing
      return lookups.get(sig);
    };

    // Anyone who has booked this day since joining comes off the list for it.
    let booked = null;
    if (phonesBooked) {
      try { const { from, to } = dayRange(day); booked = await phonesBooked(from, to); } catch { booked = null; }
    }

    const toSend = [];
    await update(store, day, async (list) => {
      toSend.length = 0;
      let changed = false;
      const entries = booked ? list.filter(e => !booked.has(e.phone)) : list;
      if (entries.length !== list.length) { changed = true; report.booked = (report.booked || 0) + list.length - entries.length; }
      for (const e of entries) {
        const open = await openFor(e.services);
        if (open == null) continue;
        const was = new Set(e.seen || []);
        const fresh = inWindow(open.filter(t => !was.has(t)), e.window);
        if (JSON.stringify(open) !== JSON.stringify(e.seen || [])) { e.seen = open; changed = true; }
        if (fresh.length) {
          e.notified = (e.notified || 0) + 1;
          e.lastNotifiedAt = new Date(now).toISOString();
          toSend.push({ entry: { ...e }, times: fresh, allOpen: inWindow(open, e.window) });
        }
      }
      return changed ? entries : null;
    });

    for (const n of toSend) {
      try { await mail({ kind: 'opening', ...n }); report.notified.push({ day, id: n.entry.id, times: n.times }); }
      catch (err) { console.error('waitlist email failed:', err.message); }
    }
    if (toSend.length) {
      try { await mail({ kind: 'notifiedShop', day, count: toSend.length, times: [...new Set(toSend.flatMap(n => n.times))].sort(), entries: toSend.map(n => n.entry) }); }
      catch (err) { console.error('waitlist shop email failed:', err.message); }
    }
  }
  return report;
}

/* ---------- emails ------------------------------------------------------- */

/**
 * Hand an email to the waitlist workflow in Zapier, which sends it from the
 * shop's own Gmail like every other booking email. The key proves it is us:
 * the hook address alone would let anyone send mail in Sandy's name.
 */
export function makeMailer({ url, key, fetchImpl = fetch, site = 'https://scissorsbysandy.com', testTo = '' }) {
  return async (msg) => {
    if (!url || !key) { console.log('waitlist mail not configured; would send', msg.kind); return; }
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sbs_key: key, site, ...(testTo ? { sbs_test_to: testTo } : {}), ...msg }),
    });
    if (!res.ok) throw new Error('waitlist mail hook -> ' + res.status);
  };
}
