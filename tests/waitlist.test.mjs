// The waitlist end to end against a pretend calendar, store and mailbox.
import { join, leave, removeBooked, sweep, shopDate, shopMinute, dayRange } from '../netlify/shared/waitlist.mjs';

let bad = 0;
const check = (l, c, d = '') => { if (!c) { bad++; console.log(`FAIL  ${l}`); if (d) console.log('        ' + String(d).slice(0, 300)); } else console.log(`PASS  ${l}`); };

/* An in-memory stand-in for Netlify Blobs, with the same conditional writes. */
function memoryStore() {
  const m = new Map(); let n = 0;
  return {
    m,
    async getWithMetadata(k) { return m.has(k) ? { data: JSON.parse(m.get(k).v), etag: m.get(k).e, metadata: {} } : null; },
    async setJSON(k, v, o = {}) {
      if (o.onlyIfNew && m.has(k)) return { modified: false };
      if (o.onlyIfMatch && (!m.has(k) || m.get(k).e !== o.onlyIfMatch)) return { modified: false };
      m.set(k, { v: JSON.stringify(v), e: 'e' + (++n) }); return { modified: true };
    },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { blobs: [...m.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) }; },
  };
}
const toE164 = (raw) => { const d = String(raw || '').replace(/\D/g, ''); return d.length === 10 ? '+1' + d : null; };

// Saturday 12 Dec 2026, shop time. 10:00 = 15:00Z in December.
const DAY = '2026-12-12';
const at = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return new Date(Date.UTC(2026, 11, 12, h + 5, m)).toISOString(); };
const NOW = Date.parse('2026-11-28T21:00:00Z');

let OPEN = {};                     // services signature -> [iso]
let calls = 0;
const availability = async (services) => { calls++; return [...(OPEN[services.join(',')] || [])]; };
let mails = [];
const mail = async (m) => { mails.push(m); };
const fresh = () => ({ store: memoryStore(), availability, toE164, now: NOW });

const MIKE = { action: 'join', date: DAY, services: ['CUT'], window: 'afternoon', firstName: 'Mike', lastName: 'Testman', phone: '(732) 555-0144', email: 'Mike@Example.com' };
const JO = { ...MIKE, firstName: 'Jo', lastName: 'Tester', phone: '732-555-0199', email: 'jo@example.com', window: 'any' };
const KID = { ...MIKE, firstName: 'Ava', lastName: 'Kid', phone: '7325550111', email: 'ava@example.com', services: ['CUT', 'SCALP'], window: 'morning' };

/* ---- shop time ---- */
check('shop minute of 2:30 PM', shopMinute(at('14:30')) === 870);
check('shop date at 11 PM Eastern is still that day', shopDate(Date.parse('2026-12-13T04:00:00Z')) === '2026-12-12');
const r = dayRange('2027-03-14');
check('daylight-saving day is 23 hours', Date.parse(r.to) - Date.parse(r.from) === 23 * 3600e3, JSON.stringify(r));

/* ---- joining ---- */
{
  const d = fresh();
  OPEN = { CUT: [at('10:00'), at('17:15')] };          // morning + evening open, afternoon full
  const { entry } = await join(MIKE, d);
  check('joins when nothing in their window is open', !!entry && entry.day === DAY);
  check('phone stored as +1', entry.phone === '+17325550144');
  check('email lower-cased', entry.email === 'mike@example.com');
  check('remembers what was already open', entry.seen.length === 2);
  check('has a removal token', /^[0-9a-f]{32}$/.test(entry.token));

  let err = null;
  try { await join({ ...MIKE, window: 'morning' }, d); } catch (e) { err = e; }
  check('refused when a time in their window is open', err?.status === 409 && err.open?.[0] === at('10:00'), err?.message);

  const again = await join({ ...MIKE, window: 'evening' === 'x' ? 'x' : 'afternoon', email: 'mike2@example.com' }, d);
  const list = (await d.store.getWithMetadata('d/' + DAY)).data;
  check('joining again updates, not duplicates', list.length === 1 && list[0].email === 'mike2@example.com' && again.entry.id === entry.id);

  for (const [label, patch, want] of [
    ['bad date', { date: '12/12/2026' }, 'choose a day'],
    ['past date', { date: '2026-11-01' }, 'already passed'],
    ['no email', { email: 'nope' }, 'email'],
    ['short phone', { phone: '555-0144' }, 'mobile'],
    ['no services', { services: [] }, 'services'],
    ['no last name', { lastName: ' ' }, 'name'],
  ]) {
    let e = null; try { await join({ ...MIKE, ...patch }, fresh()); } catch (x) { e = x; }
    check('rejects ' + label, e?.status === 400 && e.message.toLowerCase().includes(want), e?.message);
  }
  let far = null; try { await join({ ...MIKE, date: '2028-06-01' }, fresh()); } catch (x) { far = x; }
  check('rejects more than a year ahead', far?.status === 400, far?.message);
}

/* ---- a cancellation: everyone it suits hears at once ---- */
{
  const d = fresh();
  OPEN = { CUT: [], 'CUT,SCALP': [] };
  await join(MIKE, d); await join(JO, d); await join(KID, d);
  mails = []; calls = 0;
  let rep = await sweep({ ...d, mail });
  check('nothing new, nobody emailed', rep.notified.length === 0 && mails.length === 0, JSON.stringify(rep));
  check('one calendar lookup per distinct visit', calls === 2, calls);

  OPEN = { CUT: [at('14:30')], 'CUT,SCALP': [] };   // 2:30 PM cancelled
  mails = [];
  rep = await sweep({ ...d, mail });
  const to = mails.filter(m => m.kind === 'opening').map(m => m.entry.firstName).sort();
  check('afternoon + any-time clients both emailed', JSON.stringify(to) === '["Jo","Mike"]', JSON.stringify(to));
  check('morning-only client not emailed about 2:30', !to.includes('Ava'));
  check('email offers the new time', mails.find(m => m.entry?.firstName === 'Mike').times[0] === at('14:30'));
  const shop = mails.find(m => m.kind === 'notifiedShop');
  check('Sandy told how many were emailed', shop?.count === 2 && shop.times[0] === at('14:30'), JSON.stringify(shop));

  mails = [];
  await sweep({ ...d, mail });
  check('same opening never emailed twice', mails.length === 0, mails.length);

  OPEN = { CUT: [], 'CUT,SCALP': [] };                  // somebody booked 2:30
  await sweep({ ...d, mail });
  OPEN = { CUT: [at('14:30')], 'CUT,SCALP': [] };    // ...and cancelled again
  mails = [];
  await sweep({ ...d, mail });
  check('a time freed a second time is news again', mails.filter(m => m.kind === 'opening').length === 2);

  OPEN = { CUT: [at('14:30')], 'CUT,SCALP': [at('9:00')] };
  mails = [];
  await sweep({ ...d, mail });
  check('two-service visit hears when its whole visit fits', mails.some(m => m.kind === 'opening' && m.entry.firstName === 'Ava'));
}

/* ---- leaving, booking, and the past ---- */
{
  const d = fresh();
  OPEN = { CUT: [] };
  const { entry } = await join(MIKE, d); await join(JO, d);
  let out = await leave({ day: DAY, id: entry.id, token: 'wrong' }, d);
  check('wrong token removes nothing', out.removed === false);
  out = await leave({ day: DAY, id: entry.id, token: entry.token }, d);
  check('the email link removes them', out.removed === true && (await d.store.getWithMetadata('d/' + DAY)).data.length === 1);

  const n = await removeBooked({ day: DAY, phone: '+17325550199' }, d);
  check('booking that day takes them off', n === 1 && !(await d.store.getWithMetadata('d/' + DAY)));

  await join(MIKE, d);
  const later = Date.parse('2026-12-13T12:00:00Z');
  const rep = await sweep({ ...d, mail, now: later });
  check('past days are cleared away', rep.cleared === 1 && d.store.m.size === 0, JSON.stringify(rep));

  OPEN = { CUT: [at('9:00'), at('16:00')] };
  const e2 = fresh();
  await join({ ...MIKE, window: 'afternoon' }, { ...e2 });
  OPEN = { CUT: [at('9:00'), at('16:00'), at('12:00')] };
  mails = [];
  await sweep({ ...e2, mail, now: Date.parse('2026-12-12T17:30:00Z') });   // 12:30 PM that day
  check('a time already gone today is not offered', mails.length === 0, JSON.stringify(mails.map(m => m.times)));
}

/* ---- someone waiting books the day elsewhere ---- */
{
  const d = fresh();
  OPEN = { CUT: [] };
  const a = await join(MIKE, d); const j = await join(JO, d);
  check('joining counts who is waiting', a.waiting === 1 && j.waiting === 2, a.waiting + ',' + j.waiting);
  OPEN = { CUT: [at('14:30')] };
  mails = [];
  const rep = await sweep({ ...d, mail, phonesBooked: async () => new Set(['+17325550144']) });
  const to = mails.filter(m => m.kind === 'opening').map(m => m.entry.firstName);
  check('booked client comes off the list and is not emailed', JSON.stringify(to) === '["Jo"]' && rep.booked === 1, JSON.stringify({ to, rep }));
  check('...and stays off', (await d.store.getWithMetadata('d/' + DAY)).data.length === 1);
  mails = [];
  await sweep({ ...d, mail, phonesBooked: async () => { throw new Error('Square down'); } });
  check('a failed booking lookup changes nothing', (await d.store.getWithMetadata('d/' + DAY)).data.length === 1 && mails.length === 0);
}

/* ---- the mailer ---- */
{
  const sent = [];
  const { makeMailer } = await import('../netlify/shared/waitlist.mjs');
  const m = makeMailer({ url: 'https://hook.example/x', key: 'k1', site: 'https://deploy-preview-9--ubiquitous-paletas-bd6f10.netlify.app', testTo: 'luis.mordan@gmail.com',
    fetchImpl: async (u, o) => { sent.push(JSON.parse(o.body)); return { ok: true }; } });
  await m({ kind: 'joined', entry: { day: DAY } });
  check('mailer sends the key, the site and the test inbox', sent[0].sbs_key === 'k1' && sent[0].site.includes('deploy-preview') && sent[0].sbs_test_to === 'luis.mordan@gmail.com' && sent[0].kind === 'joined', JSON.stringify(sent[0]));
  const live = makeMailer({ url: 'https://hook.example/x', key: 'k1', fetchImpl: async (u, o) => { sent.push(JSON.parse(o.body)); return { ok: true }; } });
  await live({ kind: 'opening' });
  check('live mailer has no test inbox', !('sbs_test_to' in sent[1]) && sent[1].site === 'https://scissorsbysandy.com');
  const off = makeMailer({ url: '', key: '' });
  let threw = false; try { await off({ kind: 'x' }); } catch { threw = true; }
  check('unconfigured mailer does nothing, quietly', !threw);
}

/* ---- a write collision is retried, not lost ---- */
{
  const d = fresh();
  OPEN = { CUT: [] };
  const real = d.store.setJSON.bind(d.store);
  let once = true;
  d.store.setJSON = async (k, v, o) => {
    if (once && o.onlyIfNew) { once = false; await real(k, [{ id: 'x', phone: '+17320000000', day: DAY, services: ['CUT'], window: 'any', seen: [] }]); }
    return real(k, v, o);
  };
  await join(MIKE, d);
  const list = (await d.store.getWithMetadata('d/' + DAY)).data;
  check('two people joining at once both stay on', list.length === 2, JSON.stringify(list.map(e => e.id)));
}

console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
