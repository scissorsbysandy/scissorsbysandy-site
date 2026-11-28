// Two things a client must never discover the hard way:
//  1. A phone set to another time zone must still show the shop's times, and
//     book the instant the client picked.
//  2. A time taken between choosing and confirming must send them back to the
//     calendar, not leave them believing they are booked. A retried confirm
//     must reuse the same key so Square cannot make a second appointment.
let pwmod;
for (const spec of ['playwright', '/opt/npm-tools/node_modules/playwright/index.js']) {
  try { pwmod = await import(spec); break } catch (e) {}
}
if (!pwmod) { console.log('SKIP  playwright is not installed here'); process.exit(0) }
const { chromium } = pwmod.default ?? pwmod;
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const server = http.createServer((req, res) => { const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('no') } res.writeHead(200, { 'content-type': 'text/html' }); res.end(d) }) });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${server.address().port}/book.html?service=executive`;

// Frozen mid-month so the test never depends on today. Tue 16 Feb 2027,
// 10:00 AM and 2:30 PM in New Jersey.
const NOW = new Date('2027-02-10T12:00:00-05:00').getTime();
const SLOTS = ['2027-02-16T15:00:00Z', '2027-02-16T19:30:00Z'];

const browser = await chromium.launch();
let bad = 0;
const check = (l, c, d = '') => { if (!c) { bad++; console.log(`FAIL  ${l}`); if (d) console.log('        ' + d) } else console.log(`PASS  ${l}`) };

async function session(tz, onPost) {
  const ctx = await browser.newContext({ timezoneId: tz });
  const page = await ctx.newPage(); await page.clock.setFixedTime(NOW);
  const posts = [], gets = [], errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.route('**/api/square*', async route => {
    const req = route.request();
    if (req.method() === 'GET') { gets.push(req.url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ slots: SLOTS }) }) }
    const body = JSON.parse(req.postData() || '{}'); posts.push(body);
    return onPost(route, body, posts.length);
  });
  await page.goto(PAGE); await page.waitForTimeout(700);
  return { ctx, page, posts, gets, errs };
}
async function pickFirstSlotAndConfirm(page) {
  await page.locator('button.day:not([disabled])').first().click(); await page.waitForTimeout(250);
  await page.locator('.slot').first().click(); await page.waitForTimeout(150);
  await page.locator('#toS3').click(); await page.waitForTimeout(250);
  await page.locator('#fn').fill('Pat'); await page.locator('#ln').fill('Example');
  await page.locator('#ph').fill('7325550142'); await page.waitForTimeout(120);
  await page.locator('#confirmBtn').click(); await page.waitForTimeout(600);
}
const ok = (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"booking":{"id":"BK","status":"ACCEPTED"}}' });

/* ---- 1. a phone in California sees and books New Jersey time ---- */
for (const tz of ['America/Los_Angeles', 'Europe/London', 'America/New_York']) {
  const s = await session(tz, ok);
  const day = await s.page.locator('button.day:not([disabled])').allInnerTexts();
  check(`${tz}: only the 16th is offered`, day.join() === '16', day.join());
  await s.page.locator('button.day:not([disabled])').first().click(); await s.page.waitForTimeout(250);
  const times = await s.page.locator('.slot').allInnerTexts();
  check(`${tz}: times are shown in shop time`, times.join('|') === '10:00 AM|2:30 PM', times.join('|'));
  await s.page.locator('.slot').first().click(); await s.page.waitForTimeout(150);
  await s.page.locator('#toS3').click(); await s.page.waitForTimeout(250);
  await s.page.locator('#fn').fill('Pat'); await s.page.locator('#ln').fill('Example'); await s.page.locator('#ph').fill('7325550142'); await s.page.waitForTimeout(120);
  await s.page.locator('#confirmBtn').click(); await s.page.waitForTimeout(600);
  const at = s.posts[0]?.startAt;
  check(`${tz}: the booking is for 10:00 AM in New Jersey`, Date.parse(at) === Date.parse(SLOTS[0]), at);
  const conf = await s.page.locator('#confLine').innerText().catch(() => '');
  check(`${tz}: the confirmation says 10:00 AM`, /10:00 AM/.test(conf), conf);
  const stored = await s.page.evaluate(() => JSON.parse(localStorage.getItem('sbs_bookings') || '[]'));
  check(`${tz}: the saved appointment keeps the right instant`, Date.parse(stored[0]?.startISO) === Date.parse(SLOTS[0]));
  await s.page.goto(PAGE.replace('?service=executive', '')); await s.page.waitForTimeout(500);
  const up = await s.page.locator('#upcoming').innerText().catch(() => '');
  check(`${tz}: "your appointments" lists it at 10:00 AM`, /10:00/.test(up) && !/7:00|3:00 PM/.test(up), up.slice(0, 120));
  check(`${tz}: no page errors`, s.errs.length === 0, s.errs.join('; '));
  await s.ctx.close();
}

/* ---- 2. the time is taken while they were typing ---- */
{
  const s = await session('America/New_York', (route) =>
    route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"Sorry, that time was just taken"}' }));
  const getsBefore = s.gets.length;
  await pickFirstSlotAndConfirm(s.page);
  check('a taken time sends them back to the calendar', await s.page.locator('#s2').isVisible());
  const note = await s.page.locator('#slotsNote').innerText().catch(() => '');
  check('and says plainly that it was taken', /just taken/i.test(note) && /choose another/i.test(note), note);
  check('and fetches fresh times', s.gets.length > getsBefore);
  check('nothing is saved as booked', (await s.page.evaluate(() => JSON.parse(localStorage.getItem('sbs_bookings') || '[]'))).length === 0);
  check('no confirmation screen', !(await s.page.locator('#s4').isVisible()));
  await s.page.locator('button.day:not([disabled])').first().click(); await s.page.waitForTimeout(250);
  await s.page.locator('.slot').nth(1).click(); await s.page.waitForTimeout(150);
  check('choosing another time clears the note', !(await s.page.locator('#slotsNote').isVisible()));
  check('no page errors', s.errs.length === 0, s.errs.join('; '));
  await s.ctx.close();
}

/* ---- 3. a dropped connection, then Confirm again: same key ---- */
{
  const s = await session('America/New_York', (route, body, n) =>
    n === 1 ? route.abort('connectionreset') : ok(route));
  await pickFirstSlotAndConfirm(s.page);
  const err = await s.page.locator('#confErr').innerText();
  check('a dropped connection says nothing was booked', /Nothing has been booked/i.test(err), err);
  await s.page.locator('#confirmBtn').click(); await s.page.waitForTimeout(600);
  const [a, b] = s.posts;
  check('each attempt carries an idempotency key', !!a?.idempotencyKey && !!b?.idempotencyKey);
  check('the retry reuses the same key', a?.idempotencyKey === b?.idempotencyKey, `${a?.idempotencyKey} / ${b?.idempotencyKey}`);
  check('the retry books', await s.page.locator('#s4').isVisible());
  await s.ctx.close();
}

/* ---- 4. with JavaScript off, the page still tells them how to book ---- */
{
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage(); await page.goto(PAGE);
  const t = await page.locator('body').innerText();
  check('with JavaScript off, the phone number is on the page', /\(848\) 230-5995/.test(t));
  await ctx.close();
}

await browser.close(); server.close();
console.log(bad ? `\n${bad} check(s) failed` : '\nall checks pass');
process.exit(bad ? 1 : 0);
