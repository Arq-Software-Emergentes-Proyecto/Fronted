import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const binDir = path.join(root, 'node_modules', '.bin')
const jsonServerBin =
  process.platform === 'win32' ? path.join(binDir, 'json-server.cmd') : path.join(binDir, 'json-server')

const port = process.env.PORT || '3001'
const db = path.join(__dirname, 'db.json')
const mw = path.join(__dirname, 'render-cors.cjs')

const child = spawn(
  jsonServerBin,
  ['--watch', db, '--host', '0.0.0.0', '--port', port, '--middlewares', mw],
  { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' },
)

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 0)
})
