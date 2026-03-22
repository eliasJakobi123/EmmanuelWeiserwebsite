import { neon } from '@neondatabase/serverless'

const WORK_IDS = new Set([
  'markus-historisch',
  'paulus-fruehchristentum',
  'johannes-textvarianten',
])

let schemaReady = false

async function ensureSchema(sql) {
  if (schemaReady) return
  await sql`
    CREATE TABLE IF NOT EXISTS work_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      work_id TEXT NOT NULL,
      parent_id UUID REFERENCES work_comments(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      author_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_work_comments_work ON work_comments(work_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_work_comments_parent ON work_comments(parent_id)`
  schemaReady = true
}

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
}

function buildTree(rows) {
  const byId = new Map()
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      body: r.body,
      authorLabel: (r.author_name && String(r.author_name).trim()) || 'Anonym',
      createdAt: r.created_at,
      replies: [],
    })
  }
  const roots = []
  for (const r of rows) {
    const node = byId.get(r.id)
    if (r.parent_id) {
      const parent = byId.get(r.parent_id)
      if (parent) parent.replies.push(node)
      else roots.push(node)
    } else {
      roots.push(node)
    }
  }
  const sortRec = (list) => {
    list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    list.forEach((n) => sortRec(n.replies))
  }
  sortRec(roots)
  return roots
}

async function readJsonBody(req) {
  if (req.body != null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body
  }
  const text = await new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')

  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'database_not_configured' })
  }

  const sql = neon(process.env.DATABASE_URL)

  try {
    await ensureSchema(sql)
  } catch (e) {
    console.error('comments schema', e)
    return res.status(500).json({ error: 'schema_failed' })
  }

  if (req.method === 'GET') {
    const workId = req.query?.workId
    if (!workId || typeof workId !== 'string' || !WORK_IDS.has(workId)) {
      return res.status(400).json({ error: 'invalid_work_id' })
    }
    try {
      const rows = await sql`
        SELECT id, work_id, parent_id, body, author_name, created_at
        FROM work_comments
        WHERE work_id = ${workId}
        ORDER BY created_at ASC
      `
      return res.status(200).json({ comments: buildTree(rows) })
    } catch (e) {
      console.error('comments get', e)
      return res.status(500).json({ error: 'fetch_failed' })
    }
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req)
    if (body === null) {
      return res.status(400).json({ error: 'invalid_json' })
    }

    const workId = body.workId
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const nameRaw = typeof body.name === 'string' ? body.name.trim() : ''
    const parentId = body.parentId

    if (!workId || !WORK_IDS.has(workId)) {
      return res.status(400).json({ error: 'invalid_work_id' })
    }
    if (!text || text.length > 4000) {
      return res.status(400).json({ error: 'invalid_text' })
    }
    const authorName = nameRaw.length > 80 ? nameRaw.slice(0, 80) : nameRaw
    if (authorName.length === 0 && nameRaw.length > 0) {
      /* empty after trim ok */
    }

    let parent = null
    if (parentId != null && parentId !== '') {
      if (!isUuid(parentId)) {
        return res.status(400).json({ error: 'invalid_parent' })
      }
      parent = parentId
    }

    try {
      if (parent) {
        const check = await sql`
          SELECT id FROM work_comments
          WHERE id = ${parent} AND work_id = ${workId}
          LIMIT 1
        `
        if (!check.length) {
          return res.status(400).json({ error: 'parent_not_found' })
        }
      }

      const inserted = await sql`
        INSERT INTO work_comments (work_id, parent_id, body, author_name)
        VALUES (${workId}, ${parent}, ${text}, ${authorName || null})
        RETURNING id, work_id, parent_id, body, author_name, created_at
      `
      const row = inserted[0]
      const node = {
        id: row.id,
        body: row.body,
        authorLabel: (row.author_name && row.author_name.trim()) || 'Anonym',
        createdAt: row.created_at,
        replies: [],
      }
      return res.status(201).json({ comment: node })
    } catch (e) {
      console.error('comments post', e)
      return res.status(500).json({ error: 'insert_failed' })
    }
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'method_not_allowed' })
}
