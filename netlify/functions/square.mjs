/**
 * Booking back end for the Square cutover.
 *
 * The booking page never talks to Square directly: the access token must never
 * reach a browser. The page calls this Function, this Function calls Square.
 *
 * Jobs (the main two):
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

// Written into the booking's seller note once a client has paid ahead, so
// Sandy sees it on the appointment before she checks them out. The webhook
// reads the bracketed stamp to stay quiet about the note change itself.
const PAID_MARK = 'PAID AHEAD';
const SITE = 'https://scissorsbysandy.com';
const ALERT_URL = process.env.SBS_ALERT_URL;

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
 * ("O'Brien" / "obrien", "jayden" / "Jayden") without matching different people.
 */
function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
}

/**
 * Where a client's email lives.
 *
 * Booking emails come from Sandy's own address (the Zapier workflow), not from
 * Square. Square emails anyone whose email is in its own email field, and that
 * cannot be switched off per message, so the address is kept in a private
 * custom field, notify_email, instead. Square never sees it as an email to
 * write to; the workflow reads it. Square texts still go out, by phone number.
 *
 * The field belongs to the Zapier connection, so from this token its key comes
 * back qualified ("<app id>:notify_email"); it is looked up, not hardcoded.
 * Every call here is best effort: a booking must never fail over an email.
 */
let notifyKeyPromise = null;
function notifyKey() {
  if (!notifyKeyPromise) {
    notifyKeyPromise = (async () => {
      const { custom_attribute_definitions = [] } =
        await square('/v2/customers/custom-attribute-definitions?limit=100');
      const def = custom_attribute_definitions.find(d =>
        d.key === 'notify_email' || String(d.key).endsWith(':notify_email'));
      return def ? def.key : null;
    })().catch(() => { notifyKeyPromise = null; return null; });
  }
  return notifyKeyPromise;
}

async function getNotifyEmail(customerId) {
  try {
    const key = await notifyKey();
    if (!key || !customerId) return '';
    const { custom_attribute } = await square('/v2/customers/' + encodeURIComponent(customerId)
      + '/custom-attributes/' + encodeURIComponent(key));
    return String(custom_attribute?.value || '');
  } catch { return ''; }
}

async function setNotifyEmail(customerId, email, { onlyIfEmpty = false } = {}) {
  try {
    const key = await notifyKey();
    if (!key || !customerId || !email) return;
    if (onlyIfEmpty && await getNotifyEmail(customerId)) return;
    await square('/v2/customers/' + encodeURIComponent(customerId)
      + '/custom-attributes/' + encodeURIComponent(key), {
      method: 'POST',
      body: { custom_attribute: { value: String(email).trim() }, idempotency_key: crypto.randomUUID() },
    });
  } catch { /* the booking matters more than the email */ }
}

/**
 * Reuse a client's existing record, and quietly fill in what it is missing.
 *
 * The records imported from Booksy carry a phone number and little else, so a
 * returning client got texts and no email, and the address they had just typed
 * into the form was thrown away on the way past. Anything they give us that the
 * record does not already hold is written back (the email to notify_email).
 *
 * Never overwrites: a value already on the record is the one Sandy or the client
 * put there. And a failure here is swallowed, because a booking must not fail
 * over a detail that could not be saved.
 */
async function reuseCustomer(c, { firstName, lastName, email }) {
  const patch = {};
  if (email) await setNotifyEmail(c.id, email, { onlyIfEmpty: true });
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
    },
  });
  if (email) await setNotifyEmail(customer.id, email);
  return customer.id;
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
  return customer;
}

async function cancelBooking({ bookingId, phone }) {
  const booking = await getBooking(bookingId);
  await assertOwner(booking, phone);

  if (booking.status === 'CANCELLED_BY_CUSTOMER' || booking.status === 'CANCELLED_BY_SELLER') {
    return { id: booking.id, status: booking.status };            // already gone; not an error
  }
  // A paid visit is refunded by Sandy, so she has to hear about it from the
  // client rather than find a cancelled, paid appointment on her calendar.
  let paidOnline = isPaid(booking);
  if (!paidOnline) {
    // If the order lookup itself fails, a cancel must still work.
    try { paidOnline = !!(await paidOrderFor(booking.id)); } catch { paidOnline = false; }
  }
  if (paidOnline) {
    throw Object.assign(new Error('This one is paid ahead, so please call or text Sandy at (848) 230-5995 to cancel and she will refund you'), { status: 403 });
  }

  // Square records a cancel made with the shop's token as cancelled by the
  // seller, the same as Sandy cancelling. The stamp tells the email workflow
  // the client did it, so they get "thanks for the heads-up", not "Sandy
  // cancelled you". If the stamp can't be written the cancel still goes ahead.
  let version = booking.version;
  try {
    const line = `[web cancel ${new Date().toISOString()}]`;
    const note = [booking.seller_note, line].filter(Boolean).join('\n');
    const { booking: stamped } = await square('/v2/bookings/' + encodeURIComponent(bookingId), {
      method: 'PUT',
      body: { booking: { version: booking.version, seller_note: note.slice(0, 4096) } },
    });
    if (stamped?.version != null) version = stamped.version;
  } catch { /* the cancel matters more than the stamp */ }

  const { booking: out } = await square(
    '/v2/bookings/' + encodeURIComponent(bookingId) + '/cancel',
    { method: 'POST', body: { idempotency_key: crypto.randomUUID(), booking_version: version } },
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
  const wanted = asServices(services ?? service);
  // A paid visit can move to another time, but not change what was paid for.
  if (isPaid(booking)) {
    const had = (booking.appointment_segments || []).map(s => s.service_variation_id).sort().join(',');
    if ([...wanted].sort().join(',') !== had) {
      throw Object.assign(new Error('This one is paid ahead, so the services can’t change online. Please call or text Sandy at (848) 230-5995'), { status: 403 });
    }
  }
  const segments = await buildSegments(wanted);

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

/* ---------- paying ahead ------------------------------------------------- */

/**
 * Booksy let clients pay in the app before they arrived, and some did. This is
 * the same thing, optional: the client is sent to Square's own checkout page
 * (cards, Apple Pay, Google Pay, Afterpay, a tip), so no card number ever
 * touches this site. Nothing here charges anyone.
 *
 * Square does not tie a payment-link order to a client or to a booking, so the
 * order carries the booking id as its reference, and that is how a payment is
 * matched back to its appointment. Once matched, the booking's seller note says
 * PAID AHEAD and Sandy gets an alert, so nobody is charged twice at the chair.
 */
const isPaid = (b) => String(b?.seller_note || '').includes(PAID_MARK);
const dollars = (cents) => '$' + (Number(cents || 0) / 100).toFixed(2).replace(/\.00$/, '');

function whenText(startAt) {
  return new Date(startAt).toLocaleString('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function payNote(customer, booking) {
  const who = [customer?.given_name, customer?.family_name].filter(Boolean).join(' ').trim();
  const when = whenText(booking.start_at);
  return ('Paid ahead' + (who ? ' for ' + who : '') + ': appointment ' + when + ' with Sandy').slice(0, 500);
}

/** Paid pay-ahead orders from the last 120 days, keyed by booking id. Read only. */
async function paidOrders() {
  const { locationId } = await setup();
  const since = new Date(Date.now() - 120 * 86400000).toISOString();
  const out = new Map();
  let cursor;
  for (let page = 0; page < 10; page++) {
    const res = await square('/v2/orders/search', {
      method: 'POST',
      body: {
        location_ids: [locationId],
        query: {
          filter: { date_time_filter: { created_at: { start_at: since } } },
          sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
        },
        limit: 200,
        ...(cursor ? { cursor } : {}),
      },
    });
    for (const o of res.orders || []) {
      if (!o.reference_id) continue;
      const paidIn = (o.tenders || []).length > 0;
      const owed = Number(o.net_amount_due_money?.amount ?? 1);
      if (paidIn && owed === 0 && !out.has(o.reference_id)) out.set(o.reference_id, o);
    }
    cursor = res.cursor;
    if (!cursor) break;
  }
  return out;
}
async function paidOrderFor(bookingId) {
  return (await paidOrders()).get(bookingId) || null;
}

/** Write PAID AHEAD on the booking and tell Sandy. Safe to call twice. */
async function markPaid(booking, order) {
  if (isPaid(booking)) return;
  const total = order.total_money?.amount ?? 0;
  const tip = order.total_tip_money?.amount ?? 0;
  const amount = dollars(total - tip) + (tip ? ` + ${dollars(tip)} tip` : '');
  const stamp = new Date().toISOString();
  const line = `${PAID_MARK} ${amount} online. Don't charge at checkout. [paid ${stamp} order ${order.id}]`;
  const note = [booking.seller_note, line].filter(Boolean).join('\n');
  await square('/v2/bookings/' + encodeURIComponent(booking.id), {
    method: 'PUT',
    body: { booking: { version: booking.version, seller_note: note.slice(0, 4096) } },
  });
  if (ALERT_URL) {
    let who = 'A client';
    try {
      const { customer } = await square('/v2/customers/' + encodeURIComponent(booking.customer_id));
      who = [customer?.given_name, customer?.family_name].filter(Boolean).join(' ') || who;
    } catch { /* the alert matters more than the name */ }
    try {
      await fetch(ALERT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: `Paid ahead: ${who} paid ${amount} for ${whenText(booking.start_at)}. Don't charge them at checkout.`,
          headline: 'Paid ahead', client: who, startAt: booking.start_at,
          status: booking.status, bookingId: booking.id,
        }),
      });
    } catch { /* never fail a paid client over an alert */ }
  }
}

/** Has this booking been paid? Marks it if Square says so. */
async function checkPaid(bookingId) {
  const booking = await getBooking(bookingId);
  if (isPaid(booking)) return true;
  const order = await paidOrderFor(booking.id);
  if (!order) return false;
  await markPaid(booking, order);
  return true;
}

async function payLink({ bookingId, phone }) {
  const booking = await getBooking(bookingId);
  const customer = await assertOwner(booking, phone);
  if (await checkPaid(booking.id)) return { paid: true };
  if (booking.status !== 'ACCEPTED' && booking.status !== 'PENDING') {
    throw Object.assign(new Error('This appointment is no longer booked'), { status: 400 });
  }
  if (new Date(booking.start_at).getTime() <= Date.now()) {
    throw Object.assign(new Error('This appointment has already started'), { status: 400 });
  }
  const { locationId } = await setup();
  const buyerEmail = (await getNotifyEmail(customer.id)) || customer.email_address || '';
  const { payment_link } = await square('/v2/online-checkout/payment-links', {
    method: 'POST',
    body: {
      idempotency_key: crypto.randomUUID(),
      description: 'Pay ahead for booking ' + booking.id,
      order: {
        location_id: locationId,
        reference_id: booking.id,
        line_items: (booking.appointment_segments || []).map(s => ({
          catalog_object_id: s.service_variation_id, quantity: '1',
        })),
      },
      checkout_options: {
        allow_tipping: true,
        ask_for_shipping_address: false,
        redirect_url: SITE + '/book.html?paid=' + encodeURIComponent(booking.id),
      },
      // The client's own email, so the receipt reaches them and Square files
      // the payment under the client it already knows rather than a new one.
      pre_populated_data: {
        buyer_phone_number: toE164(phone),
        ...(buyerEmail ? { buyer_email: buyerEmail } : {}),
      },
      // Printed at the top of the receipt and on the payment in Square, so it
      // says who it is for, what, and when.
      payment_note: payNote(customer, booking),
    },
  });
  return { url: payment_link.url || payment_link.long_url };
}

/* ---------- card on file ------------------------------------------------ */

/**
 * Optional: a client can save a card to their own record in Square, so Sandy
 * can check them out with it. The card is typed into Square's own fields on
 * the page (Square's Web Payments SDK); this Function only ever sees the
 * one-time token Square gives back, never a card number. Nothing is charged.
 *
 * The SDK needs the app id and location id, both public. The app id is read
 * from the token's own status, so there is still only one secret to set.
 */
let cachedAppId = null;
async function cardConfig() {
  const { locationId } = await setup();
  if (!cachedAppId) {
    cachedAppId = process.env.SQUARE_APPLICATION_ID || null;
    if (!cachedAppId) {
      const st = await square('/oauth2/token/status', { method: 'POST', body: {} });
      cachedAppId = st.client_id || null;
    }
  }
  if (!cachedAppId) throw Object.assign(new Error('Saving a card is not available right now'), { status: 400 });
  return { appId: cachedAppId, locationId };
}

async function saveCard({ bookingId, phone, sourceId }) {
  const booking = await getBooking(bookingId);
  await assertOwner(booking, phone);
  let card;
  try {
    ({ card } = await square('/v2/cards', {
      method: 'POST',
      body: {
        idempotency_key: crypto.randomUUID(),
        source_id: String(sourceId),
        card: { customer_id: booking.customer_id },
      },
    }));
  } catch (err) {
    // Square's own wording (CARD_DECLINED_VERIFICATION_REQUIRED and so on) is
    // not for a client. Log it, and tell them plainly.
    console.error('save card failed:', err.message);
    throw Object.assign(new Error('That card couldn\u2019t be saved. Please check the details or try another card'), { status: 400 });
  }
  const brand = card?.card_brand || 'Card';
  const last4 = card?.last_4 || '';
  const label = brand.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
              + (last4 ? ' ending ' + last4 : '');
  // Put it where Sandy looks: the appointment's note, above Take payment, and
  // an alert. A failure here must not undo a card that was saved.
  try {
    const fresh = await getBooking(booking.id);
    const stamp = new Date().toISOString();
    const line = `CARD ON FILE: ${label}, saved online. Use it at checkout. [card ${stamp}]`;
    const note = [fresh.seller_note, line].filter(Boolean).join('\n');
    await square('/v2/bookings/' + encodeURIComponent(booking.id), {
      method: 'PUT',
      body: { booking: { version: fresh.version, seller_note: note.slice(0, 4096) } },
    });
  } catch (err) { console.error('card note failed:', err.message); }
  if (ALERT_URL) {
    let who = 'A client';
    try {
      const { customer } = await square('/v2/customers/' + encodeURIComponent(booking.customer_id));
      who = [customer?.given_name, customer?.family_name].filter(Boolean).join(' ') || who;
    } catch { /* the alert matters more than the name */ }
    try {
      await fetch(ALERT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: `Card on file: ${who} saved a ${label} for ${whenText(booking.start_at)}. Use it at checkout.`,
          headline: 'Card on file', client: who, startAt: booking.start_at,
          status: booking.status, bookingId: booking.id,
        }),
      });
    } catch { /* never fail over an alert */ }
  }
  return { brand, last4 };
}

/* ---------- finding a client's appointments ------------------------------ */

/**
 * The page remembers only the bookings made in that browser. Appointments moved
 * over from Booksy, made by Sandy, or booked on another phone were invisible to
 * it, so those clients had to call to move or cancel. This finds them.
 *
 * Two things must agree before anything is shown: the phone number on the
 * record, and a name on it (first or last, so the single-name records Booksy
 * kept, like "Andrew", still work). A number on its own is not enough, because
 * one number can be a whole household. If nothing matches, the answer is the
 * same empty list whether or not the number is known, so the lookup cannot be
 * used to test whose number is whose.
 */
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr']);
function nameTokens(...parts) {
  return parts.join(' ').split(/[\s,]+/).map(normName).filter(t => t.length >= 2 && !TITLES.has(t));
}

async function findBookings({ phone, name }) {
  const e164 = toE164(phone);
  if (!e164) throw Object.assign(new Error('That phone number does not look right'), { status: 400 });
  const typed = nameTokens(name);
  if (!typed.length) throw Object.assign(new Error('Please enter your name'), { status: 400 });

  const { customers = [] } = await square('/v2/customers/search', {
    method: 'POST',
    body: { query: { filter: { phone_number: { exact: e164 } } }, limit: 20 },
  });
  // Score each record on the number by how many typed names it carries, and keep
  // only the best. "Pat Example" then finds Pat and not Pat's child on the same
  // number, while "Example" on its own still shows the whole household.
  const scored = customers.map(c => {
    const have = nameTokens(c.given_name, c.family_name);
    return { c, score: typed.filter(t => have.includes(t)).length };
  });
  const best = Math.max(0, ...scored.map(s => s.score));
  const mine = best ? scored.filter(s => s.score === best).map(s => s.c) : [];
  if (!mine.length) return { client: null, bookings: [] };

  const { locationId } = await setup();
  const now = Date.now();
  const DAY = 86400000;
  const out = [];
  for (const c of mine) {
    // Square lists at most 31 days per request; three windows reach 90 days out.
    for (let w = 0; w < 3; w++) {
      const min = new Date(now + w * 30 * DAY).toISOString();
      const max = new Date(now + (w + 1) * 30 * DAY).toISOString();
      let cursor = '';
      do {
        const q = new URLSearchParams({ location_id: locationId, customer_id: c.id,
          start_at_min: min, start_at_max: max, limit: '100' });
        if (cursor) q.set('cursor', cursor);
        const res = await square('/v2/bookings?' + q.toString());
        for (const b of res.bookings || []) {
          if (b.status !== 'ACCEPTED' && b.status !== 'PENDING') continue;
          if (new Date(b.start_at).getTime() <= now) continue;
          const segs = b.appointment_segments || [];
          out.push({
            id: b.id,
            raw: b,
            startAt: b.start_at,
            services: segs.map(s => s.service_variation_id),
            minutes: segs.reduce((n, s) => n + (s.duration_minutes || 0), 0),
          });
        }
        cursor = res.cursor || '';
      } while (cursor);
    }
  }
  const seen = new Set();
  const bookings = out.filter(b => !seen.has(b.id) && seen.add(b.id))
                      .sort((a, b) => a.startAt.localeCompare(b.startAt));
  // Mark anything paid ahead, including a payment whose client closed the
  // page before coming back to the site.
  let orders = null;
  for (const b of bookings) {
    b.paid = isPaid(b.raw);
    if (!b.paid) {
      try {
        orders = orders || await paidOrders();
        const o = orders.get(b.id);
        if (o) { await markPaid(b.raw, o); b.paid = true; }
      } catch { /* a lookup must not fail over this */ }
    }
    delete b.raw;
  }
  const who = mine[0];
  return { client: { firstName: who.given_name || '', lastName: who.family_name || '' }, bookings };
}

/* ---------- add to calendar --------------------------------------------- */

/**
 * The "Apple / Outlook" button in the booking emails. Returns the visit as a
 * calendar file. It carries only the time, the services and the shop's address,
 * never the client's name, because a booking id is all it takes to open it.
 */
async function icsFor(bookingId) {
  const booking = await getBooking(bookingId);
  const st = String(booking.status || '');
  if (st.startsWith('CANCELLED') || st === 'DECLINED') {
    throw Object.assign(new Error('That appointment was canceled'), { status: 400 });
  }
  const segs = booking.appointment_segments || [];
  const minutes = segs.reduce((a, x) => a + (Number(x.duration_minutes) || 0), 0) || 30;
  const start = new Date(booking.start_at);
  const end = new Date(start.getTime() + minutes * 60000);
  const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (t) => String(t).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  let names = [];
  try {
    const { objects = [] } = await square('/v2/catalog/batch-retrieve', {
      method: 'POST',
      body: { object_ids: segs.map(x => x.service_variation_id), include_related_objects: true },
    });
    names = objects.map(o => o.item_variation_data?.name).filter(Boolean);
  } catch { /* the times matter more than the names */ }
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Scissors by Sandy//Booking//EN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:' + booking.id + '@scissorsbysandy.com',
    'DTSTAMP:' + stamp(new Date()),
    'DTSTART:' + stamp(start),
    'DTEND:' + stamp(end),
    'SUMMARY:' + esc('Scissors by Sandy'),
    'LOCATION:' + esc('Scissors by Sandy, 3813 US-9, Suite 101, Old Bridge, NJ 08857'),
    'DESCRIPTION:' + esc([names.join(', '), 'Change or cancel: ' + SITE + '/book.html?find=1', '(848) 230-5995'].filter(Boolean).join('\n')),
    'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', 'DESCRIPTION:' + esc('Scissors by Sandy'), 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}

/* ---------- entry point -------------------------------------------------- */

export default async (request) => {
  if (!TOKEN) return json(500, { error: 'Booking is not configured yet' });

  try {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.searchParams.get('action') === 'ics') {
      const id = url.searchParams.get('id');
      if (!id) return json(400, { error: 'id is required' });
      return new Response(await icsFor(id), {
        status: 200,
        headers: {
          'content-type': 'text/calendar; charset=utf-8',
          'content-disposition': 'attachment; filename="scissors-by-sandy.ics"',
          'cache-control': 'no-store',
        },
      });
    }

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

      if (action === 'cardconfig') return json(200, await cardConfig());

      if (action === 'savecard') {
        const missing = need(['bookingId', 'phone', 'sourceId']);
        if (missing) return json(400, { error: missing });
        return json(200, { card: await saveCard(body) });
      }

      if (action === 'paylink') {
        const missing = need(['bookingId', 'phone']);
        if (missing) return json(400, { error: missing });
        return json(200, await payLink(body));
      }

      if (action === 'paid') {
        const missing = need(['bookingId']);
        if (missing) return json(400, { error: missing });
        return json(200, { paid: await checkPaid(String(body.bookingId)) });
      }

      if (action === 'find') {
        const missing = need(['phone', 'name']);
        if (missing) return json(400, { error: missing });
        return json(200, await findBookings(body));
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
