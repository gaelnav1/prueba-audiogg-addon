import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import bencode from 'bencode'
import WebTorrent from 'webtorrent'

const PORT = Number(process.env.PORT || 8080)
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data')
const UPLOAD_TOKEN = process.env.SEED_UPLOAD_TOKEN || ''
const STATE_PATH = path.join(DATA_DIR, 'seed-state.json')

fs.mkdirSync(DATA_DIR, { recursive: true })

const app = express()
app.use(cors())
app.use(express.json())

const client = new WebTorrent()
const active = new Map()

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    return Array.isArray(parsed.seeds) ? parsed.seeds : []
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function writeState(seeds) {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ seeds }, null, 2) + '\n')
}

function safeId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
}

function torrentInfoHash(buffer) {
  const decoded = bencode.decode(buffer)
  return crypto.createHash('sha1').update(bencode.encode(decoded.info)).digest('hex')
}

function requireToken(req, res, next) {
  if (!UPLOAD_TOKEN) {
    return res.status(503).json({ ok:false, error:'SEED_UPLOAD_TOKEN no configurado' })
  }
  const auth = req.headers.authorization || ''
  if (auth !== 'Bearer ' + UPLOAD_TOKEN) {
    return res.status(401).json({ ok:false, error:'No autorizado' })
  }
  next()
}

const upload = multer({
  dest: path.join(DATA_DIR, '.uploads'),
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }
})

async function startSeed(entry) {
  if (active.has(entry.id)) return active.get(entry.id)

  const torrentBuffer = fs.readFileSync(entry.torrentPath)
  const contentDir = path.dirname(entry.contentPath)

  const torrent = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout iniciando seed')), 30000)
    const t = client.add(torrentBuffer, { path: contentDir }, ready => {
      clearTimeout(timeout)
      resolve(ready)
    })
    t.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
  })

  active.set(entry.id, torrent)
  console.log('[seed] active', entry.id, torrent.infoHash)
  return torrent
}

async function restoreSeeds() {
  for (const entry of readState()) {
    if (!fs.existsSync(entry.contentPath) || !fs.existsSync(entry.torrentPath)) continue
    try { await startSeed(entry) }
    catch (error) { console.error('[seed] restore failed', entry.id, error.message) }
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok:true,
    service:'audiogg-seed-node',
    activeTorrents:client.torrents.length,
    storedSeeds:readState().length,
    webrtcSupport:WebTorrent.WEBRTC_SUPPORT
  })
})

app.get('/seeds', (_req, res) => {
  res.json({
    ok:true,
    seeds:readState().map(entry => {
      const torrent = active.get(entry.id)
      return {
        id:entry.id,
        infoHash:entry.infoHash,
        peers:torrent?.numPeers || 0,
        progress:torrent?.progress || 0,
        uploadedAt:entry.uploadedAt
      }
    })
  })
})

app.post(
  '/admin/publish',
  requireToken,
  upload.fields([
    { name:'audio', maxCount:1 },
    { name:'torrent', maxCount:1 }
  ]),
  async (req, res) => {
    const audio = req.files?.audio?.[0]
    const torrentFile = req.files?.torrent?.[0]

    if (!audio || !torrentFile) {
      return res.status(400).json({ ok:false, error:'Faltan audio y torrent' })
    }

    const id = safeId(req.body.id)
    if (!id) return res.status(400).json({ ok:false, error:'Falta id' })

    const originalName = path.basename(req.body.fileName || audio.originalname || 'audio.bin')
    const dir = path.join(DATA_DIR, 'seeds', id)
    fs.mkdirSync(dir, { recursive:true })

    const contentPath = path.join(dir, originalName)
    const torrentPath = path.join(dir, id + '.torrent')

    fs.renameSync(audio.path, contentPath)
    fs.renameSync(torrentFile.path, torrentPath)

    const torrentBuffer = fs.readFileSync(torrentPath)
    const infoHash = torrentInfoHash(torrentBuffer)

    const seeds = readState().filter(seed => seed.id !== id)
    const entry = {
      id,
      infoHash,
      contentPath,
      torrentPath,
      fileName:originalName,
      uploadedAt:new Date().toISOString()
    }
    seeds.push(entry)
    writeState(seeds)

    try {
      const old = active.get(id)
      if (old) {
        client.remove(old.infoHash)
        active.delete(id)
      }
      const torrent = await startSeed(entry)
      res.status(201).json({
        ok:true,
        id,
        infoHash,
        magnet:torrent.magnetURI,
        files:torrent.files.map((file,index)=>({ index, name:file.name, length:file.length })),
        peers:torrent.numPeers
      })
    } catch (error) {
      res.status(500).json({ ok:false, error:error.message, infoHash })
    }
  }
)

function shutdown() {
  client.destroy(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

restoreSeeds().finally(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('[seed] HTTP control plane on :' + PORT)
    console.log('[seed] WebRTC support:', WebTorrent.WEBRTC_SUPPORT)
  })
})
