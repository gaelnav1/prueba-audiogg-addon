import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import createTorrent from 'create-torrent'

const TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'udp://tracker.opentrackr.org:1337/announce'
]

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

function required(name) {
  const value = arg(name)
  if (!value) throw new Error('Falta --' + name)
  return value
}

function slug(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function run(command, args, { input, allowFailure = false } = {}) {
  const r = spawnSync(command, args, {
    encoding: 'utf8',
    input: input == null ? undefined : input,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  if (r.status !== 0 && !allowFailure) {
    throw new Error((r.stderr || r.stdout || command + ' failed').trim())
  }
  return r
}

function gh(args, opts = {}) { return run('gh', args, opts) }

function ghJson(args, payload) {
  const r = gh(args.concat(['--input', '-']), { input: JSON.stringify(payload) })
  return r.stdout.trim() ? JSON.parse(r.stdout) : {}
}

async function makeTorrent(input, opts) {
  return new Promise((resolve, reject) => {
    createTorrent(input, opts, (err, torrent) => err ? reject(err) : resolve(torrent))
  })
}

function remoteFile(repo, branch, repoPath) {
  const r = gh([
    'api',
    '--method', 'GET',
    'repos/' + repo + '/contents/' + repoPath,
    '-f', 'ref=' + branch
  ], { allowFailure: true })

  if (r.status !== 0) return null
  const data = JSON.parse(r.stdout)
  return {
    sha: data.sha,
    content: Buffer.from(String(data.content || '').replace(/\n/g, ''), 'base64').toString('utf8')
  }
}

function putFile(repo, branch, repoPath, content, message) {
  const existing = remoteFile(repo, branch, repoPath)
  const payload = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch
  }
  if (existing?.sha) payload.sha = existing.sha
  ghJson(['api', 'repos/' + repo + '/contents/' + repoPath, '--method', 'PUT'], payload)
}

async function uploadToSeedNode({ seedNodeUrl, token, id, input, torrent }) {
  const form = new FormData()
  const audioBuffer = fs.readFileSync(input)
  form.append('audio', new Blob([audioBuffer]), path.basename(input))
  form.append('torrent', new Blob([torrent]), id + '.torrent')
  form.append('id', id)
  form.append('fileName', path.basename(input))

  const response = await fetch(seedNodeUrl.replace(/\/$/, '') + '/admin/publish', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: form
  })

  let data
  try { data = await response.json() } catch { data = null }

  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || ('Seed node HTTP ' + response.status))
  }
  return data
}

async function main() {
  const input = path.resolve(required('input'))
  const title = required('title')
  const artist = arg('artist', 'Desconocido')
  const type = arg('type', 'track')
  const license = required('license')
  const rights = required('rights')
  const repo = arg('repo', 'gaelnav1/prueba-audiogg-addon')
  const branch = arg('branch', 'audiogg-addon')
  const seedNodeUrl = arg('seed-node', process.env.SEED_NODE_URL)
  const seedToken = arg('seed-token', process.env.SEED_UPLOAD_TOKEN)
  const id = slug(arg('id', title)) || crypto.randomUUID()

  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) {
    throw new Error('El archivo no existe: ' + input)
  }
  if (!['owned','licensed','public-domain'].includes(rights)) {
    throw new Error('--rights debe ser owned, licensed o public-domain')
  }
  if (!seedNodeUrl) throw new Error('Falta --seed-node o SEED_NODE_URL')
  if (!seedToken) throw new Error('Falta --seed-token o SEED_UPLOAD_TOKEN')

  gh(['auth','status'])
  const view = JSON.parse(gh(['repo','view',repo,'--json','isPrivate']).stdout)
  if (view.isPrivate) throw new Error('El repo del addon debe ser público')

  console.log('1/3 Generando torrent...')
  const torrent = await makeTorrent(input, {
    name: path.basename(input),
    createdBy: 'Audio GG external publisher',
    comment: title,
    announce: TRACKERS
  })

  console.log('2/3 Subiendo audio + torrent al seed node...')
  const seeded = await uploadToSeedNode({
    seedNodeUrl,
    token: seedToken,
    id,
    input,
    torrent
  })

  console.log('3/3 Publicando descriptor P2P del addon...')
  const base = 'https://raw.githubusercontent.com/' + repo + '/' + branch + '/.audiogg'

  const manifest = {
    protocolVersion:'1.0',
    id:'com.github.' + repo.replace('/','.'),
    name:'Prueba Audio GG Addon',
    version:'1.1.0',
    types:['track','album','podcast','audiobook','concert'],
    resources:['catalog','meta','stream'],
    transports:['p2p']
  }

  let catalog = { ok:true, results:[] }
  const old = remoteFile(repo, branch, '.audiogg/catalog')
  if (old?.content) {
    try { catalog = JSON.parse(old.content) } catch {}
  }
  if (!Array.isArray(catalog.results)) catalog.results = []

  const item = { id,type,title,artist,license,rights }
  catalog.results = catalog.results.filter(x => !(x.id === id && x.type === type))
  catalog.results.push(item)

  const meta = { ok:true, meta:item }
  const torrentPath = '.audiogg/torrents/' + id + '.torrent'
  const torrentUrl = base + '/torrents/' + id + '.torrent'

  const stream = {
    ok:true,
    streams:[{
      transport:'p2p',
      infoHash:seeded.infoHash,
      magnet:seeded.magnet,
      torrentUrl,
      fileIndex:0,
      title,
      format:path.extname(input).slice(1).toLowerCase()
    }]
  }

  putFile(repo,branch,'.audiogg/manifest.json',JSON.stringify(manifest,null,2)+'\n','Publish manifest')
  putFile(repo,branch,'.audiogg/catalog',JSON.stringify(catalog,null,2)+'\n','Publish catalog')
  putFile(repo,branch,'.audiogg/meta/'+type+'/'+id+'.json',JSON.stringify(meta,null,2)+'\n','Publish metadata')
  putFile(repo,branch,torrentPath,torrent,'Publish torrent metadata')
  putFile(repo,branch,'.audiogg/stream/'+type+'/'+id+'.json',JSON.stringify(stream,null,2)+'\n','Publish torrent-only stream')

  console.log(JSON.stringify({
    ok:true,
    sourceBaseUrl:base,
    manifestUrl:base + '/manifest.json',
    infoHash:seeded.infoHash,
    magnet:seeded.magnet,
    torrentUrl,
    seedNode:seedNodeUrl,
    localSeed:false,
    httpAudioFallback:false,
    message:'El audio quedó almacenado en el seed node y publicado como torrent-only.'
  }, null, 2))
}

main().catch(err => {
  console.error('ERROR:', err.message)
  process.exit(1)
})
