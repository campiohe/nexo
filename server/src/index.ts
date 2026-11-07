// Entry point: `node src/index.ts` (see package.json). The server itself lives in server.ts.
import { configWarnings, loadConfig } from './config.ts'
import { start } from './server.ts'

const config = loadConfig()
for (const warning of configWarnings(config)) console.warn(`[nexo] ${warning}`)

let server: Awaited<ReturnType<typeof start>>
try {
  server = await start(config)
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'EADDRINUSE') console.error(`[nexo] Port ${config.port} is already in use. Is another Nexo server running? (set PORT in .env)`)
  else console.error('[nexo] Failed to start:', err)
  process.exit(1)
}

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) {
    console.log('[nexo] Forcing exit')
    process.exit(1)
  }
  shuttingDown = true
  console.log(`[nexo] ${signal} received, shutting down…`)
  const force = setTimeout(() => {
    console.error('[nexo] Shutdown timed out, forcing exit')
    process.exit(1)
  }, 5000)
  force.unref()
  try {
    await server.close()
    process.exit(0)
  } catch (err) {
    console.error('[nexo] Error during shutdown:', err)
    process.exit(1)
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
