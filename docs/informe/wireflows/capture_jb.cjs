// Recaptura solo las pantallas de junta / accesos / edificios (wireflows 5, 6 y mapa general) tras el rediseño.
const { chromium } = require('playwright')
const fs=require('fs')
const D='/tmp/claude-0/-home-user/4cc0f0f0-6a66-56c1-9b8f-6ac16a73be1c/scratchpad/wf/shots'
const APP='http://localhost:4173'
const MODE='desktop'
const metaPath=`${D}/meta_${MODE}.json`
const meta=JSON.parse(fs.readFileSync(metaPath,'utf8'))
async function snap(p,name,hl){
  let box=null
  if(hl){ const l=typeof hl==='string'?p.locator(hl).first():hl; await l.scrollIntoViewIfNeeded().catch(()=>{}); await p.waitForTimeout(250); box=await l.boundingBox() }
  await p.screenshot({path:`${D}/${MODE}_${name}.png`})
  meta[`${MODE}_${name}`]={box}
  console.log('snap',name, box?'hl':'NO-HL')
}
async function loginAdmin(p,user='test'){
  await p.goto(APP+'/login'); await p.fill('#login-email',user)
  await p.locator('form button[type=submit]').first().click()
  await p.waitForSelector('#login-password'); await p.fill('#login-password','123456')
  await p.locator('form button[type=submit]').first().click()
}
;(async()=>{
  const b=await chromium.launch()
  const opts={viewport:{width:1440,height:900},locale:'es-PE'}
  // ---------- W5 Junta directiva
  let ctx=await b.newContext(opts); let p=await ctx.newPage()
  await loginAdmin(p); await p.waitForURL(/\/app$/); await p.waitForTimeout(1500)
  await p.goto(APP+'/app/access'); await p.waitForTimeout(1500)
  await p.click('button.ws-btn--primary:has-text("Invitar")'); await p.waitForTimeout(500)
  await p.click('label.acc-role:has-text("Junta directiva")')
  await p.fill('#member-email','presidencia@demo.test'); await p.fill('#member-name','Rosa Medina')
  await snap(p,'w5_1','.p-dialog button[type=submit]')
  await p.click('.p-dialog button[type=submit]'); await p.waitForSelector('.acc-link input'); await p.waitForTimeout(700)
  const link=await p.locator('.acc-link input').inputValue()
  await snap(p,'w5_2','.acc-link')
  await p.goto(link); await p.waitForTimeout(1800)
  await p.fill('#minv-password','123456')
  await snap(p,'w5_3','.minv__primary')
  await p.evaluate(()=>{localStorage.removeItem('buildingfex.session')})
  await loginAdmin(p,'junta'); await p.waitForURL(/board/); await p.waitForTimeout(1800)
  await snap(p,'w5_4','.ws-tag')
  await ctx.close()
  // ---------- W6 Cambio de edificio
  ctx=await b.newContext(opts); p=await ctx.newPage()
  await loginAdmin(p); await p.waitForURL(/\/app$/); await p.waitForTimeout(1800)
  await snap(p,'w6_1','#app-building-select')
  await p.goto(APP+'/app/buildings'); await p.waitForTimeout(1500)
  await snap(p,'w6_2','tr:not(.pf-row--active) .ws-chip')
  await p.locator('tr:not(.pf-row--active) .ws-chip').first().click(); await p.waitForLoadState('load'); await p.waitForTimeout(2000)
  await snap(p,'w6_3','#app-building-select')
  await p.goto(APP+'/app/buildings'); await p.waitForTimeout(1500)
  await p.click('button.ws-btn--primary:has-text("Agregar edificio")'); await p.waitForTimeout(500)
  await p.fill('#pf-name','Torre Mirador'); await p.fill('#pf-address','Av. del Ejército 900, Magdalena'); await p.fill('#pf-departments','60')
  await snap(p,'w6_4','.p-dialog button[type=submit]')
  await p.click('.p-dialog button[type=submit]'); await p.waitForTimeout(1800)
  await snap(p,'w6_5', p.locator('tr:has-text("Torre Mirador")'))
  await ctx.close()
  // ---------- Mapa general: solo las vistas rediseñadas
  ctx=await b.newContext(opts); p=await ctx.newPage()
  await loginAdmin(p); await p.waitForURL(/\/app$/); await p.waitForTimeout(1500)
  for (const r of ['access','buildings']) { await p.goto(APP+'/app/'+r); await p.waitForTimeout(1500); await snap(p,'ov_adm_'+r) }
  await p.evaluate(()=>{localStorage.removeItem('buildingfex.session')})
  await loginAdmin(p,'junta'); await p.waitForURL(/board/); await p.waitForTimeout(1500)
  for (const r of ['board','access','buildings']) { await p.goto(APP+'/app/'+r); await p.waitForTimeout(1500); await snap(p,'ov_brd_'+r) }
  await ctx.close()
  fs.writeFileSync(metaPath,JSON.stringify(meta,null,1))
  await b.close()
})().catch(e=>{console.error(e);process.exit(1)})
