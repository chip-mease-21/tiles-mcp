import express from 'express'
import admin from 'firebase-admin'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

// ---------- config ----------
const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}')
const USER_ID = process.env.TILES_USER_ID // the Firebase uid whose board we expose
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN // shared secret the client must send
const PORT = process.env.PORT || 3000

if (!SERVICE_ACCOUNT.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is missing/invalid')
if (!USER_ID) throw new Error('TILES_USER_ID is required')
if (!AUTH_TOKEN) throw new Error('MCP_AUTH_TOKEN is required')

admin.initializeApp({ credential: admin.credential.cert(SERVICE_ACCOUNT) })
const db = admin.firestore()
const entries = () => db.collection('entries')

const COLUMNS = ['inbox', 'notes', 'today', 'this_week', 'this_month', 'next_month', 'someday']
const columnEnum = z.enum(COLUMNS)

// ---------- helpers ----------
function rid() {
  return Math.random().toString(36).slice(2, 10)
}

function shapeTile(doc) {
  const d = doc.data()
  const tasks = (d.tasks || []).map((t) => ({ id: t.id, text: t.text, done: !!t.done }))
  const done = tasks.filter((t) => t.done).length
  return {
    id: doc.id,
    type: d.type,
    title: d.title || '',
    body: d.body || '',
    column: d.column,
    tags: d.tags || [],
    dueDate: d.dueDate || null,
    pinned: !!d.pinned,
    archived: !!d.archived,
    tasks,
    progress: d.type === 'todo' ? `${done}/${tasks.length}` : null
  }
}

async function getAllTiles() {
  const snap = await entries().where('userId', '==', USER_ID).get()
  return snap.docs
}

async function getTileDoc(id) {
  const ref = entries().doc(id)
  const doc = await ref.get()
  if (!doc.exists) throw new Error(`No tile with id ${id}`)
  if (doc.data().userId !== USER_ID) throw new Error('Tile does not belong to this board')
  return { ref, doc }
}

function ok(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] }
}
function err(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

// ---------- MCP server factory ----------
function buildServer() {
  const server = new McpServer({ name: 'tiles', version: '1.0.0' })

  server.registerTool(
    'list_tiles',
    {
      description:
        'List tiles (cards) on the board. Filter by column, tag, type, due date, or archived state.',
      inputSchema: {
        column: columnEnum.optional(),
        tag: z.string().optional(),
        type: z.enum(['note', 'todo']).optional(),
        due_on_or_before: z.string().optional().describe('ISO date yyyy-mm-dd'),
        include_archived: z.boolean().optional(),
        limit: z.number().int().positive().optional()
      }
    },
    async (a) => {
      try {
        let tiles = (await getAllTiles()).map(shapeTile)
        if (!a.include_archived) tiles = tiles.filter((t) => !t.archived)
        if (a.column) tiles = tiles.filter((t) => t.column === a.column)
        if (a.type) tiles = tiles.filter((t) => t.type === a.type)
        if (a.tag) tiles = tiles.filter((t) => t.tags.includes(a.tag.toLowerCase()))
        if (a.due_on_or_before)
          tiles = tiles.filter((t) => t.dueDate && t.dueDate <= a.due_on_or_before)
        if (a.limit) tiles = tiles.slice(0, a.limit)
        return ok({ count: tiles.length, tiles })
      } catch (e) {
        return err(e.message)
      }
    }
  )

  server.registerTool(
    'get_tile',
    { description: 'Get one tile by id.', inputSchema: { id: z.string() } },
    async (a) => {
      try {
        const { doc } = await getTileDoc(a.id)
        return ok(shapeTile(doc))
      } catch (e) {
        return err(e.message)
      }
    }
  )

  server.registerTool(
    'create_tile',
    {
      description:
        'Create a new tile. Defaults to a note in the Inbox. For a to-do, pass type "todo" and optionally a list of task strings.',
      inputSchema: {
        title: z.string(),
        type: z.enum(['note', 'todo']).optional(),
        column: columnEnum.optional(),
        body: z.string().optional().describe('Note body (plain text or simple HTML)'),
        tags: z.array(z.string()).optional(),
        due_date: z.string().optional().describe('ISO date yyyy-mm-dd'),
        tasks: z.array(z.string()).optional().describe('Task texts, for to-do tiles')
      }
    },
    async (a) => {
      try {
        const now = Date.now()
        const tasks = (a.tasks || []).map((text, i) => ({
          id: rid(),
          text,
          done: false,
          position: i
        }))
        const payload = {
          userId: USER_ID,
          type: a.type || (tasks.length ? 'todo' : 'note'),
          title: a.title,
          body: a.body || '',
          column: a.column || 'inbox',
          position: now,
          tags: (a.tags || []).map((t) => t.toLowerCase().replace(/^#/, '')),
          dueDate: a.due_date || null,
          pinned: false,
          archived: false,
          tasks,
          createdAt: now,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }
        const ref = await entries().add(payload)
        const doc = await ref.get()
        return ok({ created: true, tile: shapeTile(doc) })
      } catch (e) {
        return err(e.message)
      }
    }
  )

  server.registerTool(
    'update_tile',
    {
      description: 'Update fields on a tile. Only provided fields change.',
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        column: columnEnum.optional(),
        tags: z.array(z.string()).optional(),
        due_date: z.string().nullable().optional(),
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
        type: z.enum(['note', 'todo']).optional()
      }
    },
    async (a) => {
      try {
        const { ref, doc } = await getTileDoc(a.id)
        const patch = { updatedAt: admin.firestore.FieldValue.serverTimestamp() }
        if (a.title !== undefined) patch.title = a.title
        if (a.body !== undefined) patch.body = a.body
        if (a.column !== undefined) patch.column = a.column
        if (a.tags !== undefined) patch.tags = a.tags.map((t) => t.toLowerCase().replace(/^#/, ''))
        if (a.due_date !== undefined) patch.dueDate = a.due_date
        if (a.pinned !== undefined) patch.pinned = a.pinned
        if (a.archived !== undefined) patch.archived = a.archived
        if (a.type !== undefined) patch.type = a.type
        await ref.update(patch)
        const fresh = await ref.get()
        void doc
        return ok({ updated: true, tile: shapeTile(fresh) })
      } catch (e) {
        return err(e.message)
      }
    }
  )

  server.registerTool(
    'move_tile',
    {
      description: 'Move a tile to a different column.',
      inputSchema: { id: z.string(), column: columnEnum }
    },
    async (a) => {
      try {
        const { ref } = await getTileDoc(a.id)
        await ref.update({
          column: a.column,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        })
        return ok({ moved: true, id: a.id, column: a.column })
      } catch (e) {
        return err(e.message)
      }
    }
  )

  server.registerTool(
    'add_task',
    {
      description: 'Add a task (checkbox item) to a to-do tile.',
      inputSchema: { tile_id: z.string(), text: z.string() }
    },
    async (a) => {
      try {
        const { ref, doc } = await getTileDoc(a.tile_id)
        const d = doc.data()
        const tasks = d.tasks || []
        tasks.push({ id: rid(), text: a.text, done: false, position: tasks.length })
        await ref.update({
          tasks,
          type: 'todo',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        })
        const fresh = await ref.get()
        return ok({ added: true, tile: shapeTile(fresh) })
      } catch (e) {
        return err(e.message)
      }
    }
  )

  server.registerTool(
    'set_task_done',
    {
      description: 'Check or uncheck a task on a to-do tile.',
      inputSchema: { tile_id: z.string(), task_id: z.string(), done: z.boolean() }
    },
    async (a) => {
      try {
        const { ref, doc } = await getTileDoc(a.tile_id)
        const tasks = (doc.data().tasks || []).map((t) =>
          t.id === a.task_id ? { ...t, done: a.done } : t
        )
        await ref.update({
          tasks,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        })
        const fresh = await ref.get()
        return ok({ updated: true, tile: shapeTile(fresh) })
      } catch (e) {
        return err(e.message)
      }
    }
  )

  server.registerTool(
    'delete_tile',
    { description: 'Permanently delete a tile.', inputSchema: { id: z.string() } },
    async (a) => {
      try {
        const { ref } = await getTileDoc(a.id)
        await ref.delete()
        return ok({ deleted: true, id: a.id })
      } catch (e) {
        return err(e.message)
      }
    }
  )

  server.registerTool(
    'list_tags',
    { description: 'List the board\'s tags grouped by category.', inputSchema: {} },
    async () => {
      try {
        const udoc = await db.collection('userdata').doc(USER_ID).get()
        const tagCategories = (udoc.exists && udoc.data().tagCategories) || {}
        const categories = (udoc.exists && udoc.data().categories) || [
          'Roles',
          'People',
          'Areas',
          'Personal'
        ]
        const grouped = {}
        for (const c of [...categories, 'Unsorted']) grouped[c] = []
        for (const [tag, cat] of Object.entries(tagCategories)) {
          ;(grouped[cat] || grouped['Unsorted']).push(tag)
        }
        return ok({ categories, tagsByCategory: grouped })
      } catch (e) {
        return err(e.message)
      }
    }
  )

  return server
}

// ---------- HTTP (Streamable HTTP MCP transport) ----------
const app = express()
app.use(express.json({ limit: '1mb' }))

app.get('/', (_req, res) => res.status(200).send('Tiles MCP server is running.'))

function authed(req, res) {
  const header = req.headers['authorization'] || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (token !== AUTH_TOKEN) {
    res.status(401).json({ error: 'unauthorized' })
    return false
  }
  return true
}

app.post('/mcp', async (req, res) => {
  if (!authed(req, res)) return
  try {
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => transport.close())
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String(e) })
  }
})

// Stateless server: GET/DELETE sessions are not supported.
app.get('/mcp', (_req, res) => res.status(405).json({ error: 'method not allowed' }))
app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'method not allowed' }))

app.listen(PORT, () => console.log(`Tiles MCP server listening on :${PORT}`))
