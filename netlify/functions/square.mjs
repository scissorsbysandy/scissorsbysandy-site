/**
 * Booking back end for the Square cutover.
 *
 * The booking page never talks to Square directly: the access token must never
 * reach a browser. The page calls this Function, this Function calls Square.
 *
 * Two jobs:
 *   GET  /api/square?action=availability&service=<id>&from=<ISO>&to=<ISO>
 *        -> the times Sandy is genuinely free, straight from Square's calendar.
 *   POST /api/square   {service, startAt, firstName, lastName, phone, email, note}
 *        -> finds or creates the client, then books them in.
 *
 * Only ONE secret is needed: SQUARE_ACCESS_TOKEN. The location and Sandy's team
 * member id are looked up from that token, so there is nothing else to paste in
 * and nothing to go stale if Square reissues them.
 *
 * Why the service version is not hardcoded: Square requires
 * service_variation_version on every booking, and that number changes every time
 * a service is edited in Square (a price change is enough). A hardcoded version
 * would keep working right up until Sandy edits a price, then fail. So it is
 * read from the catalog and cached only for the life of a warm container.
 */

const SQUARE_VERSION = '2026-09-16';
const HOST = process.env.SQUARE_ENV === 'sandbox'
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';

const TOKEN = process.env.SQUARE_ACCESS_TOKEN;

/* ---------- small helpers ---------------------------------------------- */

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

async function square(path, { method = 'GET', body } = {}) {
  const res = await fetch(HOST + path, {
    method,
    headers: {
      'Square-Version': SQUARE_VERSION,
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    // Square returns {errors:[{category,code,detail}]}
    const detail = (data.errors || []).map(e => `${e.code}: ${e.detail || ''}`).join('; ')
      || `HTTP ${res.status}`;
    const err = new Error(detail);
    err.status = res.status;
    err.squareErrors = data.errors || [];
    throw err;
  }
  return data;
}

/* ---------- things that are the same for every request ------------------ */
/* Cached per warm container, not across deploys. A cold start costs two extra
   calls; getting it wrong costs every booking, so this trade is worth it. */

let cachedSetup = null;

async function setup() {
  if (cachedSetup) return cachedSetup;

  const { locations = [] } = await square('/v2/locations');
  const active = locations.filter(l => l.status === 'ACTIVE');
  if (active.length === 0) throw new Error('No active Square location on this account');
  if (active.length > 1) {
    // One chair, one suite. More than one active location means the token is
    // for a different business than we think, so refuse rather than guess.
    throw new Error(`Expected one active location, found ${active.length}`);
  }
  const locationId = active[0].id;

  const { team_member_booking_profiles: profiles = [] } =
    await square(`/v2/bookings/team-member-booking-profiles?location_id=${encodeURIComponent(locationId)}`);
  const bookable = profiles.filter(p => p.is_bookable);
  if (bookable.length === 0) throw new Error('No bookable team member in Square');
  if (bookable.length > 1) {
    throw new Error(`Expected one bookable team member, found ${bookable.length}`);
  }
  const teamMemberId = bookable[0].team_member_id;

  cachedSetup = { locationId, teamMemberId };
  return cachedSetup;
}

/** Current version of a service. Required by Square and changes on every edit. */
async function serviceVersion(serviceId) {
  const { object } = await square(`/v2/catalog/object/${encodeURIComponent(serviceId)}`);
  if (!object || object.type !== 'ITEM_VARIATION') {
    throw new Error(`Service ${serviceId} is not a bookable service in Square`);
  }
  return object.version;
}

/* ---------- availability ------------------------------------------------ */

async function availability(serviceId, fromISO, toISO) {
  const { locationId, teamMemberId } = await setup();
  const { availabilities = [] } = await square('/v2/bookings/availability/search', {
    method: 'POST',
    body: {
      query: {
        filter: {
          start_at_range: { start_at: fromISO, end_at: toISO },
          location_id: locationId,
          segment_filters: [{
            service_variation_id: serviceId,
            team_member_id_filter: { any: [teamMemberId] },
          }],
        },
      },
    },
  });
  // The page only needs the start times; everything else it already knows.
  return availabilities.map(a => a.start_at);
}

/* ---------- client matching --------------------------------------------- */

/**
 * Repeat clients must not become a second record on day one. Square's customer
 * search matches an exact phone, so the page's digits are normalised to E.164
 * before searching. If nothing matches we create the client.
 */
function toE164(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;              // US, as typed in the shop
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;                                                  // refuse to guess
}

/**
 * Compare names loosely enough to survive casing, accents and punctuation
 * ("O'Neil" / "oneil", "jayden" / "Jayden") without matching different people.
 */
function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
}

async function findOrCreateCustomer({ firstName, lastName, phone, email }) {
  const e164 = toE164(phone);
  if (!e164) throw Object.assign(new Error('That phone number does not look right'), { status: 400 });

  // Ask for the whole household, not just the first hit: five of the imported
  // numbers are shared by two clients (a parent and a child, a shop and its
  // owner), so a one-result search would book one person under another's name.
  const { customers = [] } = await square('/v2/customers/search', {
    method: 'POST',
    body: { query: { filter: { phone_number: { exact: e164 } } }, limit: 20 },
  });

  // One record on the number: reuse it even if the name is spelled differently
  // ("Mike" for Michael). Being strict here would create a second record for a
  // regular every time they shorten their own name.
  if (customers.length === 1) return customers[0].id;

  // More than one: the name has to agree before an existing record is reused.
  if (customers.length > 1) {
    const fn = normName(firstName);
    const ln = normName(lastName);
    // Oldest first, so a client with history wins over a stray newer record.
    const byAge = [...customers].sort((a, b) =>
      String(a.created_at || '').localeCompare(String(b.created_at || '')));
    const full  = byAge.filter(c => normName(c.given_name) === fn && normName(c.family_name) === ln);
    const first = byAge.filter(c => normName(c.given_name) === fn);
    const pick  = full[0] || first[0];
    if (pick) return pick.id;
    // Nobody on this number by that name, so this is a new member of the
    // household and gets their own record rather than borrowing a relative's.
  }

  const { customer } = await square('/v2/customers', {
    method: 'POST',
    body: {
      idempotency_key: crypto.randomUUID(),
      given_name: firstName,
      family_name: lastName,
      phone_number: e164,
      ...(email ? { email_address: email } : {}),
    },
  });
  return customer.id;
}

/* ---------- create the booking ------------------------------------------ */

async function createBooking(p) {
  const { locationId, teamMemberId } = await setup();
  const version = await serviceVersion(p.service);
  const customerId = await findOrCreateCustomer(p);

  const { booking } = await square('/v2/bookings', {
    method: 'POST',
    body: {
      idempotency_key: p.idempotencyKey || crypto.randomUUID(),
      booking: {
        location_id: locationId,
        start_at: p.startAt,
        customer_id: customerId,
        ...(p.note ? { customer_note: String(p.note).slice(0, 1500) } : {}),
        appointment_segments: [{
          team_member_id: teamMemberId,
          service_variation_id: p.service,
          service_variation_version: version,
        }],
      },
    },
  });
  return { id: booking.id, status: booking.status, startAt: booking.start_at };
}

/* ---------- entry point -------------------------------------------------- */

export default async (request) => {
  if (!TOKEN) return json(500, { error: 'Booking is not configured yet' });

  try {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.searchParams.get('action') === 'availability') {
      const service = url.searchParams.get('service');
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!service || !from || !to) return json(400, { error: 'service, from and to are all required' });
      return json(200, { slots: await availability(service, from, to) });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      for (const f of ['service', 'startAt', 'firstName', 'phone']) {
        if (!body[f]) return json(400, { error: `${f} is required` });
      }
      return json(200, { booking: await createBooking(body) });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    // Never hand Square's raw error to a client standing in the shop, but do
    // log it so a failed booking can be traced.
    console.error('square function failed:', err.message, err.squareErrors || '');
    const status = err.status === 400 ? 400 : 502;
    return json(status, {
      error: status === 400 ? err.message : 'Could not reach the booking calendar',
    });
  }
};

export const config = { path: '/api/square' };
