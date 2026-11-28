// The shop's Square token can book over an existing appointment. The booking
// function must re-check the exact time with Square before saving a booking or
// a move, and refuse with 409 when it is gone, so two clients can never land in
// the chair at once.
process.env.SQUARE_ACCESS_TOKEN = 'test-token-not-real';

let calls = [];
let open = [];                 // what Square says is free right now
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};
  calls.push({ method, path: u.pathname, body });
  const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.pathname === '/v2/locations') return ok({ locations: [{ id: 'LOC', status: 'ACTIVE' }] });
  if (u.pathname.includes('team-member-booking-profiles'))
    return ok({ team_member_booking_profiles: [{ team_member_id: 'SANDY', is_bookable: true }] });
  if (u.pathname.startsWith('/v2/catalog/object/'))
    return ok({ object: { type: 'ITEM_VARIATION', id: u.pathname.split('/').pop(), version: 7 } });
  if (u.pathname === '/v2/bookings/availability/search')
    return ok({ availabilities: open.map(start_at => ({ start_at })) });
  if (u.pathname === '/v2/customers/search') return ok({ customers: [{ id: 'CUST', given_name: 'Pat', phone_number: '+17325550142' }] });
  if (u.pathname.startsWith('/v2/customers/') && u.pathname.includes('custom-attribute')) return ok({});
  if (method === 'GET' && u.pathname.startsWith('/v2/customers/'))
    return ok({ customer: { id: 'CUST', given_name: 'Pat', phone_number: '+17325550142' } });
  if (u.pathname === '/v2/bookings' && method === 'POST')
    return ok({ booking: { id: 'NEW', status: 'ACCEPTED', start_at: body.booking.start_at } });
  if (method === 'GET' && u.pathname === '/v2/bookings/BK')
    return ok({ booking: { id: 'BK', version: 3, status: 'ACCEPTED', customer_id: 'CUST',
      start_at: '2026-12-04T15:00:00Z', appointment_segments: [{ service_variation_id: 'SVC_A', duration_minutes: 40 }] } });
  if (method === 'GET' && u.pathname === '/v2/bookings/SOON')
    return ok({ booking: { id: 'SOON', version: 1, status: 'ACCEPTED', customer_id: 'CUST',
      start_at: new Date(Date.now() + 30 * 60000).toISOString(), appointment_segments: [{ service_variation_id: 'SVC_A', duration_minutes: 40 }] } });
  if (u.pathname.startsWith('/v2/bookings/SOON')) return ok({ booking: { id: 'SOON', status: 'CHANGED' } });
  if (method === 'PUT' && u.pathname === '/v2/bookings/BK')
    return ok({ booking: { id: 'BK', status: 'ACCEPTED', start_at: body.booking.start_at } });
  if (u.pathname.startsWith('/v2/customers')) return ok({});
  throw new Error('unmocked ' + method + ' ' + u.pathname);
};

const handler = (await import('../netlify/functions/square.mjs')).default;
const POST = async (o) => { calls = []; const r = await handler(new Request('https://x/api/square', { method: 'POST', body: JSON.stringify(o) })); return { status: r.status, body: await r.json(), calls }; };
let bad = 0;
const check = (l, c, d = '') => { if (!c) { bad++; console.log(`FAIL  ${l}`); if (d) console.log('        ' + d) } else console.log(`PASS  ${l}`) };
const made = (r) => r.calls.some(c => c.path === '/v2/bookings' && c.method === 'POST');
const moved = (r) => r.calls.some(c => c.path === '/v2/bookings/BK' && c.method === 'PUT');

const T = '2026-12-05T16:00:00.000Z';
const base = { services: ['SVC_A'], startAt: T, firstName: 'Pat', phone: '7325550142' };

// still free: booked
open = [T];
let r = await POST(base);
check('a free time is booked', r.status === 200 && made(r), JSON.stringify(r.body));
const q = r.calls.find(c => c.path === '/v2/bookings/availability/search')?.body?.query?.filter;
check('the check asks about the exact time', Date.parse(q?.start_at_range?.start_at) === Date.parse(T));
check('the check is for Sandy only', q?.segment_filters?.[0]?.team_member_id_filter?.any?.[0] === 'SANDY');
check('the check comes before the booking is written',
  r.calls.findIndex(c => c.path === '/v2/bookings/availability/search') < r.calls.findIndex(c => c.path === '/v2/bookings'));

// taken in the meantime: refused, nothing written
open = ['2026-12-05T16:30:00Z'];
r = await POST(base);
check('a taken time is refused with 409', r.status === 409, JSON.stringify(r.body));
check('the client is told it was just taken', /just taken/i.test(r.body.error || ''));
check('nothing is written to Square for a taken time', !made(r));

// a time Square offers nothing for at all (closed, past)
open = [];
r = await POST({ ...base, startAt: '2026-12-02T16:00:00Z' });
check('a time with no opening is refused', r.status === 409 && !made(r));

// moving: a new time that is free
open = ['2026-12-06T18:00:00Z'];
r = await POST({ action: 'reschedule', bookingId: 'BK', phone: '7325550142', services: ['SVC_A'], startAt: '2026-12-06T18:00:00Z' });
check('a move to a free time goes through', r.status === 200 && moved(r), JSON.stringify(r.body));

// moving: a new time that is taken by someone else
open = [];
r = await POST({ action: 'reschedule', bookingId: 'BK', phone: '7325550142', services: ['SVC_A'], startAt: '2026-12-06T18:00:00Z' });
check('a move to a taken time is refused with 409', r.status === 409 && !moved(r), JSON.stringify(r.body));

// moving 30 minutes later: only the client's own visit is in the way
open = [];
r = await POST({ action: 'reschedule', bookingId: 'BK', phone: '7325550142', services: ['SVC_A'], startAt: '2026-12-04T15:30:00Z' });
check('a move overlapping only its own old time is allowed', r.status === 200 && moved(r), JSON.stringify(r.body));

// a garbage time is a 400, not a booking
r = await POST({ ...base, startAt: 'tomorrow-ish' });
check('a malformed time is refused', r.status === 400 && !made(r));

// inside the last hour: the server refuses, whatever the page shows
r = await POST({ action: 'cancel', bookingId: 'SOON', phone: '7325550142' });
check('a cancel inside the last hour is refused', r.status === 403 && /call or text Sandy/i.test(r.body.error || ''), JSON.stringify(r.body));
check('and nothing is cancelled in Square', !r.calls.some(c => c.path.startsWith('/v2/bookings/SOON/cancel')));
open = ['2026-12-06T18:00:00Z'];
r = await POST({ action: 'reschedule', bookingId: 'SOON', phone: '7325550142', services: ['SVC_A'], startAt: '2026-12-06T18:00:00Z' });
check('a move inside the last hour is refused', r.status === 403 && !r.calls.some(c => c.method === 'PUT'), JSON.stringify(r.body));

console.log(bad ? `\n${bad} check(s) failed` : '\nall slot checks pass');
process.exit(bad ? 1 : 0);
