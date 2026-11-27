// Pay ahead on the booking page (optional, like Booksy Pay). Invented names.
let pwmod;
for (const spec of ['playwright', '/opt/npm-tools/node_modules/playwright/index.js']) {
  try { pwmod = await import(spec); break } catch (e) {}
}
if (!pwmod) { console.log('SKIP  playwright is not installed here'); process.exit(0) }
const { chromium } = pwmod.default ?? pwmod;

import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const server=http.createServer((req,res)=>{
  if(req.url.startsWith('/fake-square-checkout')){res.writeHead(200,{'content-type':'text/html'});return res.end('<h1>Square checkout</h1>')}
  const f=path.join(ROOT,decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);return res.end('no')}
  const ext=path.extname(f);res.writeHead(200,{'content-type':ext==='.html'?'text/html':ext==='.css'?'text/css':'text/javascript'});res.end(d)})});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const BASE=`http://127.0.0.1:${server.address().port}`;
const PAGE=`${BASE}/book.html`;

const NOW=new Date('2027-02-10T12:00:00-05:00').getTime();
const H=3600*1000;
const SOON=new Date(NOW+3*24*H).toISOString();
const pad=n=>String(n).padStart(2,'0');
const t=new Date(NOW+6*24*H);
const DATE=`${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}`;

const browser=await chromium.launch();
let failures=0;
const check=(l,c,d='')=>{ if(!c){failures++;console.log(`FAIL  ${l}`);if(d)console.log('        '+d)} else console.log(`PASS  ${l}`) };

async function session({saved=[], paidState=false, paidAfter=0, payFails=false, url=PAGE, viewport}={}) {
  let paidCalls=0;
  const ctx=await browser.newContext({timezoneId:'America/New_York', ...(viewport?{viewport,deviceScaleFactor:2}:{})});
  const page=await ctx.newPage(); await page.clock.setFixedTime(NOW);
  const seen=[]; const errs=[];
  page.on('pageerror',e=>errs.push(e.message));
  await page.route('**/api/square*', async route=>{
    const req=route.request();
    const J=(status,o)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(o)});
    if(req.method()==='GET') return J(200,{slots:[`${DATE}T15:00:00-05:00`]});
    const body=JSON.parse(req.postData()||'{}'); seen.push(body);
    if(body.action==='paylink') return payFails ? J(502,{error:'Could not reach the booking calendar'})
                                                : J(200,{url:BASE+'/fake-square-checkout'});
    if(body.action==='paid'){ paidCalls++; return J(200,{paid: paidState || (paidAfter>0 && paidCalls>=paidAfter)}); }
    return J(200,{booking:{id:'BK_NEW',status:'ACCEPTED'}});
  });
  await page.addInitScript(([s])=>{
    if(!sessionStorage.getItem('seeded')){
      localStorage.setItem('sbs_bookings',JSON.stringify(s));
      localStorage.setItem('sbs_client',JSON.stringify({fn:'Pat',ln:'Example',ph:'7325550101',em:''}));
      sessionStorage.setItem('seeded','1');
    }
  },[saved]);
  await page.goto(url); await page.waitForTimeout(400);
  return {page,seen,errs,ctx};
}
const CARD={id:'BK1',svcIds:['executive'],svcNames:['The Executive'],price:60,min:45,startISO:SOON};

/* ---- 1. the button on an upcoming visit opens Square's page in this tab ---- */
{
  const {page,seen,errs,ctx}=await session({saved:[CARD]});
  const btn=page.locator('#upcoming .up-pay',{hasText:'Pay Ahead'});
  check('an upcoming visit offers Pay Ahead, marked optional', await btn.isVisible() && /optional/i.test(await page.locator('#upcoming').innerText()));
  await btn.click(); await page.waitForTimeout(600);
  const req=seen.find(s=>s.action==='paylink');
  check('it asks for a link with the booking id and saved phone', req?.bookingId==='BK1' && req?.phone==='7325550101', JSON.stringify(req));
  check('the client goes to Square’s own checkout page (not an iframe)', page.url().endsWith('/fake-square-checkout'), page.url());
  check('no page errors', errs.length===0, errs.join(' | '));
  await ctx.close();
}

/* ---- 2. after booking, Pay Ahead Now is offered ---- */
{
  const {page,seen,ctx}=await session();
  await page.locator('.svc').first().click(); await page.waitForTimeout(150);
  await page.locator('#pickBar button').click(); await page.waitForTimeout(500);
  await page.locator('button.day:not([disabled])').first().click(); await page.waitForTimeout(300);
  await page.locator('.slot').first().click(); await page.waitForTimeout(200);
  const cont=page.locator('#s2 button.btn-gold'); if(await cont.isVisible()) await cont.click();
  await page.waitForTimeout(300);
  await page.click('#confirmBtn'); await page.waitForTimeout(500);
  check('the confirmation offers Pay Ahead Now', await page.locator('#payNow .btn-gold').isVisible());
  check('and says it is optional', /Optional/.test(await page.locator('#payNow').innerText()));
  await page.locator('#payNow .btn-gold').click(); await page.waitForTimeout(600);
  const req=seen.find(s=>s.action==='paylink');
  check('it pays for the booking just made', req?.bookingId==='BK_NEW', JSON.stringify(req));
  await ctx.close();
}

/* ---- 3. coming back from Square, paid ---- */
{
  const {page,seen,errs,ctx}=await session({saved:[CARD], paidState:true, url:PAGE+'?paid=BK1'});
  await page.waitForTimeout(400);
  check('the page checks the payment with the booking function', seen.some(s=>s.action==='paid' && s.bookingId==='BK1'));
  const txt=await page.locator('#upcoming').innerText();
  check('it thanks them', /all paid/.test(txt), txt);
  check('the visit shows Paid ahead', /Paid ahead/.test(txt));
  check('Pay Ahead is no longer offered', !(await page.locator('#upcoming button',{hasText:'Pay Ahead'}).count()));
  check('Cancel is replaced by call or text Sandy for a refund', !(await page.locator('#upcoming button.danger').count()) && /refund/.test(txt), txt);
  check('Reschedule is still there', await page.locator('#upcoming button', {hasText:'Reschedule'}).isVisible());
  check('the ?paid= is cleared from the address', !page.url().includes('paid='), page.url());
  check('no page errors', errs.length===0, errs.join(' | '));
  if (process.env.SBS_SHOTS) await page.screenshot({path: process.env.SBS_SHOTS + '/pay-paid.png'});
  await ctx.close();
}

/* ---- 4a. Square records the payment a few seconds after sending them back ---- */
{
  const {page,seen,ctx}=await session({saved:[CARD], paidAfter:3, url:PAGE+'?paid=BK1'});
  await page.waitForTimeout(7000);
  const txt=await page.locator('#upcoming').innerText();
  check('the page keeps checking and thanks them once Square catches up', /all paid/.test(txt) && seen.filter(s=>s.action==='paid').length===3, txt);
  await ctx.close();
}

/* ---- 4b. never recorded while they wait ---- */
{
  const {page,seen,ctx}=await session({saved:[CARD], paidState:false, url:PAGE+'?paid=BK1'});
  await page.waitForTimeout(400);
  check('it says nothing while it is still checking', !/being confirmed|all paid/.test(await page.locator('#upcoming').innerText()));
  await page.waitForTimeout(19500);
  const txt=await page.locator('#upcoming').innerText();
  check('it says the payment is being confirmed, not that it failed', /being confirmed/.test(txt) && !/fail/i.test(txt), txt);
  await ctx.close();
}

/* ---- 5. a link that cannot be made ---- */
{
  const {page,ctx}=await session({saved:[CARD], payFails:true});
  await page.locator('#upcoming .up-pay',{hasText:'Pay Ahead'}).click(); await page.waitForTimeout(500);
  const txt=await page.locator('#upcoming').innerText();
  check('a failure says nothing was charged and they can pay at the visit', /Nothing was charged/.test(txt) && /pay at your visit/.test(txt), txt);
  check('they stay on the page', page.url().startsWith(PAGE));
  await ctx.close();
}

/* ---- 6. phone layout ---- */
{
  const {page,ctx}=await session({saved:[CARD], viewport:{width:390,height:844}});
  const over=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
  check('nothing runs off the side on a phone', !over);
  if (process.env.SBS_SHOTS) await page.screenshot({path: process.env.SBS_SHOTS + '/pay-card.png'});
  await ctx.close();
}

await browser.close(); server.close();
console.log(failures?`\n${failures} check(s) failed`:'\nAll pay-ahead page checks passed');
process.exit(failures?1:0);
