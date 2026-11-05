# prueba-audiogg-addon

Simulación de un usuario externo publicando su propio audio para Audio GG.

## Uso

Requisitos: Node.js 20+ y GitHub CLI (`gh`).

```powershell
git clone https://github.com/gaelnav1/prueba-audiogg-addon.git
cd prueba-audiogg-addon
npm install
gh auth login

npm run publish -- `
  --input "C:\ruta\mi-audio.m4a" `
  --title "Mi audio" `
  --artist "Yo" `
  --type track `
  --license "All rights reserved" `
  --rights owned
```

Al terminar devuelve `sourceBaseUrl`. Esa es la URL que se instala como Fuente en Audio GG.

El archivo se aloja en GitHub Releases y el torrent usa ese archivo remoto como webseed. La computadora local no queda como seed.
