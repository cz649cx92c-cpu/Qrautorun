import {test,expect} from '@playwright/test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

test('真实网页默认与2/3/4规格：抓预览请求、点击下载、渲染并验证中心可见性',async({page})=>{
 const folder=process.env.PDF_E2E_EVIDENCE_DIR??'logs/editor-ux-v3-pdf-e2e';mkdirSync(folder,{recursive:true});
 const address='http://127.0.0.1:4183';
 const requests:any[]=[],cases:any[]=[],violations:string[]=[];let scenario='default';
 await page.routeWebSocket('**/ws',socket=>socket.send(JSON.stringify({type:'robot',status:{connected:false,state:'OFFLINE',running:false,paused:false,conditions:[],events:[],sensors:{}}})));
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url());
  // Every API request goes to the isolated real HTTP server; production writes are impossible.
  const result=await route.fetch({url:address+url.pathname+url.search});
  const body=await result.body();
  requests.push({scenario,method:request.method(),path:url.pathname,query:Object.fromEntries(url.searchParams),payload:request.postData()?request.postDataJSON():null,status:result.status()});
  if(url.pathname==='/api/boards/preview.svg')writeFileSync(folder+'/'+scenario+'-preview.svg',body);
  await route.fulfill({response:result,body});
 });
 try{
  const indexResponse=await page.goto('/');expect(indexResponse?.status()).toBe(200);
  const indexBytes=await indexResponse!.body();expect(indexBytes.equals(readFileSync('web/frontend/dist/index.html'))).toBe(true);
  const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
  const assets=[{url:indexResponse!.url(),status:indexResponse!.status(),sha256:sha(indexBytes),byteMatch:true}];
  const assetUrls=await page.locator('script[src],link[rel="stylesheet"][href]').evaluateAll(nodes=>nodes.map(node=>node instanceof HTMLScriptElement?node.src:(node as HTMLLinkElement).href).filter(url=>new URL(url).pathname.startsWith('/assets/')));
  expect(assetUrls.length).toBeGreaterThanOrEqual(2);
  const loadedUrls=await page.evaluate(()=>performance.getEntriesByType('resource').map(entry=>entry.name));
  for(const url of assetUrls){
   expect(loadedUrls).toContain(url);
   const response=await page.request.get(url);expect(response.status()).toBe(200);
   const bytes=await response.body();expect(bytes.equals(readFileSync('web/frontend/dist'+new URL(url).pathname))).toBe(true);
   assets.push({url,status:response.status(),sha256:sha(bytes),byteMatch:true});
  }
  writeFileSync(folder+'/deployed-assets.json',JSON.stringify({assets,browserLoadedUrls:loadedUrls},null,2));
  await page.locator('.sidebar').getByRole('button',{name:'二维码 PDF',exact:true}).click();
  const image=page.locator('.board-preview img'),button=page.getByRole('button',{name:'生成并下载 PDF',exact:true});
  await expect(button).toBeEnabled();await expect(image).toBeVisible();
  const note=page.getByTestId('crosshair-note');
  await expect(note).toBeVisible();await expect(note).toContainText('全长 8 mm');
  const initial=await page.evaluate(()=>({localStorage:Object.fromEntries(Object.entries(localStorage)),inputs:[...document.querySelectorAll('.pdf-controls input')].map(node=>({type:(node as HTMLInputElement).type,value:(node as HTMLInputElement).value,checked:(node as HTMLInputElement).checked})),preview:(document.querySelector('.board-preview img') as HTMLImageElement)?.currentSrc}));
  writeFileSync(folder+'/default-fields.json',JSON.stringify(initial,null,2));
  const matrix=[{name:'default',grid:2,size:140,count:3},{name:'2x2-100',grid:2,size:100,count:1},{name:'2x2-180',grid:2,size:180,count:1},{name:'3x3-100',grid:3,size:100,count:1},{name:'3x3-180',grid:3,size:180,count:1},{name:'4x4-100',grid:4,size:100,count:1},{name:'4x4-180',grid:4,size:180,count:1}];
  for(const item of matrix){
   scenario=item.name;
   if(item.name!=='default'){
    await page.getByRole('button',{name:item.grid+' × '+item.grid,exact:true}).click();
    await page.getByLabel('整组尺寸 / mm',{exact:true}).fill(String(item.size));
    await page.getByLabel('生成组数',{exact:true}).fill(String(item.count));
    // Independent IDs avoid changing or bypassing registration protection.
    await page.getByLabel('起始子码编号',{exact:true}).fill(String(matrix.indexOf(item)*36));
   }
   await expect(button).toBeEnabled();
   await expect.poll(()=>requests.filter(request=>request.path==='/api/boards/plan').at(-1)?.payload?.groupSizeMm).toBe(item.size);
   await expect.poll(()=>image.evaluate(node=>(node as HTMLImageElement).complete&&(node as HTMLImageElement).naturalWidth>0)).toBe(true);
   const url=await image.getAttribute('src');expect(url).toContain('gridSize='+item.grid);expect(url).toContain('groupSizeMm='+item.size);expect(url).toContain('centerCrosshair=true');
   const svgResponse=await page.request.get(address+url!);const svg=await svgResponse.text();writeFileSync(folder+'/'+scenario+'-preview.svg',svg);
   const lines=[...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)];
   const span=lines.length?Number(lines[0]![3])-Number(lines[0]![1]):0;
   const downloadEvent=page.waitForEvent('download');await button.click();const download=await downloadEvent;await download.saveAs(folder+'/'+scenario+'.pdf');
   execFileSync('pdftoppm',['-png','-r','150','-f','1','-singlefile',folder+'/'+scenario+'.pdf',folder+'/'+scenario]);
   await page.screenshot({path:folder+'/'+scenario+'-browser.png',fullPage:true});await image.screenshot({path:folder+'/'+scenario+'-preview.png'});
   const payload=requests.filter(request=>request.path==='/api/boards/pdf').at(-1)?.payload;
   expect(payload).toMatchObject({gridSize:item.grid,groupSizeMm:item.size,groupCount:item.count,centerCrosshair:true});
   const imageSize=await image.boundingBox();const viewBox=svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!;
   const pxPerMm=Math.min(imageSize!.width/Number(viewBox[1]),imageSize!.height/Number(viewBox[2]));
   await expect(note).toBeVisible();
   if(item.grid%2===0)await expect(note).toContainText('全长 8 mm');
   else{
    await expect(note).toContainText('3×3 正中心是子码');
    await expect(note).toContainText('无法画中心十字');
    await expect(note).toContainText('请选择 2×2、4×4 或 6×6');
   }
   cases.push({...item,previewSrc:url,pdfRequest:payload,lineCount:lines.length,spanMm:span,displaySpanPx:span*pxPerMm,imageSize,noteText:await note.innerText()});
   if(item.grid%2===0){if(span<6||span*pxPerMm<12)violations.push(item.name+': center cross only '+span.toFixed(3)+'mm / '+(span*pxPerMm).toFixed(2)+' display px');expect(lines).toHaveLength(2);}
   else{expect(lines).toHaveLength(0);expect(svg).toContain('no-central-gap');await expect(page.getByTestId('crosshair-note')).toContainText('安全');}
  }
  scenario='false';await page.getByRole('checkbox',{name:'整组中心十字对位线',exact:true}).uncheck();await expect(button).toBeEnabled();
  const downloadEvent=page.waitForEvent('download');await button.click();const off=await downloadEvent;await off.saveAs(folder+'/false.pdf');
  expect(requests.filter(request=>request.path==='/api/boards/pdf').at(-1)?.payload?.centerCrosshair).toBe(false);expect(await image.getAttribute('src')).toContain('centerCrosshair=false');
  const defaultSvg=await page.request.get(address+'/api/boards/preview.svg?gridSize=2&groupSizeMm=140&startId=0');expect(await defaultSvg.text()).toContain('data-center-crosshair="true"');
  writeFileSync(folder+'/requests.json',JSON.stringify(requests,null,2));writeFileSync(folder+'/visibility.json',JSON.stringify({initial,cases,violations},null,2));
  expect(violations,'真实默认及规格预览十字必须可清楚识别').toEqual([]);
 }finally{await page.unroute('**/api/**');}
});
