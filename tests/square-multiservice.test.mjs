process.env.SQUARE_ACCESS_TOKEN = 'test-token-not-real';

const VERSIONS = { SVC_A: 111, SVC_B: 222, SVC_C: 333 };
let calls = [];

global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};
  calls.push({ method, path: u.pathname, body });
  // The booking function re-checks the chosen time with Square before saving it.
  if (String(url).includes('/v2/bookings/availability/search') && !globalThis.__takeSlot && body?.query?.filter?.start_at_range && (Date.parse(body.query.filter.start_at_range.end_at)-Date.parse(body.query.filter.start_at_range.start_at))<=3600000) {
    const q = JSON.parse(opts.body || '{}'); const at = q?.query?.filter?.start_at_range?.start_at;
    const o = { availabilities: at ? [{ start_at: at }] : [] };
    return { ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) };
  }
  const ok = (o) => ({ ok:true, status:200, json: async () => o, text: async () => JSON.stringify(o) });

  if (u.pathname === '/v2/locations') return ok({ locations:[{ id:'LOC', status:'ACTIVE' }] });
  if (u.pathname.includes('team-member-booking-profiles'))
    return ok({ team_member_booking_profiles:[{ team_member_id:'TM', is_bookable:true }] });
  if (u.pathname.startsWith('/v2/catalog/object/')) {
    const id = u.pathname.split('/').pop();
    return ok({ object:{ type:'ITEM_VARIATION', id, version: VERSIONS[id] ?? 1 } });
  }
  if (u.pathname === '/v2/bookings/availability/search')
    return ok({ availabilities:[{ start_at:'2026-12-04T15:00:00Z' }] });
  if (u.pathname === '/v2/customers/search') return ok({ customers:[{ id:'CUST', given_name:'Pat' }] });
  if (u.pathname === '/v2/bookings' && method === 'POST')
    return ok({ booking:{ id:'BK', status:'ACCEPTED', start_at: body.booking.start_at } });
  if (method === 'GET' && u.pathname === '/v2/bookings/BK')
    return ok({ booking:{ id:'BK', version:3, status:'ACCEPTED', customer_id:'CUST' } });
  if (method === 'GET' && u.pathname.startsWith('/v2/customers/'))
    return ok({ customer:{ id:'CUST', phone_number:'+17325550142' } });
  if (method === 'PUT' && u.pathname === '/v2/bookings/BK')
    return ok({ booking:{ id:'BK', status:'ACCEPTED', start_at: body.booking.start_at } });
  throw new Error('unmocked ' + method + ' ' + u.pathname);
};

const handler = (await import('../netlify/functions/square.mjs')).default;
const call = async (req) => { calls = []; const r = await handler(req); return { status:r.status, body: await r.json(), calls }; };
const GET  = (qs) => call(new Request('https://x/api/square?' + qs));
const POST = (o)  => call(new Request('https://x/api/square', { method:'POST', body: JSON.stringify(o) }));

let bad = 0;
const check = (l,c,d='') => { if(!c){bad++;console.log(`FAIL  ${l}`);if(d)console.log('        '+d)} else console.log(`PASS  ${l}`) };
const ids = (segs=[]) => segs.map(s => s.service_variation_id).join(',');

// availability for a whole visit
let r = await GET('action=availability&services=SVC_A,SVC_B&from=2026-12-01T00:00:00Z&to=2026-12-08T00:00:00Z');
let f = r.calls.find(c => c.path === '/v2/bookings/availability/search')?.body?.query?.filter;
check('availability sends one filter per service', f?.segment_filters?.length === 2, JSON.stringify(f?.segment_filters));
check('availability keeps the chosen order',
      f?.segment_filters?.map(x=>x.service_variation_id).join(',') === 'SVC_A,SVC_B');
check('availability still answers', r.status === 200 && Array.isArray(r.body.slots));

// old single-service query still works
r = await GET('action=availability&service=SVC_A&from=2026-12-01T00:00:00Z&to=2026-12-08T00:00:00Z');
f = r.calls.find(c => c.path === '/v2/bookings/availability/search')?.body?.query?.filter;
check('a single service query still works', r.status === 200 && f?.segment_filters?.length === 1);

// booking three services
r = await POST({ services:['SVC_C','SVC_A','SVC_B'], startAt:'2026-12-04T15:00:00Z',
                 firstName:'Pat', phone:'7325550142', email:'pat@example.com' });
let segs = r.calls.find(c => c.path === '/v2/bookings' && c.method === 'POST')?.body?.booking?.appointment_segments;
check('three services make one booking of three segments', r.status === 200 && segs?.length === 3);
check('segments stay in the order the client picked', ids(segs) === 'SVC_C,SVC_A,SVC_B', ids(segs));
check('each segment carries its own version',
      segs?.map(s=>s.service_variation_version).join(',') === '333,111,222',
      segs?.map(s=>s.service_variation_version).join(','));

// single service still books
r = await POST({ service:'SVC_A', startAt:'2026-12-04T15:00:00Z', firstName:'Pat', phone:'7325550142', email:'pat@example.com' });
segs = r.calls.find(c => c.path === '/v2/bookings' && c.method === 'POST')?.body?.booking?.appointment_segments;
check('a single service still books one segment', r.status === 200 && segs?.length === 1);

// reschedule keeps the whole visit
r = await POST({ action:'reschedule', bookingId:'BK', phone:'7325550142',
                 services:['SVC_A','SVC_B'], startAt:'2026-12-05T16:00:00Z' });
segs = r.calls.find(c => c.method === 'PUT')?.body?.booking?.appointment_segments;
check('reschedule moves the whole visit', r.status === 200 && segs?.length === 2, ids(segs));

// limits
r = await POST({ services:[], startAt:'2026-12-04T15:00:00Z', firstName:'Pat', phone:'7325550142', email:'pat@example.com' });
check('no services is refused', r.status === 400);
r = await POST({ services:['A','B','C','D','E','F','G'], startAt:'2026-12-04T15:00:00Z', firstName:'Pat', phone:'7325550142', email:'pat@example.com' });
check('an absurd number of services is refused', r.status === 400, JSON.stringify(r.body));
check('and that refusal is readable', /call or text Sandy/i.test(r.body.error || ''), r.body.error);

console.log(bad ? `\n${bad} check(s) failed` : '\nall checks pass');
process.exit(bad ? 1 : 0);
