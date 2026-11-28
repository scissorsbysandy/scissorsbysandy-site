/**
 * The booking page's waitlist.
 *
 *   POST /api/waitlist {action:'join', date, services, window, firstName, lastName, phone, email, note}
 *        -> { ok, day }            on the list (the client and Sandy are emailed)
 *        -> 409 { error, open }    a time that suits them is open: book it instead
 *   POST /api/waitlist {action:'leave', day, id, token}
 *        -> { removed }            from the link in their email
 *
 * The logic lives in ../shared/waitlist.mjs. See there for how openings are found.
 *
 * Environment (Netlify):
 *   WAITLIST_MAIL_URL   the waitlist workflow's catch hook in Zapier
 *   WAITLIST_MAIL_KEY   shared secret the workflow checks before sending anything
 */
import { getStore } from '@netlify/blobs';
import { availability, phonesBooked, toE164 } from './square.mjs';
import { join, leave, sweep, makeMailer } from '../shared/waitlist.mjs';

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

/** Previews and tests get their own list, so trying things out never touches real clients. */
export function waitlistStore(context) {
  const live = context?.deploy?.context === 'production';
  return getStore({ name: live ? 'waitlist' : 'waitlist-preview', consistency: 'strong' });
}

/**
 * Emails go through the waitlist workflow in Zapier. On a preview, `site` makes
 * the links in them open the preview, and `testTo` sends every one of them to
 * Luis instead, marked [TEST]: a preview never emails a client or Sandy.
 */
export const mailer = ({ site, testTo } = {}) => makeMailer({
  url: process.env.WAITLIST_MAIL_URL,
  key: process.env.WAITLIST_MAIL_KEY,
  ...(site ? { site } : {}),
  ...(testTo ? { testTo } : {}),
});
const TEST_INBOX = 'luis.mordan@gmail.com';

export default async (request, context) => {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'Bad request' }); }
  // A hidden field people never see. Anything filling it in is a bot.
  if (body.website) return json(200, { ok: true });

  const store = waitlistStore(context);
  const live = context?.deploy?.context === 'production';
  const mail = live ? mailer() : mailer({ site: new URL(request.url).origin, testTo: TEST_INBOX });
  try {
    if (body.action === 'join') {
      const { entry, updated, waiting } = await join(body, { store, availability, toE164 });
      try {
        await mail({ kind: 'joined', entry, updated, waiting });
      } catch (err) { console.error('waitlist joined email failed:', err.message); }
      return json(200, { ok: true, day: entry.day, window: entry.window, updated });
    }
    if (body.action === 'leave') {
      const { removed } = await leave(body, { store });
      return json(200, { removed });
    }
    // For checking a preview by hand: look for openings now, on this deploy's
    // own list. Needs the same key the email workflow checks.
    if (body.action === 'sweep' && process.env.WAITLIST_MAIL_KEY && body.key === process.env.WAITLIST_MAIL_KEY) {
      return json(200, await sweep({ store, availability, phonesBooked, mail }));
    }
    return json(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('waitlist failed:', err.message);
    const status = [400, 409].includes(err.status) ? err.status : 502;
    return json(status, {
      error: status === 502 ? 'The waitlist is not answering just now. Please call or text Sandy at (848) 230-5995' : err.message,
      ...(err.open ? { open: err.open } : {}),
    });
  }
};

export const config = { path: '/api/waitlist' };
