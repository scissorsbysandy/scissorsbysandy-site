import crypto from 'node:crypto';
process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = 'test-signature-key-not-real';
process.env.SQUARE_WEBHOOK_URL = 'https://scissorsbysandy.com/api/square-webhook';
process.env.SQUARE_ACCESS_TOKEN = 'test-token-not-real';
process.env.SBS_ALERT_URL = 'https://alerts.example/hook';

const CUSTOMERS = { CUST_MIKE: { given_name:'Mike', family_name:'Stevens', phone_number:'+17329666437' },
                    CUST_NONAME: { phone_number:'+15163174495' } };
const CATALOG = { SVC_CUT:'The Executive', SVC_SCALP:'Scalp Treatment', SVC_KIDS:'The Royal Roots' };

let alerts = [];
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const ok = (o) => ({ ok:true, status:200, json: async () => o });
  if (u.href === process.env.SBS_ALERT_URL) { alerts.push(JSON.parse(opts.body)); return ok({}); }
  if (u.pathname.startsWith('/v2/customers/')) {
    const c = CUSTOMERS[u.pathname.split('/').pop()];
    return c ? ok({ customer: c }) : { ok:false, status:404, json: async()=>({}) };
  }
  if (u.pathname.startsWith('/v2/catalog/object/')) {
    const id = u.pathname.split('/').pop();
    return CATALOG[id] ? ok({ object:{ item_variation_data:{ name: CATALOG[id] } } })
                       : { ok:false, status:404, json: async()=>({}) };
  }
  throw new Error('unmocked ' + u.pathname);
};

const handler = (await import('../netlify/functions/square-webhook.mjs')).default;

const sign = (body, key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
                    url = process.env.SQUARE_WEBHOOK_URL) =>
  crypto.createHmac('sha256', key).update(url + body).digest('base64');

async function post(bodyObj, { signature, raw } = {}) {
  alerts = [];
  const body = raw ?? JSON.stringify(bodyObj);
  const res = await handler(new Request('https://scissorsbysandy.com/api/square-webhook', {
    method: 'POST', body,
    headers: signature === null ? {} : { 'x-square-hmacsha256-signature': signature ?? sign(body) },
  }));
  return { status: res.status, alerts };
}

const evt = (type, booking, event_id='ev1') => ({ type, event_id, data:{ object:{ booking } } });
const BOOKING = { id:'BK1', status:'ACCEPTED', customer_id:'CUST_MIKE',
  start_at:'2027-01-08T19:00:00Z',
  appointment_segments:[{service_variation_id:'SVC_CUT'},{service_variation_id:'SVC_SCALP'}] };

let bad=0; const check=(l,c,d='')=>{ if(!c){bad++;console.log(`FAIL  ${l}`);if(d)console.log('        '+String(d).slice(0,200))} else console.log(`PASS  ${l}`) };

// --- the alert itself ---
let r = await post(evt('booking.created', BOOKING));
check('a real Square event is accepted', r.status===200);
check('Sandy is alerted', r.alerts.length===1, JSON.stringify(r.alerts));
const a = r.alerts[0] || {};
check('the alert names the client', /Mike Stevens/.test(a.text||''), a.text);
check('it lists both services', /The Executive/.test(a.text) && /Scalp Treatment/.test(a.text), a.text);
check('it gives the time in her timezone', /2:00 PM/.test(a.text||''), a.text);
check('it says what happened', a.headline==='New booking', a.headline);
check('it carries the booking id for reference', a.bookingId==='BK1');

// --- two of the same service read as a count ---
r = await post(evt('booking.created', { ...BOOKING, appointment_segments:[
  {service_variation_id:'SVC_KIDS'},{service_variation_id:'SVC_KIDS'}]}));
check('two of one service read as "× 2"', /Royal Roots\s*×\s*2/.test(r.alerts[0]?.text||''), r.alerts[0]?.text);

// --- cancellations are not announced as new bookings ---
r = await post(evt('booking.updated', { ...BOOKING, status:'CANCELLED_BY_CUSTOMER' }));
check('a cancellation says cancelled', r.alerts[0]?.headline==='Cancelled', r.alerts[0]?.headline);

// --- a client with no surname ---
r = await post(evt('booking.created', { ...BOOKING, customer_id:'CUST_NONAME' }));
check('a client with no surname still gets named', /\+15163174495|Someone/.test(r.alerts[0]?.text||''), r.alerts[0]?.text);

// --- security ---
r = await post(evt('booking.created', BOOKING), { signature:'not-the-right-signature' });
check('a forged signature is refused', r.status===401);
check('and Sandy is told nothing', r.alerts.length===0);

r = await post(evt('booking.created', BOOKING), { signature:null });
check('no signature at all is refused', r.status===401);

const body = JSON.stringify(evt('booking.created', BOOKING));
r = await post(null, { raw: body, signature: sign(body, 'a-different-key') });
check('the wrong signing key is refused', r.status===401);
r = await post(null, { raw: body, signature: sign(body, undefined, 'https://evil.example/hook') });
check('a signature for another URL is refused', r.status===401);

// body tampered after signing: same length, one character different
const tampered = body.replace('"BK1"','"BK9"');
r = await post(null, { raw: tampered, signature: sign(body) });
check('the tamper actually changed the body', tampered !== body && tampered.length === body.length);
check('a tampered body is refused', r.status===401, 'got '+r.status);

// --- things that must not make Square retry ---
r = await post(evt('payment.created', undefined));
check('an unrelated event is accepted quietly', r.status===200 && r.alerts.length===0);
r = await post(null, { raw:'not json', signature: sign('not json') });
check('unparseable json does not error', r.status===200);

console.log(bad?`\n${bad} check(s) failed`:'\nall checks pass');
process.exit(bad?1:0);
