/**
 * json-server middleware: CORS for browser clients (e.g. SPA on another Render host).
 */
module.exports = (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }
  next()
}
