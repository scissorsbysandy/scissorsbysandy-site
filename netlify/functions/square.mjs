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

// Stamped on every booking this Function creates, and the thing the shop's
// new-booking alert looks for. Changing the wording means changing it in the
// alert too, or Sandy stops being told when someone books.
const WEB_BOOKING_NOTE = 'Booked on scissorsbysandy.com';

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

/**
 * A visit is usually more than one service: a cut and a beard, a shave and a
 * scalp treatment. Accept either one id or a list, and keep the order the
 * client chose, because Square books the segments in sequence.
 */
const MAX_SERVICES = 6;

function asServices(value) {
  const list = (Array.isArray(value) ? value : String(value || '').split(','))
    .map(v => String(v).trim())
    .filter(Boolean);
  if (!list.length) throw Object.assign(new Error('Please choose at least one service'), { status: 400 });
  if (list.length > MAX_SERVICES) {
    throw Object.assign(
      new Error(`That is more than ${MAX_SERVICES} services. Please call or text Sandy to book a visit this long`),
      { status: 400 });
  }
  return list;
}

/** One Square segment per chosen service, versions fetched together. */
async function buildSegments(serviceIds) {
  const { teamMemberId } = await setup();
  const versions = await Promise.all(serviceIds.map(serviceVersion));
  return serviceIds.map((id, i) => ({
    team_member_id: teamMemberId,
    service_variation_id: id,
    service_variation_version: versions[i],
  }));
}

async function availability(serviceIds, fromISO, toISO) {
  const { locationId, teamMemberId } = await setup();
  const { availabilities = [] } = await square('/v2/bookings/availability/search', {
    method: 'POST',
    body: {
      query: {
        filter: {
          start_at_range: { start_at: fromISO, end_at: toISO },
          location_id: locationId,
          // One filter per service. Square then only returns times where the
          // whole visit fits, rather than times where the first service fits
          // and the client gets turned away for the rest.
          segment_filters: serviceIds.map(id => ({
            service_variation_id: id,
            team_member_id_filter: { any: [teamMemberId] },
          })),
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

/**
 * Reuse a client's existing record, and quietly fill in what it is missing.
 *
 * The records imported from Booksy carry a phone number and little else. Square
 * had no address to send to, so a returning client got texts and no email, and
 * the address they had just typed into the form was thrown away on the way past.
 * Anything they give us that the record does not already hold is written back.
 *
 * Never overwrites: a value already on the record is the one Sandy or the client
 * put there. And a failure here is swallowed, because a booking must not fail
 * over a detail that could not be saved.
 */
async function reuseCustomer(c, { firstName, lastName, email }) {
  const patch = {};
  if (email && !c.email_address) patch.email_address = email;
  if (firstName && !c.given_name) patch.given_name = firstName;
  if (lastName && !c.family_name) patch.family_name = lastName;
  if (Object.keys(patch).length) {
    try {
      await square('/v2/customers/' + encodeURIComponent(c.id), {
        method: 'PUT',
        body: { ...patch, version: c.version },
      });
    } catch { /* the booking matters more than the backfill */ }
  }
  return c.id;
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
  if (customers.length === 1) return reuseCustomer(customers[0], { firstName, lastName, email });

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
    if (pick) return reuseCustomer(pick, { firstName, lastName, email });
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

/* ---------- one-time Booksy import -------------------------------------- */
/*
 * Moves the bookings already made in Booksy across to Square at cutover.
 * Booksy let Sandy shorten a service for a regular and book outside the
 * posted hours, so this keeps her lengths and does not check availability.
 * It is switched off unless MIGRATION_KEY is set, that key is only set on
 * the cutover preview, and this block is deleted once the import is done.
 * No website note is stamped, so the shop alert stays quiet for these.
 */
async function importBooking(p) {
  const { locationId } = await setup();
  const wanted = Array.isArray(p.segments) ? p.segments : [];
  const segments = await buildSegments(asServices(wanted.map(s => s.service)));
  wanted.forEach((s, i) => {
    if (Number(s.minutes) > 0) segments[i].duration_minutes = Number(s.minutes);
  });
  const customerId = p.customerId || await findOrCreateCustomer(p);
  const { booking } = await square('/v2/bookings', {
    method: 'POST',
    body: {
      idempotency_key: p.idempotencyKey || crypto.randomUUID(),
      booking: {
        location_id: locationId,
        start_at: p.startAt,
        customer_id: customerId,
        seller_note: 'Moved from Booksy',
        appointment_segments: segments,
      },
    },
  });
  return { id: booking.id, status: booking.status, startAt: booking.start_at, customerId };
}

/* ---------- create the booking ------------------------------------------ */

async function createBooking(p) {
  const { locationId } = await setup();
  const serviceIds = asServices(p.services ?? p.service);
  const segments = await buildSegments(serviceIds);
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
        // Square records a booking made with the seller's own token as created
        // by the team member, because that is whose token it is. From the
        // outside a client booking on the website is indistinguishable from
        // Sandy typing it into Square herself, so the alert that tells her
        // someone has booked cannot tell the two apart and stays silent.
        // This note is the difference. It is the seller's field, so no client
        // ever sees it, and it says plainly where the booking came from.
        seller_note: WEB_BOOKING_NOTE,
        appointment_segments: segments,
      },
    },
  });
  return { id: booking.id, status: booking.status, startAt: booking.start_at };
}

/* ---------- changing a booking ------------------------------------------ */

async function getBooking(bookingId) {
  const { booking } = await square('/v2/bookings/' + encodeURIComponent(bookingId));
  if (!booking) throw Object.assign(new Error('That appointment could not be found'), { status: 400 });
  return booking;
}

/**
 * The booking id is the only thing the page holds, so on its own it would let
 * anyone who got hold of one cancel a stranger's appointment. Require that the
 * phone number given matches the one on the booking before changing anything.
 */
async function assertOwner(booking, phone) {
  const e164 = toE164(phone);
  if (!e164) throw Object.assign(new Error('That phone number does not look right'), { status: 400 });
  if (!booking.customer_id) {
    throw Object.assign(new Error('Please call or text Sandy to change this one'), { status: 403 });
  }
  const { customer } = await square('/v2/customers/' + encodeURIComponent(booking.customer_id));
  if (!customer || customer.phone_number !== e164) {
    throw Object.assign(new Error('That appointment is not under this phone number'), { status: 403 });
  }
}

async function cancelBooking({ bookingId, phone }) {
  const booking = await getBooking(bookingId);
  await assertOwner(booking, phone);

  if (booking.status === 'CANCELLED_BY_CUSTOMER' || booking.status === 'CANCELLED_BY_SELLER') {
    return { id: booking.id, status: booking.status };            // already gone; not an error
  }

  const { booking: out } = await square(
    '/v2/bookings/' + encodeURIComponent(bookingId) + '/cancel',
    { method: 'POST', body: { idempotency_key: crypto.randomUUID(), booking_version: booking.version } },
  );
  return { id: out.id, status: out.status };
}

/**
 * Move an existing booking rather than booking a second one and deleting the
 * first. Square updates it in place, so there is never a moment where Sandy's
 * calendar holds both the old time and the new one.
 */
async function rescheduleBooking({ bookingId, phone, service, services, startAt }) {
  const booking = await getBooking(bookingId);
  await assertOwner(booking, phone);
  const segments = await buildSegments(asServices(services ?? service));

  const { booking: out } = await square('/v2/bookings/' + encodeURIComponent(bookingId), {
    method: 'PUT',
    body: {
      booking: {
        version: booking.version,
        start_at: startAt,
        appointment_segments: segments,
      },
    },
  });
  return { id: out.id, status: out.status, startAt: out.start_at };
}

/* ---------- entry point -------------------------------------------------- */

export default async (request) => {
  if (!TOKEN) return json(500, { error: 'Booking is not configured yet' });

  try {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.searchParams.get('action') === 'availability') {
      const services = url.searchParams.get('services') || url.searchParams.get('service');
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!services || !from || !to) return json(400, { error: 'services, from and to are all required' });
      return json(200, { slots: await availability(asServices(services), from, to) });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const action = body.action || 'book';
      const need = (fields) => {
        for (const f of fields) if (!body[f]) return `${f} is required`;
        return null;
      };

      if (action === 'cancel') {
        const missing = need(['bookingId', 'phone']);
        if (missing) return json(400, { error: missing });
        return json(200, { booking: await cancelBooking(body) });
      }

      if (action === 'reschedule') {
        const missing = need(['bookingId', 'phone', 'startAt']);
        if (missing) return json(400, { error: missing });
        return json(200, { booking: await rescheduleBooking(body) });
      }

      if (action === 'import') {
        const key = process.env.MIGRATION_KEY;
        if (!key || body.key !== key) return json(404, { error: 'Not found' });
        return json(200, { booking: await importBooking(body) });
      }

      if (action !== 'book') return json(400, { error: 'Unknown action' });

      const missing = need(['startAt', 'firstName', 'phone']);
      if (missing) return json(400, { error: missing });
      return json(200, { booking: await createBooking(body) });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    // Never hand Square's raw error to a client standing in the shop, but do
    // log it so a failed booking can be traced.
    console.error('square function failed:', err.message, err.squareErrors || '');
    const status = (err.status === 400 || err.status === 403) ? err.status : 502;
    return json(status, {
      error: status === 502 ? 'Could not reach the booking calendar' : err.message,
    });
  }
};

export const config = { path: '/api/square' };
