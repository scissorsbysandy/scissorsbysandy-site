// The waitlist on the booking page: a day with nothing open stays tappable,
// joining sends the right request, and the email links (a time opened, take me
// off) land in the right place.
let pwmod;
for (const spec of ['playwright','/opt/npm-tools/node_modules/playwright/index.js']) {
  try { pwmod = await import(spec); break } catch(e){}
}
if(!pwmod){ console.log('SKIP  playwright is not installed here'); process.exit(0) }
const { chromium } = pwmod.default ?? pwmod;
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
const ROOT=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','site');
const server=http.createServer((req,res)=>{const f=path.join(ROOT,decodeURIComponent(req.url.split('?')[0].split('#')[0]));
  fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);return res.end('no')}
  res.writeHead(200,{'content-type':f.endsWith('.html')?'text/html':''});res.end(d)})});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const BASE=`http://127.0.0.1:${server.address().port}`;
const SHOTS=process.env.SHOTS||'';

// Wednesday 10 Feb 2027, noon. Thu 11th has times; Fri 12th has only a 10 AM;
// Sat 13th has nothing; Wed 17th is a closed day.
const NOW=new Date('2027-02-10T12:00:00-05:00').getTime();
const SLOTS=['2027-02-11T11:00:00-05:00','2027-02-11T15:00:00-05:00','2027-02-12T10:00:00-05:00'];

let bad=0; const check=(l,c,d='')=>{ if(!c){bad++;console.log(`FAIL  ${l}`);if(d)console.log('        '+String(d).slice(0,300))} else console.log(`PASS  ${l}`) };
const b=await chromium.launch();

async function open(url,{width=430,height=930,waitlist=null}={}){
  const page=await (await b.newContext({timezoneId:'America/New_York',viewport:{width,height}})).newPage();
  await page.clock.setFixedTime(NOW);
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  const posts=[];
  await page.route('**/api/square*', r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({slots:SLOTS})}));
  await page.route('**/api/waitlist', async r=>{
    const body=JSON.parse(r.request().postData()||'{}'); posts.push(body);
    const ans = waitlist ? waitlist(body) : {status:200,body:{ok:true,day:body.date||body.day,removed:true}};
    return r.fulfill({status:ans.status,contentType:'application/json',body:JSON.stringify(ans.body)});
  });
  await page.goto(BASE+url); await page.waitForTimeout(900);
  return {page,errs,posts};
}
const dayBtn=(page,n)=>page.locator('#grid button.day').filter({hasText:new RegExp('^'+n+'$')});

/* ---- a day with nothing open ---- */
{
  const {page,errs,posts}=await open('/book.html?service=executive');
  check('Saturday the 13th is shown as no openings', await dayBtn(page,13).evaluate(e=>e.classList.contains('full')&&!e.disabled));
  check('a closed Wednesday stays shut', await dayBtn(page,17).isDisabled());
  check('a day with times is an ordinary day', await dayBtn(page,11).evaluate(e=>!e.classList.contains('full')&&!e.disabled));
  check('the calendar explains the dashed days', await page.locator('#calKey').isVisible());
  await dayBtn(page,13).click(); await page.waitForTimeout(400);
  check('says nothing is open', (await page.locator('#slots').innerText()).includes('Nothing is open'));
  check('waitlist form opens straight away', await page.locator('#wlBox').isVisible());
  check('Any time is chosen', (await page.locator('#wlWin button.sel').innerText())==='Any time');
  check('evening offered: a 45-minute cut can still start at 4:15 on a Saturday', await page.locator('#wlWin button[data-w=evening]').count()===1);
  await page.evaluate(()=>{picked=[findSvc('sovereign')]; setDay(13)}); await page.waitForTimeout(200);
  check('no evening for a 90-minute visit on a 5 PM Saturday', await page.locator('#wlWin button[data-w=evening]').count()===0);
  await page.evaluate(()=>{picked=[findSvc('executive')]; setDay(13)}); await page.waitForTimeout(200);
  check('join is disabled until the form is filled', await page.locator('#wlBtn').isDisabled());
  await page.fill('#wfn','Mike'); await page.fill('#wln','Testman'); await page.fill('#wph','(732) 555-0144'); await page.fill('#wem','mike@example.com');
  check('join enables once filled', await page.locator('#wlBtn').isEnabled());
  if(SHOTS) await page.screenshot({path:SHOTS+'/wl-phone-form.png',fullPage:true});
  await page.locator('#wlBtn').click(); await page.waitForTimeout(500);
  const p=posts[0]||{};
  check('posts the join', p.action==='join' && p.date==='2027-02-13' && p.window==='any' && p.services?.[0]==='G4JZOME4BD7FALXANU2OTDGK' && p.phone==='(732) 555-0144', JSON.stringify(p));
  check('says they are on the list', (await page.locator('#wlDone').innerText()).includes('on the waitlist'));
  check('form is put away', !(await page.locator('#wlBox').isVisible()));
  if(SHOTS) await page.screenshot({path:SHOTS+'/wl-phone-done.png',fullPage:true});
  check('details remembered for next time', await page.evaluate(()=>JSON.parse(localStorage.getItem('sbs_client')).em)==='mike@example.com');
  check('no page errors', !errs.length, errs.join(' | '));
}

/* ---- a day with only a morning time ---- */
{
  const {page,posts}=await open('/book.html?service=executive',{waitlist:(body)=>({status:409,body:{error:'Good news',open:['2027-02-12T13:30:00-05:00']}})});
  await dayBtn(page,12).click(); await page.waitForTimeout(400);
  check('the 10 AM shows', (await page.locator('.slot').allInnerTexts()).join()==='10:00 AM');
  check('waitlist is offered under it, closed', await page.locator('#wlToggle').isVisible() && !(await page.locator('#wlBox').isVisible()));
  await page.locator('#wlToggle').click(); await page.waitForTimeout(300);
  check('any time and morning are crossed out', await page.locator('#wlWin button[data-w=any]').isDisabled() && await page.locator('#wlWin button[data-w=morning]').isDisabled());
  check('afternoon chosen first', (await page.locator('#wlWin button.sel').innerText())==='Afternoon');
  await page.locator('#wlWin button[data-w=evening]').click();
  check('evening can be chosen', (await page.locator('#wlWin button.sel').innerText())==='Evening');
  if(SHOTS) await page.screenshot({path:SHOTS+'/wl-phone-partial.png',fullPage:true});
  await page.fill('#wfn','Jo'); await page.fill('#wln','Tester'); await page.fill('#wph','7325550199'); await page.fill('#wem','jo@example.com');
  await page.locator('#wlBtn').click(); await page.waitForTimeout(600);
  check('a time that just opened is offered instead', (await page.locator('#wlMsg').innerText()).includes('1:30 PM'), await page.locator('#wlMsg').innerText());
  check('...and the request said evening', posts[0]?.window==='evening');
}

/* ---- the "a time opened" email link ---- */
{
  const {page,errs}=await open('/book.html?service=signature,scalp&date=2027-02-12&utm_source=sbs_email');
  const st=await page.evaluate(()=>({n:picked.length,ids:picked.map(s=>s.id).join(),day:day&&day.getDate(),step:!document.getElementById('s2').classList.contains('hidden')}));
  check('both services picked', st.n===2 && st.ids==='signature,scalp', JSON.stringify(st));
  check('opens on that day', st.step && st.day===12, JSON.stringify(st));
  check('its times are showing', await page.locator('.slot').count()===1);
  check('no page errors', !errs.length, errs.join(' | '));
}

/* ---- take me off ---- */
{
  const {page,posts}=await open('/book.html?leave=2027-02-13.abc123.def456');
  check('asks before removing', (await page.locator('#wlLeave').innerText()).includes('Saturday, February 13') && posts.length===0);
  if(SHOTS) await page.screenshot({path:SHOTS+'/wl-phone-leave.png'});
  await page.locator('#wlLeaveBtn').click(); await page.waitForTimeout(400);
  check('sends the removal', posts[0]?.action==='leave' && posts[0].day==='2027-02-13' && posts[0].id==='abc123' && posts[0].token==='def456', JSON.stringify(posts[0]));
  check('confirms it', (await page.locator('#wlLeave').innerText()).includes('off the waitlist'));
  const junk=await open('/book.html?leave=nope');
  check('a broken link shows nothing', !(await junk.page.locator('#wlLeave').isVisible()));
}

/* ---- desktop look ---- */
if(SHOTS){
  const {page}=await open('/book.html?service=executive',{width:1280,height:900});
  await dayBtn(page,13).click(); await page.waitForTimeout(400);
  await page.screenshot({path:SHOTS+'/wl-desktop.png',fullPage:true});
}

await b.close(); server.close();
console.log(bad?`\n${bad} FAILED`:'\nall passed');
process.exit(bad?1:0);
