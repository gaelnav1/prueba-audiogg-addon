import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import createTorrent from 'create-torrent'
import bencode from 'bencode'

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

function infoHashFromTorrent(buf) {
  const decoded = bencode.decode(buf)
  return crypto.createHash('sha1').update(bencode.encode(decoded.info)).digest('hex')
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

async function main() {
  const input = path.resolve(required('input'))
  const title = required('title')
  const artist = arg('artist', 'Desconocido')
  const type = arg('type', 'track')
  const license = required('license')
  const rights = required('rights')
  const repo = arg('repo', 'gaelnav1/prueba-audiogg-addon')
  const branch = arg('branch', 'audiogg-addon')
  const id = slug(arg('id', title)) || crypto.randomUUID()

  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) {
    throw new Error('El archivo no existe: ' + input)
  }
  if (!['owned','licensed','public-domain'].includes(rights)) {
    throw new Error('--rights debe ser owned, licensed o public-domain')
  }

  gh(['auth','status'])

  const view = JSON.parse(gh(['repo','view',repo,'--json','isPrivate']).stdout)
  if (view.isPrivate) throw new Error('El repo debe ser público')

  const originalName = path.basename(input)
  const extension = path.extname(originalName).toLowerCase()
  const safeAssetName = (slug(id) || 'audio') + extension
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), '.audiogg-upload-'))
  const safeInput = path.join(tempDir, safeAssetName)
  fs.copyFileSync(input, safeInput)

  const tag = 'audiogg-' + id + '-' + Date.now()
  const assetUrl =
    'https://github.com/' + repo + '/releases/download/' +
    encodeURIComponent(tag) + '/' + encodeURIComponent(safeAssetName)

  console.log('1/4 Subiendo audio remoto...')
  gh([
    'release','create',tag,
    '--repo',repo,
    '--title','Audio GG: ' + title,
    '--notes','Rights: ' + rights + '. License: ' + license + '.',
    safeInput
  ])

  console.log('2/4 Generando torrent con webseed remoto...')
  const torrent = await makeTorrent(input, {
    name: originalName,
    createdBy: 'Audio GG external addon demo',
    comment: title,
    urlList: [assetUrl]
  })
  const infoHash = infoHashFromTorrent(torrent)

  const tmp = path.join(process.cwd(), id + '.torrent')
  fs.writeFileSync(tmp, torrent)
  gh(['release','upload',tag,tmp,'--repo',repo])
  fs.unlinkSync(tmp)
  fs.rmSync(tempDir, { recursive:true, force:true })

  const torrentUrl =
    'https://github.com/' + repo + '/releases/download/' +
    encodeURIComponent(tag) + '/' + encodeURIComponent(id + '.torrent')

  console.log('3/4 Publicando Source Protocol...')
  const base = 'https://raw.githubusercontent.com/' + repo + '/' + branch + '/.audiogg'

  const manifest = {
    protocolVersion:'1.0',
    id:'com.github.' + repo.replace('/','.'),
    name:'Prueba Audio GG Addon',
    version:'1.0.0',
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
  const stream = {
    ok:true,
    streams:[{
      transport:'p2p',
      infoHash,
      fileIndex:0,
      magnet:torrentUrl,
      torrentUrl,
      title,
      format:path.extname(originalName).slice(1).toLowerCase()
    }]
  }

  putFile(repo,branch,'.audiogg/manifest.json',JSON.stringify(manifest,null,2)+'\n','Publish manifest')
  putFile(repo,branch,'.audiogg/catalog',JSON.stringify(catalog,null,2)+'\n','Publish catalog')
  putFile(repo,branch,'.audiogg/meta/'+type+'/'+id+'.json',JSON.stringify(meta,null,2)+'\n','Publish metadata')
  putFile(repo,branch,'.audiogg/stream/'+type+'/'+id+'.json',JSON.stringify(stream,null,2)+'\n','Publish stream')

  console.log('4/4 Listo.')
  console.log(JSON.stringify({
    ok:true,
    sourceBaseUrl:base,
    manifestUrl:base + '/manifest.json',
    torrentUrl,
    infoHash,
    localSeed:false,
    message:'Puedes apagar esta computadora.'
  }, null, 2))
}

main().catch(err => {
  console.error('ERROR:', err.message)
  process.exit(1)
})
