process.env.SQUARE_ACCESS_TOKEN = 'test-token-not-real';

const BOOKING = {
  id: 'BK_REAL', version: 7, status: 'ACCEPTED',
  customer_id: 'CUST_PAT', start_at: '2026-12-04T15:00:00Z',
};
const CUSTOMERS = { CUST_PAT: { id:'CUST_PAT', phone_number:'+17325550142' } };

let calls = [];
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const path = u.pathname;
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};
  calls.push({ method, path, body });
  const ok = (o) => ({ ok:true, status:200, json: async () => o, text: async () => JSON.stringify(o) });

  if (path === '/v2/locations') return ok({ locations:[{ id:'LOC', status:'ACTIVE', timezone:'America/New_York' }] });
  if (path.includes('team-member-booking-profiles')) return ok({ team_member_booking_profiles:[{ team_member_id:'TM', is_bookable:true }] });
  if (path.startsWith('/v2/catalog/object/')) return ok({ object:{ type:'ITEM_VARIATION', id:'SVC', version: 999 } });

  if (method === 'POST' && path === '/v2/orders/search') return ok({ orders: [] });
  if (method === 'GET' && path === '/v2/bookings/BK_REAL') return ok({ booking: { ...BOOKING } });
  if (method === 'POST' && path === '/v2/bookings/BK_REAL/cancel')
    return ok({ booking:{ id:'BK_REAL', status:'CANCELLED_BY_CUSTOMER' } });
  if (method === 'PUT' && path === '/v2/bookings/BK_REAL')
    return ok({ booking:{ id:'BK_REAL', status:'ACCEPTED', start_at: body.booking.start_at } });

  if (method === 'GET' && path.startsWith('/v2/customers/')) {
    const id = path.split('/').pop();
    return CUSTOMERS[id] ? ok({ customer: CUSTOMERS[id] }) : ok({});
  }
  throw new Error('unmocked ' + method + ' ' + path);
};

const handler = (await import('../netlify/functions/square.mjs')).default;

async function post(payload) {
  calls = [];
  const res = await handler(new Request('https://x/api/square', {
    method:'POST', body: JSON.stringify(payload),
  }));
  return { status: res.status, body: await res.json(), calls };
}

let bad = 0;
const check = (label, cond, detail='') => {
  if (!cond) { bad++; console.log(`FAIL  ${label}`); if (detail) console.log('        ' + detail); }
  else console.log(`PASS  ${label}`);
};

// --- cancel, right owner ---
let r = await post({ action:'cancel', bookingId:'BK_REAL', phone:'7325550142' });
const cancelCall = r.calls.find(c => c.path.endsWith('/cancel'));
check('cancel reaches Square', r.status === 200 && !!cancelCall);
check('cancel sends the current booking version',
      cancelCall?.body?.booking_version === 7,
      'sent ' + JSON.stringify(cancelCall?.body?.booking_version));

// --- cancel, wrong owner ---
r = await post({ action:'cancel', bookingId:'BK_REAL', phone:'9085550000' });
check('a stranger cannot cancel it', r.status === 403);
check('and no cancel call is made', !r.calls.some(c => c.path.endsWith('/cancel')));

// --- reschedule ---
r = await post({ action:'reschedule', bookingId:'BK_REAL', phone:'7325550142',
                 service:'SVC', startAt:'2026-12-05T16:00:00Z' });
const put = r.calls.find(c => c.method === 'PUT' && c.path === '/v2/bookings/BK_REAL');
const createdSecond = r.calls.some(c => c.method === 'POST' && c.path === '/v2/bookings');
check('reschedule moves the existing booking', r.status === 200 && !!put);
check('reschedule does NOT create a second booking', !createdSecond);
check('reschedule sends the new time',
      put?.body?.booking?.start_at === '2026-12-05T16:00:00Z');
check('reschedule sends the booking version for concurrency',
      put?.body?.booking?.version === 7);

// --- reschedule, wrong owner ---
r = await post({ action:'reschedule', bookingId:'BK_REAL', phone:'9085550000',
                 service:'SVC', startAt:'2026-12-05T16:00:00Z' });
check('a stranger cannot move it', r.status === 403);
check('and nothing is written', !r.calls.some(c => c.method === 'PUT'));

// --- unknown action ---
r = await post({ action:'delete_everything', bookingId:'BK_REAL', phone:'7325550142' });
check('an unknown action is refused', r.status === 400);

console.log(bad ? `\n${bad} check(s) failed` : '\nall checks pass');
process.exit(bad ? 1 : 0);
