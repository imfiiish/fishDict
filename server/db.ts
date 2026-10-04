import './env.ts'
import { Pool } from 'pg'

const connectionString =
  process.env.DATABASE_URL ??
  'postgres://fishdict:fishdict@localhost:5432/fishdict'

export const pool = new Pool({ connectionString })
