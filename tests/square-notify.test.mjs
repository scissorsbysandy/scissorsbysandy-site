// Client emails go to the private notify_email field, never to Square's own
// email field (Square would send its own appointment emails there). Also: a
// cancel made on the website is stamped so the email workflow knows the client
// did it, and the "Apple / Outlook" calendar file carries no client name.
process.env.SQUARE_ACCESS_TOKEN = 'test-token-not-real';

const KEY = 'sq0idp-ZAPIERAPP:notify_email';
let calls = [];
let notify = {};          // customerId -> email in the private field
let bookingVersion = 3;

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : {};
  calls.push({ u, method, body });
  const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  const notFound = () => ({ ok: false, status: 404, json: async () => ({ errors: [{ code: 'NOT_FOUND' }] }), text: async () => '{"errors":[{"code":"NOT_FOUND"}]}' });

  if (u.includes('/v2/locations')) return ok({ locations: [{ id: 'LDGXV0WRF8BFN', status: 'ACTIVE', timezone: 'America/New_York' }] });
  if (u.includes('team-member-booking-profiles')) return ok({ team_member_booking_profiles: [{ team_member_id: 'TM1', is_bookable: true }] });
  if (u.includes('/v2/catalog/object/')) return ok({ object: { type: 'ITEM_VARIATION', id: 'SVC', version: 1 } });
  if (u.includes('/v2/catalog/batch-retrieve')) return ok({ objects: [{ type: 'ITEM_VARIATION', item_variation_data: { name: 'Regular', item_id: 'ITEM1' } }], related_objects: [{ type: 'ITEM', id: 'ITEM1', item_data: { name: 'The Executive' } }] });
  if (u.includes('/v2/customers/custom-attribute-definitions')) {
    return ok({ custom_attribute_definitions: [{ key: 'sq0idp-OTHER:appointments-online-booking-blocking' }, { key: KEY }] });
  }
  const ca = u.match(/\/v2\/customers\/([^/]+)\/custom-attributes\/([^/?]+)/);
  if (ca) {
    const [, id, key] = ca;
    if (decodeURIComponent(key) !== KEY) return notFound();
    if (method === 'POST') { notify[id] = body.custom_attribute.value; return ok({ custom_attribute: { value: notify[id] } }); }
    return notify[id] ? ok({ custom_attribute: { value: notify[id] } }) : notFound();
  }
  if (u.includes('/v2/customers/search')) {
    const want = body?.query?.filter?.phone_number?.exact;
    if (want === '+17325550199') return ok({ customers: [{ id: 'C_OLD', given_name: 'Robin', family_name: 'Example', phone_number: want, version: 1 }] });
    return ok({ customers: [] });
  }
  if (u.endsWith('/v2/customers') && method === 'POST') return ok({ customer: { id: 'C_NEW', ...body } });
  if (/\/v2\/customers\/[^/]+$/.test(u)) {
    if (method === 'PUT') return ok({ customer: { id: 'C_OLD', ...body } });
    return ok({ customer: { id: 'C_OLD', given_name: 'Robin', family_name: 'Example', phone_number: '+17325550199' } });
  }
  if (u.endsWith('/cancel')) return ok({ booking: { id: 'BK1', status: 'CANCELLED_BY_SELLER', version: body.booking_version + 1 } });
  if (/\/v2\/bookings\/[^/]+$/.test(u)) {
    if (method === 'PUT') { bookingVersion += 1; return ok({ booking: { id: 'BK1', version: bookingVersion, seller_note: body.booking.seller_note } }); }
    return ok({ booking: { id: 'BK1', version: bookingVersion, status: 'ACCEPTED', customer_id: 'C_OLD', start_at: '2026-12-05T15:00:00Z', seller_note: 'Booked on scissorsbysandy.com', appointment_segments: [{ service_variation_id: 'SVC', duration_minutes: 45 }] } });
  }
  if (u.includes('/v2/orders/search')) return ok({ orders: [] });
  if (u.endsWith('/v2/bookings') && method === 'POST') return ok({ booking: { id: 'BK_NEW', status: 'ACCEPTED', start_at: body.booking.start_at } });
  throw new Error('unmocked call: ' + method + ' ' + u);
};

const { default: handler } = await import('../netlify/functions/square.mjs');
let bad = 0;
const check = (label, cond, detail = '') => { if (!cond) { bad++; console.log('FAIL  ' + label); if (detail) console.log('        ' + detail); } else console.log('PASS  ' + label); };
const post = (b) => handler(new Request('https://x/api/square', { method: 'POST', body: JSON.stringify(b) }));

// 1. New client with an email
calls = []; notify = {};
let res = await post({ service: 'SVC', startAt: '2026-12-05T15:00:00Z', firstName: 'Pat', lastName: 'New', phone: '7325550100', email: 'pat@example.com' });
check('new client books fine', res.status === 200, await res.clone().text());
const created = calls.find(c => c.u.endsWith('/v2/customers') && c.method === 'POST');
check('new client record has no email in Square’s own field', created && !('email_address' in created.body), JSON.stringify(created?.body));
check('their email goes to the private notify field', notify.C_NEW === 'pat@example.com', JSON.stringify(notify));
check('written under the qualified key', calls.some(c => c.method === 'POST' && c.u.includes(encodeURIComponent(KEY))));

// 2. Returning client: email filled in once, never overwritten
calls = []; notify = {};
res = await post({ service: 'SVC', startAt: '2026-12-05T15:00:00Z', firstName: 'Robin', lastName: 'Example', phone: '7325550199', email: 'robin@example.com' });
check('returning client books fine', res.status === 200);
check('returning client gets the email in the private field', notify.C_OLD === 'robin@example.com');
check('nothing is written to Square’s email field', !calls.some(c => c.method === 'PUT' && /\/v2\/customers\//.test(c.u) && 'email_address' in (c.body || {})));
notify = { C_OLD: 'kept@example.com' };
await post({ service: 'SVC', startAt: '2026-12-05T15:00:00Z', firstName: 'Robin', lastName: 'Example', phone: '7325550199', email: 'other@example.com' });
check('an email already on file is not overwritten', notify.C_OLD === 'kept@example.com', notify.C_OLD);

// 3. Cancel on the website is stamped first
calls = []; bookingVersion = 3;
res = await post({ action: 'cancel', bookingId: 'BK1', phone: '7325550199' });
check('cancel works', res.status === 200, await res.clone().text());
const stampIdx = calls.findIndex(c => c.method === 'PUT' && /\/v2\/bookings\/BK1$/.test(c.u));
const cancelIdx = calls.findIndex(c => c.u.endsWith('/cancel'));
check('the booking is stamped [web cancel] before it is cancelled', stampIdx > -1 && stampIdx < cancelIdx && /\[web cancel \d{4}-/.test(calls[stampIdx].body.booking.seller_note));
check('the stamp keeps the existing note', calls[stampIdx]?.body.booking.seller_note.startsWith('Booked on scissorsbysandy.com\n'));
check('the cancel uses the stamped version', calls[cancelIdx]?.body.booking_version === 4, String(calls[cancelIdx]?.body.booking_version));

// 4. Calendar file
res = await handler(new Request('https://x/api/square?action=ics&id=BK1'));
const ics = await res.text();
check('calendar file is served as text/calendar', res.status === 200 && (res.headers.get('content-type') || '').startsWith('text/calendar'));
check('it has the right start and end', ics.includes('DTSTART:20261205T150000Z') && ics.includes('DTEND:20261205T154500Z'), ics);
check('it names the service and the shop', ics.includes('The Executive') && !ics.includes('Regular') && ics.includes('Old Bridge'));
check('it carries no client name', !/Robin|Example/.test(ics));

// 5. Pay ahead fills the receipt email from the private field
notify = { C_OLD: 'robin@example.com' }; calls = [];
global.fetch = ((orig) => async (url, opts = {}) => {
  if (String(url).includes('/v2/online-checkout/payment-links')) {
    calls.push({ u: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ payment_link: { url: 'https://square.link/x' } }), text: async () => '{"payment_link":{"url":"https://square.link/x"}}' };
  }
  return orig(url, opts);
})(global.fetch);
res = await post({ action: 'paylink', bookingId: 'BK1', phone: '7325550199' });
const link = calls.find(c => c.u.includes('payment-links'));
check('pay ahead pre-fills the email from the private field', link?.body?.pre_populated_data?.buyer_email === 'robin@example.com', JSON.stringify(link?.body?.pre_populated_data));

if (bad) { console.log(`\n${bad} failed`); process.exit(1); }
console.log('\nall passed');
