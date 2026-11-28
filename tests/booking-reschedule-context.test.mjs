// Rescheduling must start from the appointment being moved: the page says which
// one, opens on its month and day, shows its current time, and words the last
// steps as a move. Backing out must leave nothing half-moved, so the next
// booking is a new booking and not a silent move of the old one.
// Names, numbers and ids are invented.
let pwmod;
for (const spec of ['playwright', '/opt/npm-tools/node_modules/playwright/index.js']) {
  try { pwmod = await import(spec); break } catch (e) {}
}
if (!pwmod) { console.log('SKIP  playwright is not installed here'); process.exit(0) }
const { chromium } = pwmod.default ?? pwmod;

import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const server=http.createServer((req,res)=>{const f=path.join(ROOT,decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);return res.end('no')}
  const ext=path.extname(f);res.writeHead(200,{'content-type':ext==='.html'?'text/html':ext==='.css'?'text/css':'text/javascript'});res.end(d)})});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const PAGE=`http://127.0.0.1:${server.address().port}/book.html`;

// Booked in late November for a visit just before Christmas: the calendar
// would open a month early unless the page starts from the appointment.
const NOW=new Date('2026-11-27T20:00:00-05:00').getTime();
const VISIT='2026-12-22T22:45:00.000Z';                       // Tue Dec 22, 5:45 PM in the shop
const DEC=['2026-12-22T15:00:00-05:00','2026-12-22T18:30:00-05:00','2026-12-23T11:00:00-05:00'];
const NOV=['2026-11-28T12:00:00-05:00'];
const BOOKED=[{id:'BK_MOVE',startAt:VISIT,minutes:40,services:['ERJFFGMXRX3B4SW6ZAKSN3X5']}];

const browser=await chromium.launch();
let failures=0;
const check=(l,c,d='')=>{ if(!c){failures++;console.log(`FAIL  ${l}`);if(d)console.log('        '+d)} else console.log(`PASS  ${l}`) };

async function session(tz='America/New_York'){
  const ctx=await browser.newContext({timezoneId:tz});
  const page=await ctx.newPage(); await page.clock.setFixedTime(NOW);
  const seen=[], gets=[], errs=[];
  page.on('pageerror',e=>errs.push(e.message));
  await page.route('**/api/square*', async route=>{
    const req=route.request();
    const J=(status,o)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(o)});
    if(req.method()==='GET'){
      const u=new URL(req.url()); const from=new Date(u.searchParams.get('from')), to=new Date(u.searchParams.get('to'));
      gets.push({from:u.searchParams.get('from')});
      const all=[...NOV,...DEC].filter(s=>{const t=new Date(s);return t>=from&&t<to});
      return J(200,{slots:all});
    }
    const body=JSON.parse(req.postData()||'{}'); seen.push(body);
    if(body.action==='find') return J(200,{client:{firstName:'Pat',lastName:'Example'},bookings:BOOKED});
    if(body.action==='reschedule') return J(200,{booking:{id:body.bookingId,status:'ACCEPTED',startAt:body.startAt}});
    return J(200,{booking:{id:'BK_NEW',status:'ACCEPTED'}});
  });
  await page.goto(PAGE); await page.waitForTimeout(300);
  await page.click('#findToggle');
  await page.fill('#fph','7325550101'); await page.fill('#fnm','Pat Example');
  await page.click('#findBtn'); await page.waitForTimeout(400);
  return {page,seen,gets,errs,ctx};
}
const startMove=async page=>{
  await page.locator('#upcoming button',{hasText:'Reschedule'}).click(); await page.waitForTimeout(500);
};

/* ---- 1. the page starts from the appointment being moved ---- */
{
  const {page,seen,gets,errs,ctx}=await session();
  await startMove(page);
  const banner=await page.locator('#moving').innerText().catch(()=>'');
  check('a banner says an appointment is being moved', await page.locator('#moving').isVisible() && /Moving your appointment/i.test(banner), banner);
  check('and names it: service, day and time', /The Signature, Tuesday, December 22 at 5:45 PM/.test(banner), banner);
  check('and says it stays booked until a new time is confirmed', /stays booked/.test(banner), banner);
  check('the calendar opens on December, the month of the visit',
        (await page.locator('#monLabel').textContent())==='December 2026', await page.locator('#monLabel').textContent());
  check('openings are asked for December, not November', gets.some(g=>g.from.startsWith('2026-12')), JSON.stringify(gets));
  check('the day of the visit is already selected', (await page.locator('button.day.sel').innerText().catch(()=>''))==='22');
  const slots=(await page.locator('#slots').innerText()).replace(/\s+/g,' ');
  check('that day shows the current time among the openings, in order',
        /3:00 PM 5:45 PM Current 6:30 PM/.test(slots), slots);
  check('the current time cannot be picked again', await page.locator('.slot.current').isDisabled());

  // choose a new time and finish the move
  await page.locator('.slot:not(.current)',{hasText:'6:30 PM'}).click();
  await page.click('#toS3'); await page.waitForTimeout(300);
  check('step 3 is worded as a move', (await page.locator('#s3head').textContent())==='Confirm Your New Time');
  check('moving does not ask for an email again', !(await page.locator('#em').isVisible()));
  check('and Move is ready without one', await page.locator('#confirmBtn').isEnabled());
  check('the button says Move, not Book', (await page.locator('#confirmBtn').textContent())==='Move My Appointment');
  const sum=(await page.locator('#sum').textContent()).replace(/\s+/g,' ');
  check('the summary shows the old time and the new one', /WasTue, Dec 22, 5:45 PM/.test(sum) && /New timeTue, Dec 22, 6:30/.test(sum), sum);
  check('the banner is still there on step 3', await page.locator('#moving').isVisible());
  await page.click('#confirmBtn'); await page.waitForTimeout(500);
  const r=seen.find(s=>s.action==='reschedule');
  check('it moves that booking', r?.bookingId==='BK_MOVE' && !seen.some(s=>!s.action), JSON.stringify(seen.map(s=>s.action||'book')));
  check('to the new time in shop time', r?.startAt===new Date('2026-12-22T18:30:00-05:00').toISOString(), r?.startAt);
  check('the done page says it moved', (await page.locator('#confHead').textContent())==='Your Appointment Is Moved');
  check('and promises an updated confirmation', /updated confirmation/.test(await page.locator('#confNote').innerText()));
  check('the banner is gone after the move', !(await page.locator('#moving').isVisible()));
  check('no page errors', errs.length===0, errs.join(' | '));
  await ctx.close();
}

/* ---- 2. backing out leaves nothing half-moved ---- */
{
  const {page,seen,errs,ctx}=await session();
  await startMove(page);
  await page.click('#s2back'); await page.waitForTimeout(300);
  check('going Back to services keeps saying what is being moved', await page.locator('#moving').isVisible());
  await page.locator('#moving button',{hasText:'Keep this time'}).click(); await page.waitForTimeout(300);
  check('Keep this time ends the move', !(await page.locator('#moving').isVisible()));
  check('and returns to the services', await page.locator('#s1').isVisible());
  // now book something new: it must be a new booking, not a move of BK_MOVE
  await page.locator('[id^="svc-"]').first().click(); await page.waitForTimeout(100);
  await page.locator('#pickBar button',{hasText:'Continue'}).click(); await page.waitForTimeout(500);
  check('a fresh booking opens on this month again', (await page.locator('#monLabel').textContent())==='November 2026', await page.locator('#monLabel').textContent());
  await page.locator('button.day:not([disabled])').first().click(); await page.waitForTimeout(200);
  await page.locator('.slot').first().click(); await page.click('#toS3'); await page.waitForTimeout(300);
  check('step 3 is worded as a booking again', (await page.locator('#confirmBtn').textContent())==='Confirm Booking');
  await page.fill('#fn','Pat'); await page.fill('#ln','Example'); await page.fill('#ph','7325550101');
  check('a new booking shows the email field', await page.locator('#em').isVisible());
  check('and cannot be confirmed without an email', await page.locator('#confirmBtn').isDisabled());
  await page.fill('#em','pat@');
  check('or with a half-typed one', await page.locator('#confirmBtn').isDisabled());
  await page.fill('#em','pat@example.com');
  check('a real email lets it through', await page.locator('#confirmBtn').isEnabled());
  await page.click('#confirmBtn'); await page.waitForTimeout(500);
  const posted=seen.filter(s=>s.action!=='find');
  check('the new visit is booked as new, the old one untouched',
        posted.length===1 && !posted[0].action && !posted.some(s=>s.action==='reschedule'), JSON.stringify(posted.map(s=>s.action||'book')));
  check('no page errors', errs.length===0, errs.join(' | '));
  await ctx.close();
}

/* ---- 3. a client away from home still sees the shop's time ---- */
{
  const {page,errs,ctx}=await session('America/Los_Angeles');
  await startMove(page);
  const banner=await page.locator('#moving').innerText();
  check('from California the banner still says 5:45 PM', /December 22 at 5:45 PM/.test(banner), banner);
  check('and the calendar still opens on December 22', (await page.locator('#monLabel').textContent())==='December 2026' &&
        (await page.locator('button.day.sel').innerText().catch(()=>''))==='22');
  check('no page errors', errs.length===0, errs.join(' | '));
  await ctx.close();
}

await browser.close(); server.close();
console.log(failures?`\n${failures} FAILED`:'\nall passed');
process.exit(failures?1:0);
