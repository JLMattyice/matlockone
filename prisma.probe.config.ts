import path from 'node:path'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: path.join('prisma', 'probe.prisma'),
  datasource: { url: env('DATABASE_URL') },
})
