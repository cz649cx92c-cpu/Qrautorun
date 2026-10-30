import {test} from '@playwright/test';
test('debug harness',async({page})=>{
 const errs:string[]=[];
 page.on('pageerror',e=>errs.push('pageerror: '+e.message));
 page.on('console',m=>errs.push('console['+m.type()+']: '+m.text()));
 const res=await page.goto('/tests/browser/canvas-modes/index.html');
 await page.waitForTimeout(2500);
 const html=await page.evaluate(()=>document.body.innerHTML.slice(0,600));
 console.log('STATUS',res?.status());
 console.log('HTML',html);
 console.log('LOGS',JSON.stringify(errs,null,1));
});
