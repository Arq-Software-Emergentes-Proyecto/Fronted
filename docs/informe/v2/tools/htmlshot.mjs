// Render de una figura HTML a PNG: node htmlshot.mjs figNNN.html [scale]
// Captura el elemento #c; ancho de PNG = ancho CSS de #c x scale (ajustar para <= 2400 px).
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs'
import path from 'node:path'
const [,, file, scaleArg] = process.argv
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page0 = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
await page0.goto('file://' + path.resolve(file))
await page0.waitForTimeout(400)
const box = await page0.locator('#c').boundingBox()
const minFont = await page0.evaluate(() => {
  let m = 99
  for (const el of document.querySelectorAll('#c *')) {
    const t = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
    if (t) m = Math.min(m, parseFloat(getComputedStyle(el).fontSize))
  }
  return m
})
const scale = scaleArg ? +scaleArg : Math.min(3, 2400 / box.width)
const page = await browser.newPage({ viewport: { width: 1600, height: Math.ceil(box.height + 50) }, deviceScaleFactor: scale })
await page.goto('file://' + path.resolve(file))
await page.waitForTimeout(400)
const out = file.replace(/\.html$/, '.png')
await page.locator('#c').screenshot({ path: out })
const sc = Math.min(450 / box.width, 650 / box.height)
console.log(`${path.basename(out)}: ${Math.round(box.width)}x${Math.round(box.height)} css px, ratio ${(box.height / box.width).toFixed(2)}, fuente min ${minFont}px -> ${(minFont * sc).toFixed(2)} pt impreso, png ${Math.round(box.width * scale)}x${Math.round(box.height * scale)}`)
await browser.close()
