// Pay ahead: optional, like Booksy Pay. The booking function makes a Square
// checkout link for a client's own appointment, then, once Square shows the
// order paid, writes PAID AHEAD on the booking and alerts Sandy, so the client
// is never charged twice. Invented names and numbers throughout.
process.env.SQUARE_ACCESS_TOKEN = 'test-token-not-real';
process.env.SBS_ALERT_URL = 'https://alerts.example/hook';

const DAY = 86400000;
const future = new Date(Date.now() + 3 * DAY).toISOString();
let BOOKING, ORDERS, calls, alerts;
function reset() {
  BOOKING = { id:'BK1', version:4, status:'ACCEPTED', customer_id:'C1', start_at: future,
              seller_note:'Booked on scissorsbysandy.com',
              appointment_segments:[{ service_variation_id:'VAR_CUT', duration_minutes:45 },
                                    { service_variation_id:'VAR_BEARD', duration_minutes:15 }] };
  ORDERS = [];
  calls = []; alerts = [];
}
reset();

global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const path = u.pathname;
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};
  const ok = (o) => ({ ok:true, status:200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.host === 'alerts.example') { alerts.push(body); return ok({}); }
  calls.push({ method, path, body });

  if (path === '/v2/locations') return ok({ locations:[{ id:'LOC', status:'ACTIVE', timezone:'America/New_York' }] });
  if (path.includes('team-member-booking-profiles')) return ok({ team_member_booking_profiles:[{ team_member_id:'TM', is_bookable:true }] });
  if (path.startsWith('/v2/catalog/object/')) return ok({ object:{ type:'ITEM_VARIATION', id:'X', version: 9 } });
  if (method === 'GET' && path === '/v2/bookings/BK1') return ok({ booking: { ...BOOKING } });
  if (method === 'PUT' && path === '/v2/bookings/BK1') {
    BOOKING = { ...BOOKING, ...body.booking, version: BOOKING.version + 1 };
    return ok({ booking: { ...BOOKING } });
  }
  if (method === 'POST' && path === '/v2/bookings/BK1/cancel') return ok({ booking:{ id:'BK1', status:'CANCELLED_BY_CUSTOMER' } });
  if (method === 'GET' && path === '/v2/customers/C1')
    return ok({ customer:{ id:'C1', given_name:'Pat', family_name:'Example', phone_number:'+17325550101' } });
  if (method === 'POST' && path === '/v2/customers/search')
    return ok({ customers:[{ id:'C1', given_name:'Pat', family_name:'Example', phone_number:'+17325550101' }] });
  if (method === 'GET' && path === '/v2/bookings') return ok({ bookings:[{ ...BOOKING }] });
  if (method === 'POST' && path === '/v2/orders/search') return ok({ orders: ORDERS });
  if (method === 'POST' && path === '/oauth2/token/status') return ok({ client_id:'sq0idp-TEST', merchant_id:'M' });
  if (method === 'POST' && path === '/v2/cards') {
    if (body.source_id === 'cnon:DECLINE') return { ok:false, status:400, text: async () => '{"errors":[{"code":"CARD_DECLINED_VERIFICATION_REQUIRED","detail":"Authorization error"}]}' };
    return ok({ card:{ id:'CARD1', card_brand:'VISA', last_4:'4242', customer_id: body.card.customer_id } });
  }
  if (method === 'POST' && path === '/v2/online-checkout/payment-links')
    return ok({ payment_link:{ id:'PL1', url:'https://square.link/u/TEST', order_id:'ORD1' } });
  throw new Error('unmocked ' + method + ' ' + path);
};

const handler = (await import('../netlify/functions/square.mjs')).default;
async function post(payload) {
  calls = []; alerts = [];
  const res = await handler(new Request('https://x/api/square', { method:'POST', body: JSON.stringify(payload) }));
  return { status: res.status, body: await res.json() };
}
let bad = 0;
const check = (label, cond, detail='') => {
  if (!cond) { bad++; console.log(`FAIL  ${label}`); if (detail) console.log('        ' + detail); }
  else console.log(`PASS  ${label}`);
};
const PAID_ORDER = { id:'ORD1', reference_id:'BK1', tenders:[{ id:'T1' }],
                     net_amount_due_money:{ amount:0 }, total_money:{ amount:7000 }, total_tip_money:{ amount:1000 } };

/* ---- making the link ---- */
let r = await post({ action:'paylink', bookingId:'BK1', phone:'(732) 555-0101' });
const link = calls.find(c => c.path === '/v2/online-checkout/payment-links');
check('the client gets a Square checkout link', r.status === 200 && r.body.url === 'https://square.link/u/TEST', JSON.stringify(r.body));
check('the order is tagged with the booking id', link?.body?.order?.reference_id === 'BK1');
check('it charges exactly the booked services, from the catalog',
      JSON.stringify(link?.body?.order?.line_items) === JSON.stringify([
        { catalog_object_id:'VAR_CUT', quantity:'1' }, { catalog_object_id:'VAR_BEARD', quantity:'1' }]),
      JSON.stringify(link?.body?.order?.line_items));
check('tipping is offered', link?.body?.checkout_options?.allow_tipping === true);
check('Square sends them back to the booking page with the booking id',
      link?.body?.checkout_options?.redirect_url === 'https://scissorsbysandy.com/book.html?paid=BK1');
check('making a link changes nothing on the booking', !calls.some(c => c.method === 'PUT'));
check('and alerts nobody', alerts.length === 0);

r = await post({ action:'paylink', bookingId:'BK1', phone:'9085550000' });
check('a stranger cannot get a link for it', r.status === 403 && !calls.some(c => c.path.includes('payment-links')));

/* ---- coming back, not yet paid ---- */
r = await post({ action:'paid', bookingId:'BK1' });
check('coming back before Square records it says not paid', r.status === 200 && r.body.paid === false);
check('and writes nothing', !calls.some(c => c.method === 'PUT') && alerts.length === 0);

/* ---- an unrelated or half-paid order does not count ---- */
ORDERS = [{ ...PAID_ORDER, reference_id:'OTHER' },
          { ...PAID_ORDER, id:'ORD0', tenders:[], net_amount_due_money:{ amount:7000 } }];
r = await post({ action:'paid', bookingId:'BK1' });
check('another booking’s payment does not count', r.body.paid === false);

/* ---- paid ---- */
ORDERS = [PAID_ORDER];
r = await post({ action:'paid', bookingId:'BK1' });
check('once Square shows it paid, the booking is paid', r.body.paid === true);
check('PAID AHEAD goes on the booking for Sandy, with the amount and tip',
      /PAID AHEAD \$60 \+ \$10 tip online\. Don't charge at checkout\./.test(BOOKING.seller_note), BOOKING.seller_note);
check('the original note is kept', BOOKING.seller_note.startsWith('Booked on scissorsbysandy.com'));
check('the write uses the booking version', calls.find(c => c.method === 'PUT')?.body?.booking?.version === 4);
check('Sandy gets one Paid ahead alert naming the client',
      alerts.length === 1 && alerts[0].headline === 'Paid ahead' && /Pat Example paid \$60 \+ \$10 tip/.test(alerts[0].text),
      JSON.stringify(alerts));

r = await post({ action:'paid', bookingId:'BK1' });
check('coming back twice does not write or alert again', r.body.paid === true && !calls.some(c => c.method === 'PUT') && alerts.length === 0);

r = await post({ action:'paylink', bookingId:'BK1', phone:'7325550101' });
check('no second link for a paid visit', r.body.paid === true && !calls.some(c => c.path.includes('payment-links')));

/* ---- a paid visit online ---- */
r = await post({ action:'cancel', bookingId:'BK1', phone:'7325550101' });
check('a paid visit cannot be cancelled online (Sandy refunds it)', r.status === 403 && /refund/.test(r.body.error) &&
      !calls.some(c => c.path.endsWith('/cancel')), JSON.stringify(r.body));
r = await post({ action:'reschedule', bookingId:'BK1', phone:'7325550101',
                 services:['VAR_CUT'], startAt: new Date(Date.now()+4*DAY).toISOString() });
check('a paid visit cannot drop a service online', r.status === 403);
r = await post({ action:'reschedule', bookingId:'BK1', phone:'7325550101',
                 services:['VAR_BEARD','VAR_CUT'], startAt: new Date(Date.now()+4*DAY).toISOString() });
check('but it can move to another time', r.status === 200, JSON.stringify(r.body));
check('and moving it keeps the PAID AHEAD note', /PAID AHEAD/.test(BOOKING.seller_note));

/* ---- paid, but the client never came back to the site ---- */
reset(); ORDERS = [PAID_ORDER];
r = await post({ action:'find', phone:'7325550101', name:'Pat Example' });
check('looking the appointment up later finds the payment and marks it',
      r.body.bookings?.[0]?.paid === true && /PAID AHEAD/.test(BOOKING.seller_note) && alerts.length === 1,
      JSON.stringify(r.body));


/* ---- if Square's order lookup errors, an ordinary cancel still works ---- */
reset();
const realFetch = global.fetch;
global.fetch = async (url, opts={}) => {
  if (String(url).includes('/v2/orders/search')) return { ok:false, status:403, text: async()=>'{"errors":[{"code":"INSUFFICIENT_SCOPES"}]}' };
  return realFetch(url, opts);
};
r = await post({ action:'cancel', bookingId:'BK1', phone:'7325550101' });
check('an order-lookup failure does not block an unpaid cancel', r.status === 200, JSON.stringify(r.body));
global.fetch = realFetch;

/* ---- card on file ---- */
reset();
r = await post({ action:'cardconfig' });
check('the card form gets the shop\u2019s public app id and location', r.body.appId === 'sq0idp-TEST' && r.body.locationId === 'LOC', JSON.stringify(r.body));
r = await post({ action:'savecard', bookingId:'BK1', phone:'7325550101', sourceId:'cnon:OK' });
const cardCall = calls.find(c => c.path === '/v2/cards');
check('the card is saved to the client on that booking', cardCall?.body?.card?.customer_id === 'C1' && cardCall?.body?.source_id === 'cnon:OK');
check('the page is told the brand and last four only', JSON.stringify(r.body) === '{"card":{"brand":"VISA","last4":"4242"}}', JSON.stringify(r.body));
check('saving a card charges nothing', !calls.some(c => c.path.includes('payments') || c.path.includes('payment-links')));
check('the appointment note tells Sandy the card is on file',
      /CARD ON FILE: Visa ending 4242, saved online\. Use it at checkout\./.test(BOOKING.seller_note) &&
      BOOKING.seller_note.startsWith('Booked on scissorsbysandy.com'), BOOKING.seller_note);
check('and Sandy gets one Card on file alert', alerts.length === 1 && alerts[0].headline === 'Card on file' &&
      /Pat Example saved a Visa ending 4242/.test(alerts[0].text), JSON.stringify(alerts));
r = await post({ action:'savecard', bookingId:'BK1', phone:'9085550000', sourceId:'cnon:OK' });
check('a stranger cannot put a card on someone else\u2019s record', r.status === 403 && !calls.some(c => c.path === '/v2/cards'));
r = await post({ action:'savecard', bookingId:'BK1', phone:'7325550101', sourceId:'cnon:DECLINE' });
check('a refused card gets a plain message, not Square\u2019s code', r.status === 400 && /couldn.t be saved/.test(r.body.error) && !/CARD_DECLINED/.test(r.body.error), JSON.stringify(r.body));
console.log(bad ? `\n${bad} check(s) failed` : '\nAll pay-ahead checks passed');
process.exit(bad ? 1 : 0);
