import {
  createMercadoPagoPreference,
  readMercadoPagoPayment,
} from '../server/mercadoPagoCheckout.mjs'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  try {
    if (req.method === 'POST') {
      const result = await createMercadoPagoPreference(req.body || {})
      res.status(200).json(result)
      return
    }
    if (req.method === 'GET') {
      const id = req.query?.id ?? req.query?.paymentId
      const result = await readMercadoPagoPayment(id)
      res.status(200).json(result)
      return
    }
    res.status(405).json({ code: 'METHOD_NOT_ALLOWED', message: 'Use POST or GET' })
  } catch (error) {
    res.status(Number(error?.status) || 500).json({
      code: error?.code || 'MP_ERROR',
      message: error?.message || 'Mercado Pago request failed',
    })
  }
}
