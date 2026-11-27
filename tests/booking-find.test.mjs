// "Find my appointment" on the booking page: a client with no bookings saved in
// this browser looks theirs up by number and name, then moves or cancels it.
// Names and numbers are invented.
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

const NOW=new Date('2027-02-10T12:00:00-05:00').getTime();
const H=3600*1000;
const SOON=new Date(NOW+3*24*H).toISOString();          // Feb 13, a cut and a beard
const LATE=new Date(NOW+30*60*1000).toISOString();       // 30 minutes away: inside the cutoff
const pad=n=>String(n).padStart(2,'0');
const t=new Date(NOW+6*24*H);
const DATE=`${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}`;
const SLOTS=[`${DATE}T15:00:00-05:00`];

const browser=await chromium.launch();
let failures=0;
const check=(l,c,d='')=>{ if(!c){failures++;console.log(`FAIL  ${l}`);if(d)console.log('        '+d)} else console.log(`PASS  ${l}`) };

async function session({found=[], saved=null, findFails=false}={}) {
  const ctx=await browser.newContext({timezoneId:'America/New_York'});
  const page=await ctx.newPage(); await page.clock.setFixedTime(NOW);
  const seen=[]; const errs=[];
  page.on('pageerror',e=>errs.push(e.message));
  await page.route('**/api/square*', async route=>{
    const req=route.request();
    const J=(status,o)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(o)});
    if(req.method()==='GET') return J(200,{slots:SLOTS});
    const body=JSON.parse(req.postData()||'{}'); seen.push(body);
    if(body.action==='find'){
      if(findFails) return J(502,{error:'Could not reach the booking calendar'});
      return J(200,{client: found.length?{firstName:'Pat',lastName:'Example'}:null, bookings:found});
    }
    if(body.action==='cancel') return J(200,{booking:{id:body.bookingId,status:'CANCELLED_BY_CUSTOMER'}});
    if(body.action==='reschedule') return J(200,{booking:{id:body.bookingId,status:'ACCEPTED',startAt:body.startAt}});
    return J(200,{booking:{id:'BK_NEW',status:'ACCEPTED'}});
  });
  if(saved) await page.addInitScript(s=>localStorage.setItem('sbs_client',JSON.stringify(s)),saved);
  await page.goto(PAGE); await page.waitForTimeout(300);
  return {page,seen,errs,ctx};
}
const BOOKED=[{id:'BK_OLD',startAt:SOON,minutes:60,
               services:['G4JZOME4BD7FALXANU2OTDGK','WDS26BGIDDD5D4E7MZTWYVYX']}];

/* ---- 1. the link is there and the form opens ---- */
{
  const {page,errs,ctx}=await session();
  check('the "find it" link shows with no saved bookings', await page.locator('#findToggle').isVisible());
  check('the form starts closed', !(await page.locator('#findForm').isVisible()));
  await page.click('#findToggle');
  check('tapping it opens the form', await page.locator('#findForm').isVisible());
  check('no page errors', errs.length===0, errs.join(' | '));
  await ctx.close();
}

/* ---- 2. found: card appears, cancel works ---- */
{
  const {page,seen,errs,ctx}=await session({found:BOOKED});
  await page.click('#findToggle');
  await page.fill('#fph','(732) 555-0101'); await page.fill('#fnm','Pat Example');
  await page.click('#findBtn'); await page.waitForTimeout(500);
  const req=seen.find(s=>s.action==='find');
  check('the lookup sends number and name', req?.phone==='(732) 555-0101' && req?.name==='Pat Example');
  const txt=await page.locator('#upcoming').innerText();
  check('the appointment appears in Your Upcoming Appointment', /The Executive and The Statesman Beard Shaping/.test(txt), txt);
  check('with its day', /Saturday, February 13/.test(txt), txt);
  check('the form closes after a find', !(await page.locator('#findForm').isVisible()));
  const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('sbs_bookings')||'[]'));
  check('it is remembered on this phone', stored.some(b=>b.id==='BK_OLD'));
  await page.locator('#upcoming button.danger').first().click(); await page.waitForTimeout(100);
  await page.locator('#upcoming button.danger').first().click(); await page.waitForTimeout(400);
  const c=seen.find(s=>s.action==='cancel');
  check('Cancel uses the number they just typed', c?.bookingId==='BK_OLD' && c?.phone==='(732) 555-0101', JSON.stringify(c));
  check('and the card goes away', !(await page.locator('#upcoming').isVisible()));
  check('no page errors', errs.length===0, errs.join(' | '));
  await ctx.close();
}

/* ---- 3. found: reschedule moves that booking ---- */
{
  const {page,seen,ctx}=await session({found:BOOKED});
  await page.click('#findToggle');
  await page.fill('#fph','7325550101'); await page.fill('#fnm','Pat');
  await page.click('#findBtn'); await page.waitForTimeout(500);
  await page.locator('#upcoming button', {hasText:'Reschedule'}).click(); await page.waitForTimeout(500);
  await page.locator('button.day:not([disabled])').first().click(); await page.waitForTimeout(400);
  await page.locator('.slot').first().click(); await page.waitForTimeout(200);
  const cont=page.locator('#s2 button.btn-gold'); if(await cont.isVisible()) await cont.click();
  await page.waitForTimeout(300);
  await page.click('#confirmBtn'); await page.waitForTimeout(500);
  const r=seen.find(s=>s.action==='reschedule');
  check('Reschedule moves the found booking (no second booking)',
        r?.bookingId==='BK_OLD' && !seen.some(s=>!s.action), JSON.stringify(seen.map(s=>s.action||'book')));
  check('with the same services', JSON.stringify(r?.services)==='["G4JZOME4BD7FALXANU2OTDGK","WDS26BGIDDD5D4E7MZTWYVYX"]', JSON.stringify(r?.services));
  await ctx.close();
}

/* ---- 4. within the cutoff: call or text instead ---- */
{
  const {page,ctx}=await session({found:[{id:'BK_LATE',startAt:LATE,minutes:45,services:['G4JZOME4BD7FALXANU2OTDGK']}]});
  await page.click('#findToggle');
  await page.fill('#fph','7325550101'); await page.fill('#fnm','Pat');
  await page.click('#findBtn'); await page.waitForTimeout(500);
  const txt=await page.locator('#upcoming').innerText();
  check('inside the 1-hour cutoff it says to call or text', /call or text Sandy/.test(txt) && !/Reschedule/.test(txt), txt);
  await ctx.close();
}

/* ---- 5. nothing found, errors, bad input ---- */
{
  const {page,seen,ctx}=await session();
  await page.click('#findToggle');
  await page.fill('#fph','555'); await page.fill('#fnm','Pat');
  await page.click('#findBtn'); await page.waitForTimeout(200);
  check('a short number is caught on the page', /mobile number/.test(await page.locator('#findMsg').innerText()) && !seen.length);
  await page.fill('#fph','7325550101'); await page.fill('#fnm','');
  await page.click('#findBtn'); await page.waitForTimeout(200);
  check('a missing name is caught on the page', /your name/.test(await page.locator('#findMsg').innerText()) && !seen.length);
  await page.fill('#fnm','Pat');
  await page.click('#findBtn'); await page.waitForTimeout(400);
  const msg=await page.locator('#findMsg').innerText();
  check('not found says so and gives the number', /couldn.t find/.test(msg) && /230-5995/.test(msg), msg);
  check('and shows no appointment', !(await page.locator('#upcoming').isVisible()));
  await ctx.close();
}
{
  const {page,ctx}=await session({findFails:true});
  await page.click('#findToggle');
  await page.fill('#fph','7325550101'); await page.fill('#fnm','Pat');
  await page.click('#findBtn'); await page.waitForTimeout(400);
  const msg=await page.locator('#findMsg').innerText();
  check('a failed lookup says so plainly', /Could not reach/.test(msg) && /230-5995/.test(msg), msg);
  check('and the button works again', await page.locator('#findBtn').isEnabled());
  await ctx.close();
}

/* ---- 6. a returning client: details are filled in, email kept ---- */
{
  const {page,ctx}=await session({found:BOOKED, saved:{fn:'Pat',ln:'Example',ph:'7325550101',em:'pat@example.com'}});
  await page.click('#findToggle');
  check('saved number is filled in', (await page.inputValue('#fph'))==='7325550101');
  check('saved name is filled in', (await page.inputValue('#fnm'))==='Pat Example');
  await page.click('#findBtn'); await page.waitForTimeout(400);
  const me=await page.evaluate(()=>JSON.parse(localStorage.getItem('sbs_client')));
  check('the saved email is not lost', me.em==='pat@example.com', JSON.stringify(me));
  await ctx.close();
}

/* ---- 7. phone layout ---- */
{
  const ctx=await browser.newContext({timezoneId:'America/New_York', viewport:{width:390,height:844}, deviceScaleFactor:2});
  const page=await ctx.newPage(); await page.clock.setFixedTime(NOW);
  await page.goto(PAGE); await page.waitForTimeout(300);
  await page.click('#findToggle'); await page.waitForTimeout(150);
  const over=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
  check('nothing runs off the side on a phone', !over);
  if (process.env.SBS_SHOTS) await page.screenshot({path: process.env.SBS_SHOTS + '/find-open.png'});
  await ctx.close();
}

await browser.close(); server.close();
console.log(failures?`\n${failures} check(s) failed`:'\nAll find-my-appointment page checks passed');
process.exit(failures?1:0);
