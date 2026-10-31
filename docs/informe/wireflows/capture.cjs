const { chromium } = require('playwright')
const fs=require('fs')
const D='/tmp/claude-0/-home-user/4cc0f0f0-6a66-56c1-9b8f-6ac16a73be1c/scratchpad/wf/shots'
const APP='http://localhost:4173', LP='http://localhost:4174'
const meta={}
const MODE=process.argv[2]||'desktop'
const mobile=MODE==='mobile'
async function snap(p,name,hl){
  let box=null
  if(hl){ const l=typeof hl==='string'?p.locator(hl).first():hl; await l.scrollIntoViewIfNeeded().catch(()=>{}); await p.waitForTimeout(250); box=await l.boundingBox() }
  await p.screenshot({path:`${D}/${MODE}_${name}.png`})
  meta[`${MODE}_${name}`]={box}
  console.log('snap',name, box?'hl':'')
}
async function loginRes(p){
  await p.goto(APP+'/login/residente'); await p.waitForTimeout(500)
  await p.fill('#res-email','test'); await p.fill('#res-password','123456')
  return p.locator('#res-password')
}
async function loginAdmin(p,user='test'){
  await p.goto(APP+'/login'); await p.fill('#login-email',user)
  await p.locator('form button[type=submit]').first().click()
  await p.waitForSelector('#login-password'); await p.fill('#login-password','123456')
  await p.locator('form button[type=submit]').first().click()
}
;(async()=>{
  const b=await chromium.launch()
  const opts= mobile? {viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true,locale:'es-PE'} : {viewport:{width:1440,height:900},locale:'es-PE'}
  // ---------- W1 Pagar una cuota
  let ctx=await b.newContext(opts); let p=await ctx.newPage()
  await p.goto(LP+'/'); await p.waitForTimeout(1500)
  await snap(p,'w1_1', 'a:has-text("Ingresa aquí"), a:has-text("residente")')
  let pw=await loginRes(p); await snap(p,'w1_2','form button[type=submit], button:has-text("Ingresar")')
  await pw.press('Enter'); await p.waitForURL(/resident/); await p.waitForTimeout(1800)
  await snap(p,'w1_3','main a:has-text("Pagar cuota"), main button:has-text("Pagar cuota")')
  await p.locator('main a:has-text("Pagar cuota"), main button:has-text("Pagar cuota")').first().click(); await p.waitForTimeout(1500)
  await snap(p,'w1_4','button:has-text("Pagar con Mercado Pago")')
  await p.locator('button:has-text("Pagar con Mercado Pago")').first().click(); await p.waitForTimeout(1200)
  if(mobile) await p.evaluate(()=>window.scrollTo(0,0))
  await snap(p,'w1_5')
  await ctx.close()
  // ---------- W2 Reservar con invitado
  ctx=await b.newContext(opts); p=await ctx.newPage()
  pw=await loginRes(p); await pw.press('Enter'); await p.waitForURL(/resident/); await p.waitForTimeout(1800)
  await snap(p,'w2_1','main a:has-text("Reservar espacio"), main button:has-text("Reservar espacio")')
  await p.locator('main a:has-text("Reservar espacio"), main button:has-text("Reservar espacio")').first().click(); await p.waitForTimeout(1500)
  await snap(p,'w2_2','main button:text-is("Reservar")')
  await p.locator('main button:text-is("Reservar")').first().click(); await p.waitForTimeout(800)
  let dlg=p.locator('[role=dialog]').last()
  await dlg.locator('button:not([disabled])').filter({hasText:/^\d+$/}).nth(3).click(); await p.waitForTimeout(300)
  await p.fill('#reservation-start-time','16:00'); await p.fill('#reservation-end-time','18:00')
  await snap(p,'w2_3', dlg.locator('button[type=submit]'))
  await dlg.locator('button[type=submit]').click(); await p.waitForTimeout(1500)
  await snap(p,'w2_4', p.locator('[role=dialog] button:has-text("Agregar invitados")'))
  await p.locator('[role=dialog] button:has-text("Agregar invitados")').last().click(); await p.waitForTimeout(1800)
  const nextCard=p.locator('main button:has-text("Próxima"), main [role=button]:has-text("Próxima")').first()
  if(await nextCard.count()){ await nextCard.click(); await p.waitForTimeout(800) } else console.log('no proxima card')
  const nameInput=p.locator('main input[placeholder*="invitado"]').first()
  await nameInput.fill('Carlos Ramos'); await p.waitForTimeout(300)
  await snap(p,'w2_5','main button:has-text("Agregar invitado")')
  await p.locator('main button:has-text("Agregar invitado")').first().click(); await p.waitForTimeout(1500)
  await snap(p,'w2_6','main button:has-text("Copiar enlace")')
  await ctx.close()
  // ---------- W3 Reportar incidencia
  ctx=await b.newContext(opts); p=await ctx.newPage()
  pw=await loginRes(p); await pw.press('Enter'); await p.waitForURL(/resident/); await p.waitForTimeout(1800)
  await snap(p,'w3_1','main a:has-text("Reportar incidencia"), main button:has-text("Reportar incidencia")')
  await p.locator('main a:has-text("Reportar incidencia"), main button:has-text("Reportar incidencia")').first().click(); await p.waitForTimeout(1500)
  if(!/incidents/.test(p.url())) { await p.goto(APP+'/app/resident/incidents'); await p.waitForTimeout(1200) }
  if(await p.locator('#inc-resident-title').count()===0){
    await snap(p,'w3_2','main button:has-text("Reportar incidencia")')
    await p.locator('main button:has-text("Reportar incidencia")').first().click(); await p.waitForTimeout(800)
  } else { await snap(p,'w3_2') }
  await p.fill('#inc-resident-title','Filtración de agua en el estacionamiento')
  await p.fill('#inc-resident-description','Hay una filtración en el techo del sótano 1, cerca de los estacionamientos 12 y 13. El piso está mojado.')
  await snap(p,'w3_3','button:has-text("Enviar incidencia")')
  await p.locator('button:has-text("Enviar incidencia")').click(); await p.waitForTimeout(1800)
  await snap(p,'w3_4', p.locator('main :text("Filtración de agua")').first())
  await ctx.close()
  // ---------- W4 Asistente
  ctx=await b.newContext(opts); p=await ctx.newPage()
  pw=await loginRes(p); await pw.press('Enter'); await p.waitForURL(/resident/); await p.waitForTimeout(1800)
  await snap(p,'w4_1','main a:has-text("Hablar con el asistente"), main button:has-text("Hablar con el asistente")')
  await p.locator('main a:has-text("Hablar con el asistente"), main button:has-text("Hablar con el asistente")').first().click(); await p.waitForTimeout(1500)
  if(await p.locator('#resident-composer').count()===0){
    await snap(p,'w4_2','main button:has-text("Iniciar chat")')
    await p.locator('main button:has-text("Iniciar chat")').first().click(); await p.waitForTimeout(1200)
  } else await snap(p,'w4_2')
  await p.fill('#resident-composer','¿Cuál es el horario de la piscina?'); await p.waitForTimeout(200)
  await snap(p,'w4_3','#resident-composer')
  await p.locator('#resident-composer').press('Enter'); await p.waitForTimeout(3500)
  const yes=p.locator('button:has-text("Sí")').last()
  await snap(p,'w4_4', (await yes.count())? yes : null)
  if(await yes.count()){ await yes.click(); await p.waitForTimeout(1500) }
  await snap(p,'w4_5')
  await ctx.close()
  if(!mobile){
    // ---------- W5 Junta directiva
    ctx=await b.newContext(opts); p=await ctx.newPage()
    await loginAdmin(p); await p.waitForURL(/\/app$/); await p.waitForTimeout(1500)
    await p.goto(APP+'/app/access'); await p.waitForTimeout(1500)
    await p.click('label.access-role:has-text("Junta directiva")')
    await p.fill('#member-email','presidencia@demo.test'); await p.fill('#member-name','Rosa Medina')
    await snap(p,'w5_1','button.access-submit')
    await p.click('button.access-submit'); await p.waitForSelector('.access-result input'); await p.waitForTimeout(600)
    const link=await p.locator('.access-result input').inputValue()
    await snap(p,'w5_2','.access-result')
    await p.goto(link); await p.waitForTimeout(1800)
    await p.fill('#minv-password','123456')
    await snap(p,'w5_3','.minv__primary')
    // board login
    await p.goto(APP+'/app/settings'); 
    await p.evaluate(()=>{localStorage.removeItem('buildingfex.session')})
    await loginAdmin(p,'junta'); await p.waitForURL(/board/); await p.waitForTimeout(1800)
    await snap(p,'w5_4','.board-hero__pill')
    await ctx.close()
    // ---------- W6 Cambio de edificio
    ctx=await b.newContext(opts); p=await ctx.newPage()
    await loginAdmin(p); await p.waitForURL(/\/app$/); await p.waitForTimeout(1800)
    await snap(p,'w6_1','#app-building-select')
    await p.goto(APP+'/app/buildings'); await p.waitForTimeout(1500)
    await snap(p,'w6_2','.pf-building:nth-child(2) .pf-open')
    await p.locator('.pf-building').nth(1).locator('.pf-open').click(); await p.waitForLoadState('load'); await p.waitForTimeout(2000)
    await snap(p,'w6_3','#app-building-select')
    await p.goto(APP+'/app/buildings'); await p.waitForTimeout(1500)
    await p.click('button.pf-primary:has-text("Agregar edificio")')
    await p.fill('#pf-name','Torre Mirador'); await p.fill('#pf-address','Av. del Ejército 900, Magdalena'); await p.fill('#pf-departments','60')
    await snap(p,'w6_4','form.pf-form button[type=submit]')
    await p.click('form.pf-form button[type=submit]'); await p.waitForTimeout(1500)
    await snap(p,'w6_5', p.locator('.pf-building:has-text("Torre Mirador")'))
    await ctx.close()
    // ---------- W0 overview pages
    ctx=await b.newContext(opts); p=await ctx.newPage()
    await p.goto(APP+'/login'); await p.waitForTimeout(800); await snap(p,'ov_login')
    pw=await loginRes(p); await pw.press('Enter'); await p.waitForURL(/resident/); await p.waitForTimeout(1500)
    for (const r of ['dashboard','finance','services','generation','incidents','support']) { await p.goto(APP+'/app/resident/'+r); await p.waitForTimeout(1300); await snap(p,'ov_res_'+r) }
    await p.evaluate(()=>{localStorage.removeItem('buildingfex.session')})
    await loginAdmin(p); await p.waitForURL(/\/app$/); await p.waitForTimeout(1500)
    for (const r of ['','advanced-management','finance','incidents','information','access','buildings']) { await p.goto(APP+'/app/'+r); await p.waitForTimeout(1300); await snap(p,'ov_adm_'+(r||'dashboard')) }
    await p.evaluate(()=>{localStorage.removeItem('buildingfex.session')})
    await loginAdmin(p,'junta'); await p.waitForURL(/board/); await p.waitForTimeout(1500)
    for (const r of ['board','access','buildings']) { await p.goto(APP+'/app/'+r); await p.waitForTimeout(1300); await snap(p,'ov_brd_'+r) }
    await ctx.close()
  }
  fs.writeFileSync(`${D}/meta_${MODE}.json`,JSON.stringify(meta,null,1))
  await b.close()
})().catch(e=>{console.error(e);process.exit(1)})
