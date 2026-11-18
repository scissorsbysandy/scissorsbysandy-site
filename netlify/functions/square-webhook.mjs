/**
 * Tell Sandy a booking happened.
 *
 * Square does not notify the seller for bookings made through the Bookings
 * API: the client gets their confirmation, the owner gets nothing. Booksy
 * pinged her phone, so without this she would only learn of an appointment by
 * opening the Square app and looking. This listens for Square's booking
 * events instead and pushes a readable line to wherever she is reachable.
 *
 * It also catches bookings made anywhere else - the Square app, and Reserve
 * with Google later - which a notice sent from our own booking page would not.
 *
 *   POST /api/square-webhook      (Square calls this; nobody else should)
 *
 * Environment:
 *   SQUARE_WEBHOOK_SIGNATURE_KEY  the subscription's signature key, NOT the
 *                                 access token. They are different strings.
 *   SQUARE_WEBHOOK_URL            the notification URL exactly as registered
 *                                 with Square; it is part of what is signed.
 *   SQUARE_ACCESS_TOKEN           used only to turn ids into names.
 *   SBS_ALERT_URL                 where the readable alert is POSTed.
 */
import crypto from 'node:crypto';

const HOST = process.env.SQUARE_ENV === 'sandbox'
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';

const SIGNING_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
const NOTIFY_URL  = process.env.SQUARE_WEBHOOK_URL;
const TOKEN       = process.env.SQUARE_ACCESS_TOKEN;
const ALERT_URL   = process.env.SBS_ALERT_URL;

/**
 * Square signs the notification URL immediately followed by the raw body.
 * The raw body, never a re-serialised copy: re-encoding changes bytes and the
 * signature no longer matches.
 */
function sentBySquare(rawBody, header) {
  if (!SIGNING_KEY || !NOTIFY_URL || !header) return false;
  const expected = crypto.createHmac('sha256', SIGNING_KEY)
    .update(NOTIFY_URL + rawBody)
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  // Length check first: timingSafeEqual throws on a length mismatch.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function square(path) {
  const res = await fetch(HOST + path, {
    headers: { 'Square-Version': '2026-10-15', Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`Square ${path} -> ${res.status}`);
  return res.json();
}

/* ---------- turning ids into something readable ------------------------- */

async function clientName(customerId) {
  if (!customerId) return 'Someone';
  try {
    const { customer } = await square('/v2/customers/' + encodeURIComponent(customerId));
    const name = [customer?.given_name, customer?.family_name].filter(Boolean).join(' ').trim();
    return name || customer?.phone_number || 'Someone';
  } catch { return 'Someone'; }
}

async function serviceNames(segments = []) {
  const names = [];
  for (const seg of segments) {
    try {
      const { object } = await square('/v2/catalog/object/' + encodeURIComponent(seg.service_variation_id));
      names.push(object?.item_variation_data?.name || 'a service');
    } catch { names.push('a service'); }
  }
  // "The Royal Roots x 2" rather than the same name twice in a row
  const out = [];
  for (const n of names) {
    const last = out[out.length - 1];
    if (last && last.name === n) last.qty++; else out.push({ name: n, qty: 1 });
  }
  return out.map(g => g.qty > 1 ? `${g.name} × ${g.qty}` : g.name);
}

function whenText(startAt, tz = 'America/New_York') {
  try {
    return new Date(startAt).toLocaleString('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch { return startAt; }
}

const HEADLINE = {
  'booking.created': 'New booking',
  'booking.updated': 'Booking changed',
};

function headlineFor(type, booking) {
  const s = String(booking?.status || '');
  if (s.startsWith('CANCELLED')) return 'Cancelled';
  return HEADLINE[type] || 'Booking';
}

/* ---------- entry point -------------------------------------------------- */

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const raw = await request.text();
  if (!sentBySquare(raw, request.headers.get('x-square-hmacsha256-signature'))) {
    // Anyone can find this address. Without a matching signature it is not
    // Square, and Sandy is not told anything.
    return new Response('Bad signature', { status: 401 });
  }

  let event;
  try { event = JSON.parse(raw); } catch { return new Response('OK', { status: 200 }); }

  const type = event?.type || '';
  const booking = event?.data?.object?.booking;
  if (!booking || !type.startsWith('booking.')) {
    return new Response('OK', { status: 200 });   // not ours; never make Square retry
  }

  try {
    const [who, services] = await Promise.all([
      clientName(booking.customer_id),
      serviceNames(booking.appointment_segments),
    ]);
    const line = `${headlineFor(type, booking)}: ${who} — ${services.join(', ') || 'a service'}, `
               + `${whenText(booking.start_at)}`;

    if (ALERT_URL) {
      await fetch(ALERT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: line,
          headline: headlineFor(type, booking),
          client: who,
          services,
          startAt: booking.start_at,
          status: booking.status,
          bookingId: booking.id,
          eventId: event.event_id,
        }),
      });
    } else {
      console.log('no SBS_ALERT_URL set; would have sent:', line);
    }
  } catch (err) {
    // Never fail the webhook over a lookup or a delivery: Square would retry
    // and Sandy would get the same booking announced several times.
    console.error('alert failed:', err.message);
  }

  return new Response('OK', { status: 200 });
};

export const config = { path: '/api/square-webhook' };
