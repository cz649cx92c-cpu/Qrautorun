// Read-only browser check: navigation-page selection only; no command requests.
import {existsSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(!process.env.PLAYWRIGHT_BROWSERS_PATH&&existsSync(resolve(root,'.browser-cache')))process.env.PLAYWRIGHT_BROWSERS_PATH=resolve(root,'.browser-cache');
const {chromium}=await import('playwright-core');
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1910,height:925}});
const errors=[],blocked=[];
page.on('pageerror',error=>errors.push({message:error.message,stack:error.stack}));
await page.route('**/api/**',async route=>{
 if(route.request().method()!=='GET'){blocked.push({method:route.request().method(),path:new URL(route.request().url()).pathname});return route.abort();}
 return route.continue();
});
try{
 await page.goto('http://127.0.0.1:3080/',{waitUntil:'domcontentloaded'});
 for(let i=0;i<3;i++){await page.locator('.nav-item').filter({hasText:'开始导航'}).click();await page.locator('.nav-item').filter({hasText:'扫描建图'}).click();}
 await page.locator('.nav-item').filter({hasText:'开始导航'}).click();
 const result=page.getByText('静止二维码定位',{exact:true});
 await result.first().waitFor({state:'visible',timeout:20000});
 await page.locator('[data-testid="map-pose-status"]').getByText('静止二维码定位',{exact:true}).waitFor({state:'visible',timeout:10000});
 await page.screenshot({path:resolve(root,'logs/static-qr-localization-page.png'),fullPage:true});
 const status=await page.evaluate(async()=>{const end=Date.now()+3000;let value;do{value=await (await fetch('/api/robot/status')).json();if(value.pose&&value.localization?.state==='STATIC_ANCHORED')return value;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<end);return value;});
 const evidence={readOnly:true,commandRequestsSent:0,blockedRequests:blocked,pageErrors:errors,pose:status.pose,localization:status.localization,sensors:status.sensors,navigationButtonDisabled:await page.locator('.left-panel').getByRole('button',{name:'开始导航',exact:true}).isDisabled(),visiblePanel:await page.locator('[data-testid="map-pose-status"]').textContent().catch(()=>null)};
 writeFileSync(resolve(root,'logs/static-qr-localization-page.json'),JSON.stringify(evidence,null,2)+'\n');
 if(errors.length||blocked.length||!status.pose||status.localization?.state!=='STATIC_ANCHORED'||status.localization?.navigationReady!==false||!evidence.navigationButtonDisabled)throw new Error('静止定位页面证据未通过');
 console.log(JSON.stringify(evidence));
}finally{await browser.close();}
