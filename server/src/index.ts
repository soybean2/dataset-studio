import { pathToFileURL } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { config } from './config.js'
import { closeDb, getSettings } from './db.js'
import { registerRoutes } from './routes.js'
import { pingTagger } from './tagger.js'
import { imagesNeedingAnalysis } from './repo.js'
import { startAnalyze } from './pipeline.js'

export async function buildApp(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 8 * 1024 * 1024 })
  await app.register(cors, { origin: true })
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 500, fields: 20 }
  })
  await registerRoutes(app)

  if (config.webDir) {
    await app.register(fastifyStatic, { root: config.webDir, prefix: '/', wildcard: false })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/img')) return reply.code(404).send({ error: 'not found' })
      return reply.type('text/html').sendFile('index.html')
    })
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }))
  }
  return app
}

async function main(): Promise<void> {
  const app = await buildApp({ logger: true })
  await app.listen({ host: config.host, port: config.port })
  const settings = getSettings()
  const health = await pingTagger(settings.taggerUrl, 3000)
  app.log.info(
    health.ok
      ? `打标服务已连接: mode=${health.mode} model=${health.model} device=${health.device}`
      : `打标服务不可用 (${settings.taggerUrl}): ${health.error ?? '未知错误'}`
  )
  if (!config.webDir) app.log.warn('未找到 web/dist，仅 API 可用；执行 npm run build:web 后重启')
  const pending = imagesNeedingAnalysis().length
  if (pending) {
    app.log.info(`发现 ${pending} 张待分析图片，自动开始分析`)
    startAnalyze()
  }
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`收到 ${signal}，正在关闭`)
    await app.close()
    closeDb()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error('启动失败', e)
    process.exit(1)
  })
}
