// Booking is always one tap away: the hero leads with Book Online, every menu
// leads with Book, a bar keeps booking in reach on phones once the hero's
// buttons scroll away, and the done screen offers the calendar, directions and
// how to change it. Analytics counts only the real site.
let pwmod;
for (const spec of ['playwright', '/opt/npm-tools/node_modules/playwright/index.js']) {
  try { pwmod = await import(spec); break } catch (e) {}
}
if (!pwmod) { console.log('SKIP  playwright is not installed here'); process.exit(0) }
const { chromium, devices } = pwmod.default ?? pwmod;
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const T = { '.html': 'text/html', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]); let f = path.join(ROOT, u); if (u.endsWith('/')) f = path.join(f, 'index.html');
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('no') } res.writeHead(200, { 'content-type': T[path.extname(f)] || 'application/octet-stream' }); res.end(d) });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const U = `http://127.0.0.1:${server.address().port}`;
const PAGES = ['/', '/haircuts/', '/kids-haircuts/', '/hot-towel-shaves/', '/facials-and-treatments/', '/weddings/', '/gift-certificates/', '/404.html'];

const browser = await chromium.launch();
let failures = 0;
const check = (l, c, d = '') => { if (!c) { failures++; console.log(`FAIL  ${l}`); if (d) console.log('        ' + d) } else console.log(`PASS  ${l}`) };
const ctxFor = async (dev) => {
  const ctx = await browser.newContext(dev);
  await ctx.addInitScript(() => { try { localStorage.setItem('sbs.a2hs.done', '1') } catch (e) {} });
  return ctx;
};

/* ---- every page: Book leads the menu, and the bar is there ---- */
{
  const ctx = await ctxFor({ viewport: { width: 1280, height: 800 } });
  for (const p of PAGES) {
    const page = await ctx.newPage(); await page.goto(U + p);
    const first = await page.locator('nav ul li').first().locator('a');
    check(`${p}: the menu starts with Book`, (await first.textContent()).trim() === 'Book' && (await first.getAttribute('href')) === '/book.html');
    check(`${p}: the Book link is tracked like every booking link`, (await first.getAttribute('data-booksy')) !== null);
    check(`${p}: the phone booking bar is on the page`, await page.locator('#bookbar a.bookbar-go').count() === 1);
    check(`${p}: the bar is hidden on a desktop screen`, !(await page.locator('#bookbar').isVisible()));
    await page.close();
  }
  await ctx.close();
}

/* ---- the home page on a phone ---- */
for (const dev of ['iPhone SE', 'iPhone 13']) {
  const ctx = await ctxFor({ ...devices[dev] });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(U + '/'); await page.waitForTimeout(400);
  const btns = page.locator('.hero .cta-row .btn');
  check(`${dev}: the hero's first, gold button is Book Online`,
    (await btns.first().textContent()).trim() === 'Book Online' && /btn-gold/.test(await btns.first().getAttribute('class')));
  const r = await btns.first().boundingBox(); const vh = page.viewportSize().height;
  check(`${dev}: Book Online is fully on the first screen`, r && r.y >= 0 && r.y + r.height <= vh, JSON.stringify(r) + ' vh ' + vh);
  const navFont = await page.locator('nav ul a').nth(1).evaluate(a => parseFloat(getComputedStyle(a).fontSize));
  check(`${dev}: menu text is readable (11px or more)`, navFont >= 11, navFont + 'px');
  const tap = await page.locator('nav ul a').nth(1).boundingBox();
  check(`${dev}: menu links are thumb-sized (44px tall)`, tap.height >= 44, JSON.stringify(tap));
  check(`${dev}: the menu stays one row (fixed header height)`,
    await page.locator('nav ul').evaluate(u => { const t = [...u.children].map(li => li.getBoundingClientRect().top); return Math.max(...t) - Math.min(...t) < 2 }));
  check(`${dev}: the bar stays out of the way while the hero's buttons show`, !(await page.locator('#bookbar').evaluate(b => b.classList.contains('on'))));
  await page.evaluate(() => scrollTo(0, 2500)); await page.waitForTimeout(500);
  check(`${dev}: once they scroll away, the bar slides in`, await page.locator('#bookbar').evaluate(b => b.classList.contains('on')));
  const go = await page.locator('#bookbar .bookbar-go').boundingBox();
  check(`${dev}: its Book button is in view and thumb-sized`, go && go.y + go.height <= vh && go.height >= 44, JSON.stringify(go));
  check(`${dev}: Call and Text are beside it`,
    (await page.locator('#bookbar a[href^="tel:"]').count()) === 1 && (await page.locator('#bookbar a[href^="sms:"]').count()) === 1);
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(400);
  const lastLink = await page.locator('footer .page-links a').last().boundingBox();
  const bar = await page.locator('#bookbar').boundingBox();
  check(`${dev}: at the very bottom the bar covers none of the footer links`, lastLink.y + lastLink.height <= bar.y, `${JSON.stringify(lastLink)} vs ${JSON.stringify(bar)}`);
  check(`${dev}: no page errors`, errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ---- the done screen ---- */
{
  const ctx = await ctxFor({ ...devices['iPhone 13'], timezoneId: 'America/New_York' });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.clock.setFixedTime(new Date('2026-11-27T20:00:00-05:00').getTime());
  const SL = ['2026-12-01T10:00:00-05:00'];
  await page.route('**/api/square*', async r => {
    const q = r.request(); const J = o => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (q.method() === 'GET') { const u = new URL(q.url()); const f = new Date(u.searchParams.get('from')), t = new Date(u.searchParams.get('to')); return J({ slots: SL.filter(s => { const d = new Date(s); return d >= f && d < t }) }) }
    return J({ booking: { id: 'BK_DONE', status: 'ACCEPTED' } });
  });
  await page.goto(U + '/book.html'); await page.waitForTimeout(400);
  await page.locator('[id^="svc-"]').first().click();
  await page.locator('#pickBar button', { hasText: 'Continue' }).click(); await page.waitForTimeout(500);
  await page.click('#nextM'); await page.waitForTimeout(500);
  await page.locator('button.day:not([disabled])').first().click(); await page.locator('.slot').first().click();
  await page.click('#toS3');
  await page.fill('#fn', 'Pat'); await page.fill('#ln', 'Example'); await page.fill('#ph', '7325550101'); await page.fill('#em', 'pat@example.com');
  await page.click('#confirmBtn'); await page.waitForTimeout(600);
  const g = await page.locator('#confExtra a', { hasText: 'Google Calendar' }).getAttribute('href');
  check('done screen: Google Calendar link carries the right time', /dates=20261201T150000Z\/20261201T154500Z/.test(g || ''), g);
  check('done screen: and the shop address', /3813%20US-9/.test(g || ''));
  check('done screen: Apple / Outlook downloads this booking', (await page.locator('#confExtra a', { hasText: 'Apple / Outlook' }).getAttribute('href')) === '/api/square?action=ics&id=BK_DONE');
  check('done screen: directions', /google\.com\/maps/.test(await page.locator('#confExtra a', { hasText: 'Directions' }).getAttribute('href')));
  check('done screen: how to move or cancel', (await page.locator('#confExtra a', { hasText: 'Move or cancel online' }).getAttribute('href')) === '/book.html?find=1');
  check('done screen: no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ---- analytics: only the real site is counted ---- */
for (const f of ['index.html', 'book.html']) {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  check(`${f}: analytics is limited to scissorsbysandy.com`, /GA_LIVE\s*=\s*\/\(\^\|\\\.\)scissorsbysandy\\\.com\$\//.test(s) && /if \(GA_LIVE\) gtag\('config'/.test(s) && /started \|\| !GA_LIVE/.test(s));
}
check('book.html: a finished booking is recorded with its value', /'booking_complete'/.test(fs.readFileSync(path.join(ROOT, 'book.html'), 'utf8')));
{
  const ctx = await ctxFor({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage(); const asked = [];
  page.on('request', r => { if (/googletagmanager/.test(r.url())) asked.push(r.url()) });
  await page.route('**/googletagmanager.com/**', r => r.abort());
  await page.goto(U + '/'); await page.waitForTimeout(2500);
  check('a copy of the site on another address never loads analytics', asked.length === 0, asked.join(' '));
  await ctx.close();
}

await browser.close(); server.close();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
