// Save a card on file from the booking page. Square's card form is replaced by
// a stand-in, so no card data is ever involved. Invented names.
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
const SOON=new Date(NOW+3*24*3600*1000).toISOString();
const CARD={id:'BK1',svcIds:['executive'],svcNames:['The Executive'],price:60,min:45,startISO:SOON};

const STUB = `window.Square={payments:function(appId,loc){window.__sq={appId:appId,loc:loc};
  return {card:async function(){return {
    attach:async function(sel){document.querySelector(sel).innerHTML='<div id="fakecard">[Square card fields]</div>'},
    tokenize:async function(o){window.__tok=o; return window.__tokFail?{status:'Invalid',errors:[{message:'Card number is not valid'}]}:{status:'OK',token:'cnon:TEST-TOKEN'}}
  }}}}};`;

const browser=await chromium.launch();
let failures=0;
const check=(l,c,d='')=>{ if(!c){failures++;console.log(`FAIL  ${l}`);if(d)console.log('        '+d)} else console.log(`PASS  ${l}`) };

async function session({saveFails=false, configFails=false, sdkFails=false, viewport}={}) {
  const ctx=await browser.newContext({timezoneId:'America/New_York', ...(viewport?{viewport,deviceScaleFactor:2}:{})});
  const page=await ctx.newPage(); await page.clock.setFixedTime(NOW);
  const seen=[]; const errs=[]; let sdkLoads=0;
  page.on('pageerror',e=>errs.push(e.message));
  await page.route('https://web.squarecdn.com/**', r=>{ sdkLoads++;
    return sdkFails ? r.abort() : r.fulfill({status:200,contentType:'text/javascript',body:STUB}) });
  await page.route('**/api/square*', async route=>{
    const req=route.request();
    const J=(status,o)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(o)});
    if(req.method()==='GET') return J(200,{slots:[]});
    const body=JSON.parse(req.postData()||'{}'); seen.push(body);
    if(body.action==='cardconfig') return configFails ? J(400,{error:'Saving a card is not available right now'})
                                                      : J(200,{appId:'sq0idp-TEST',locationId:'LOC'});
    if(body.action==='savecard') return saveFails ? J(400,{error:'That card couldn’t be saved. Please check the details or try another card'})
                                                  : J(200,{card:{brand:'VISA',last4:'4242'}});
    return J(200,{});
  });
  await page.addInitScript(([c])=>{
    localStorage.setItem('sbs_bookings',JSON.stringify([c]));
    localStorage.setItem('sbs_client',JSON.stringify({fn:'Pat',ln:'Example',ph:'7325550101',em:''}));
  },[CARD]);
  await page.goto(PAGE); await page.waitForTimeout(400);
  return {page,seen,errs,ctx,sdk:()=>sdkLoads};
}
const saveBtn = (page) => page.locator('#upcoming button',{hasText:'Save a Card'});

/* ---- 1. the form loads only when asked, and saves ---- */
{
  const {page,seen,errs,ctx,sdk}=await session();
  check('Square’s script is not loaded until someone asks', sdk()===0);
  await saveBtn(page).click(); await page.waitForTimeout(500);
  check('tapping Save a Card opens the sheet with Square’s card fields',
        await page.locator('#cardSheet').isVisible() && await page.locator('#fakecard').isVisible());
  check('Square is started with the shop’s app and location',
        JSON.stringify(await page.evaluate(()=>window.__sq))==='{"appId":"sq0idp-TEST","loc":"LOC"}');
  check('it says nothing is charged now', /Nothing is charged now/.test(await page.locator('#cardSheet').innerText()));
  await page.click('#cardSave'); await page.waitForTimeout(200);
  check('it will not save without the authorization ticked',
        /tick the box/.test(await page.locator('#cardErr').innerText()) && !seen.some(s=>s.action==='savecard'));
  await page.check('#cardAgree'); await page.click('#cardSave'); await page.waitForTimeout(500);
  const tok=await page.evaluate(()=>window.__tok);
  check('the card is tokenized to STORE, by the client', tok?.intent==='STORE' && tok?.customerInitiated===true && tok?.sellerKeyedIn===false, JSON.stringify(tok));
  const req=seen.find(s=>s.action==='savecard');
  check('only Square’s token goes to the server, with the booking and phone',
        req?.sourceId==='cnon:TEST-TOKEN' && req?.bookingId==='BK1' && req?.phone==='7325550101' &&
        Object.keys(req).sort().join(',')==='action,bookingId,phone,sourceId', JSON.stringify(req));
  check('the sheet closes', !(await page.locator('#cardSheet').isVisible()));
  const txt=await page.locator('#upcoming').innerText();
  check('the visit shows the saved card', /Visa ending 4242 saved for checkout/.test(txt), txt);
  check('and stops offering Save a Card', !(await saveBtn(page).count()));
  check('no page errors', errs.length===0, errs.join(' | '));
  await ctx.close();
}

/* ---- 2. failures say plainly nothing was saved ---- */
{
  const {page,ctx}=await session({saveFails:true});
  await saveBtn(page).click(); await page.waitForTimeout(500);
  await page.check('#cardAgree'); await page.click('#cardSave'); await page.waitForTimeout(400);
  const err=await page.locator('#cardErr').innerText();
  check('a refused card says nothing was saved', /couldn.t be saved/.test(err) && /Nothing was saved/.test(err), err);
  check('the sheet stays open to try again', await page.locator('#cardSheet').isVisible() && await page.locator('#cardSave').isEnabled());
  await page.click('.sheet-cancel'); await page.waitForTimeout(150);
  check('Not now closes it', !(await page.locator('#cardSheet').isVisible()));
  await ctx.close();
}
{
  const {page,ctx}=await session();
  await saveBtn(page).click(); await page.waitForTimeout(500);
  await page.evaluate(()=>{window.__tokFail=true});
  await page.check('#cardAgree'); await page.click('#cardSave'); await page.waitForTimeout(300);
  check('a mistyped card is caught by Square before anything is sent', /not valid/.test(await page.locator('#cardErr').innerText()));
  await ctx.close();
}
{
  const {page,ctx}=await session({sdkFails:true});
  await saveBtn(page).click(); await page.waitForTimeout(600);
  const err=await page.locator('#cardErr').innerText();
  check('if Square’s form cannot load, it says so and they can pay at the visit', /did not load/.test(err) && /pay at your visit/.test(err), err);
  check('and the Save button is disabled', await page.locator('#cardSave').isDisabled());
  await ctx.close();
}

/* ---- 3. phone layout ---- */
{
  const {page,ctx}=await session({viewport:{width:390,height:844}});
  if (process.env.SBS_SHOTS) await page.screenshot({path: process.env.SBS_SHOTS + '/cof-card.png'});
  await saveBtn(page).click(); await page.waitForTimeout(500);
  const over=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
  check('nothing runs off the side on a phone', !over);
  if (process.env.SBS_SHOTS) await page.screenshot({path: process.env.SBS_SHOTS + '/cof-sheet.png'});
  await ctx.close();
}

await browser.close(); server.close();
console.log(failures?`\n${failures} check(s) failed`:'\nAll card-on-file page checks passed');
process.exit(failures?1:0);
