# Audio GG Seed Node

Nodo remoto persistente para almacenar y sembrar audio mediante BitTorrent/WebTorrent.

## Propiedad central

El audio se guarda en el volumen del seed node. El addon **no expone una URL HTTP al audio**.

Flujo:

```
publisher -> POST audio + .torrent -> seed node volume
                                  -> WebTorrent seed
addon -> magnet/infoHash ---------^
Audio GG Desktop -> swarm -> pieces -> playback
```

## Variables

- `SEED_UPLOAD_TOKEN` obligatorio.
- `DATA_DIR=/data`
- `PORT` lo define el proveedor.

Monte un volumen persistente en `/data`.

## API

`POST /admin/publish` multipart, Bearer token:
- `audio`
- `torrent`
- `id`
- `fileName`

`GET /health`
`GET /seeds`

El nodo restaura automáticamente los torrents guardados después de reiniciarse.
