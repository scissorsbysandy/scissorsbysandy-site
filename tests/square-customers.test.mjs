process.env.SQUARE_ACCESS_TOKEN = 'test-token-not-real';

const HOUSEHOLDS = {
  '+17325550142': [
    { id:'CUST_ROBIN', given_name:'Robin', family_name:'Example', created_at:'2026-11-18T10:30:30Z' },
    { id:'CUST_PAT',   given_name:'Pat',   family_name:'Example', created_at:'2026-11-18T10:33:01Z' },
  ],
  '+17325550143': [
    { id:'CUST_SAM', given_name:'Sam', family_name:'Sample', created_at:'2026-11-18T10:32:13Z' },
    { id:'CUST_LEE', given_name:'Lee', family_name:'Sample', created_at:'2026-11-18T10:33:01Z' },
  ],
  // one record only, and the client shortens their own name when booking
  '+17325550144': [
    { id:'CUST_MICHAEL_S', given_name:'Michael', family_name:'Testman', created_at:'2026-11-18T10:32:13Z' },
  ],
};

let created = null;
let bookedCustomer = null;

global.fetch = async (url, opts = {}) => {
  // The booking function re-checks the chosen time with Square before saving it.
  if (String(url).includes('/v2/bookings/availability/search') && !globalThis.__takeSlot) {
    const q = JSON.parse(opts.body || '{}'); const at = q?.query?.filter?.start_at_range?.start_at;
    const o = { availabilities: at ? [{ start_at: at }] : [] };
    return { ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) };
  }
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};
  const ok = (o) => ({ ok:true, status:200, json: async () => o, text: async () => JSON.stringify(o) });

  if (u.includes('/v2/locations')) return ok({ locations:[{ id:'LDGXV0WRF8BFN', status:'ACTIVE', timezone:'America/New_York' }] });
  if (u.includes('team-member-booking-profiles')) return ok({ team_member_booking_profiles:[{ team_member_id:'TMcPuss1Jbyk7-WC', is_bookable:true }] });
  if (u.includes('/v2/catalog/object/')) return ok({ object:{ type:'ITEM_VARIATION', id:'SVC', version:1794968142166 } });

  if (u.includes('/v2/customers/search')) {
    const want = body?.query?.filter?.phone_number?.exact;
    return ok({ customers: HOUSEHOLDS[want] ? [...HOUSEHOLDS[want]] : [] });
  }
  if (u.endsWith('/v2/customers')) {
    created = { given_name: body.given_name, family_name: body.family_name, phone_number: body.phone_number };
    return ok({ customer:{ id:'CUST_NEWLY_CREATED' } });
  }
  if (u.includes('/v2/bookings')) {
    bookedCustomer = body.booking.customer_id;
    return ok({ booking:{ id:'BK1', status:'ACCEPTED', start_at: body.booking.start_at } });
  }
  throw new Error('unmocked call: ' + u);
};

const mod = await import('../netlify/functions/square.mjs');
const handler = mod.default;

async function book(firstName, lastName, phone) {
  created = null; bookedCustomer = null;
  const res = await handler(new Request('https://x/api/square', {
    method:'POST',
    body: JSON.stringify({ service:'SVC', startAt:'2026-12-04T15:00:00Z', firstName, lastName, phone, email: 'client@example.com' }),
  }));
  const out = await res.json();
  if (res.status !== 200) throw new Error('booking failed: ' + JSON.stringify(out));
  return { customer: bookedCustomer, created };
}

const cases = [
  ['Pat books on the shared number',        ['Pat','Example','7325550142'],     'CUST_PAT',           false],
  ['Robin books on the same number',        ['Robin','Example','7325550142'],   'CUST_ROBIN',         false],
  ['Lee books on the Sample number',     ['Lee','Sample','7325550143'],  'CUST_LEE',        false],
  ['Sam books on the Sample number',     ['Sam','Sample','7325550143'],  'CUST_SAM',        false],
  ['a new relative on a known number',      ['Dave','Example','7325550142'],    'CUST_NEWLY_CREATED', true ],
  ['a regular shortening his name',         ['Mike','Testman','7325550144'],   'CUST_MICHAEL_S',     false],
  ['an accented spelling, one record',      ['MICHAEL','testman','7325550144'],'CUST_MICHAEL_S',     false],
  ['a brand new client',                    ['Nia','Okafor','7325550123'],     'CUST_NEWLY_CREATED', true ],
];

let bad = 0;
for (const [label, args, expect, shouldCreate] of cases) {
  const r = await book(...args);
  const madeNew = !!r.created;
  const pass = r.customer === expect && madeNew === shouldCreate;
  if (!pass) bad++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) console.log(`        expected ${expect} (new record: ${shouldCreate}), got ${r.customer} (new record: ${madeNew})`);
}
console.log(bad ? `\n${bad} case(s) failed` : '\nall 8 cases pass');
process.exit(bad ? 1 : 0);
