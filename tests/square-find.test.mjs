// "Find my appointment": a client whose booking was moved over from Booksy,
// made by Sandy, or booked on another phone can look it up with their number
// and name, then move or cancel it like any booking made on this browser.
// Every name and number here is invented.
process.env.SQUARE_ACCESS_TOKEN = 'test-token-not-real';

const DAY = 86400000;
const soon  = new Date(Date.now() + 3 * DAY).toISOString();
const later = new Date(Date.now() + 45 * DAY).toISOString();
const past  = new Date(Date.now() - 2 * DAY).toISOString();

// One household number shared by a parent and a child, plus a one-name record
// of the kind Booksy kept.
const CUSTOMERS = [
  { id:'C_PARENT', given_name:'Pat',   family_name:'Example', phone_number:'+17325550101' },
  { id:'C_CHILD',  given_name:'Robin', family_name:'Example', phone_number:'+17325550101' },
  { id:'C_SOLO',   given_name:'Andy',  family_name:'',        phone_number:'+17325550199' },
];
const BOOKINGS = [
  { id:'B_SOON',   customer_id:'C_PARENT', status:'ACCEPTED', start_at: soon,
    appointment_segments:[{ service_variation_id:'VAR_CUT', duration_minutes:45 },
                          { service_variation_id:'VAR_BEARD', duration_minutes:15 }] },
  { id:'B_LATER',  customer_id:'C_PARENT', status:'ACCEPTED', start_at: later,
    appointment_segments:[{ service_variation_id:'VAR_CUT', duration_minutes:45 }] },
  { id:'B_GONE',   customer_id:'C_PARENT', status:'CANCELLED_BY_SELLER', start_at: soon,
    appointment_segments:[{ service_variation_id:'VAR_CUT', duration_minutes:45 }] },
  { id:'B_PAST',   customer_id:'C_PARENT', status:'ACCEPTED', start_at: past,
    appointment_segments:[{ service_variation_id:'VAR_CUT', duration_minutes:45 }] },
  { id:'B_CHILD',  customer_id:'C_CHILD',  status:'ACCEPTED', start_at: soon,
    appointment_segments:[{ service_variation_id:'VAR_KID', duration_minutes:30 }] },
  { id:'B_SOLO',   customer_id:'C_SOLO',   status:'PENDING',  start_at: soon,
    appointment_segments:[{ service_variation_id:'VAR_CUT', duration_minutes:45 }] },
];

let calls = [];
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const path = u.pathname;
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};
  calls.push({ method, path, body, q: Object.fromEntries(u.searchParams) });
  const ok = (o) => ({ ok:true, status:200, json: async () => o, text: async () => JSON.stringify(o) });

  if (path === '/v2/locations') return ok({ locations:[{ id:'LOC', status:'ACTIVE', timezone:'America/New_York' }] });
  if (path.includes('team-member-booking-profiles')) return ok({ team_member_booking_profiles:[{ team_member_id:'TM', is_bookable:true }] });
  if (method === 'POST' && path === '/v2/customers/search') {
    const e164 = body.query.filter.phone_number.exact;
    return ok({ customers: CUSTOMERS.filter(c => c.phone_number === e164) });
  }
  if (method === 'GET' && path === '/v2/bookings') {
    const min = Date.parse(u.searchParams.get('start_at_min'));
    const max = Date.parse(u.searchParams.get('start_at_max'));
    if (max - min > 31 * DAY) return { ok:false, status:400, text: async () => '{"errors":[{"code":"BAD_REQUEST","detail":"range over 31 days"}]}' };
    const cid = u.searchParams.get('customer_id');
    return ok({ bookings: BOOKINGS.filter(b => b.customer_id === cid &&
      Date.parse(b.start_at) >= min && Date.parse(b.start_at) < max) });
  }
  throw new Error('unmocked ' + method + ' ' + path);
};

const handler = (await import('../netlify/functions/square.mjs')).default;
async function find(payload) {
  calls = [];
  const res = await handler(new Request('https://x/api/square', {
    method:'POST', body: JSON.stringify({ action:'find', ...payload }),
  }));
  return { status: res.status, body: await res.json(), calls };
}

let bad = 0;
const check = (label, cond, detail='') => {
  if (!cond) { bad++; console.log(`FAIL  ${label}`); if (detail) console.log('        ' + detail); }
  else console.log(`PASS  ${label}`);
};
const ids = (r) => (r.body.bookings || []).map(b => b.id).join(',');

// --- the right number and name ---
let r = await find({ phone:'(732) 555-0101', name:'Pat Example' });
check('finds upcoming appointments by number and name', r.status === 200 && ids(r) === 'B_SOON,B_LATER', ids(r));
check('a cancelled appointment is not offered', !ids(r).includes('B_GONE'));
check('a past appointment is not offered', !ids(r).includes('B_PAST'));
check('reaches 45 days out (more than one 31-day window)', ids(r).includes('B_LATER'));
check('every bookings request stays inside Square’s 31-day limit',
      r.calls.filter(c => c.path === '/v2/bookings').every(c =>
        Date.parse(c.q.start_at_max) - Date.parse(c.q.start_at_min) <= 31 * DAY));
const first = (r.body.bookings || [])[0] || {};
check('returns the services so the page can rebook the same visit',
      JSON.stringify(first.services) === '["VAR_CUT","VAR_BEARD"]', JSON.stringify(first.services));
check('returns the length of the visit', first.minutes === 60, String(first.minutes));
check('nothing is changed in Square by a lookup',
      r.calls.every(c => c.method === 'GET' || c.path === '/v2/customers/search'));

// --- household: the name decides whose appointments are shown ---
r = await find({ phone:'7325550101', name:'Robin' });
check('a shared number shows only that person’s appointments', ids(r) === 'B_CHILD', ids(r));
r = await find({ phone:'7325550101', name:'Example' });
check('a shared last name shows the whole household',
      ids(r).split(',').sort().join(',') === 'B_CHILD,B_LATER,B_SOON', ids(r));
check('and lists them soonest first', ids(r).endsWith('B_LATER'), ids(r));

// --- one-name records, titles, case ---
r = await find({ phone:'732-555-0199', name:'andy' });
check('a one-name record from Booksy is found by that name', ids(r) === 'B_SOLO', ids(r));
r = await find({ phone:'7325550101', name:'Mr. Pat Example' });
check('a title in front of the name is ignored', ids(r) === 'B_SOON,B_LATER', ids(r));

// --- refusals ---
r = await find({ phone:'7325550101', name:'Someone Else' });
check('right number, wrong name: nothing shown', r.status === 200 && ids(r) === '' && r.body.client === null);
r = await find({ phone:'7325550000', name:'Pat Example' });
check('unknown number: the same empty answer (no hint whose number it is)',
      r.status === 200 && ids(r) === '' && r.body.client === null);
r = await find({ phone:'7325550101', name:'Mr.' });
check('a title alone is not a name', r.status === 400);
r = await find({ phone:'555', name:'Pat Example' });
check('a short number is refused', r.status === 400);
r = await find({ phone:'7325550101' });
check('a name is required', r.status === 400);

console.log(bad ? `\n${bad} check(s) failed` : '\nAll find-my-appointment checks passed');
process.exit(bad ? 1 : 0);
