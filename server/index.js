import http from 'http'
import { WebSocketServer } from 'ws'

const server = http.createServer(handleHttp)
const wss = new WebSocketServer({ server })

const rooms = new Map()
const sessions = new Map()
const stats = {
  totalPlays: 0,
  online: 0,
  onlineSingle: 0,
  onlineMulti: 0,
}

function makeCode() {
  return Math.random().toString(36).slice(2, 7).toUpperCase()
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

function broadcast(room, payload) {
  if (room.host) send(room.host, payload)
  if (room.guest) send(room.guest, payload)
}

function getRoom(code) {
  return rooms.get(code)
}

function adjustModeCounts(prevMode, nextMode) {
  if (prevMode === nextMode) return
  if (prevMode === 'single') stats.onlineSingle = Math.max(0, stats.onlineSingle - 1)
  if (prevMode === 'multi') stats.onlineMulti = Math.max(0, stats.onlineMulti - 1)
  if (nextMode === 'single') stats.onlineSingle += 1
  if (nextMode === 'multi') stats.onlineMulti += 1
}

function handleHttp(req, res) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders)
    res.end()
    return
  }
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (req.method === 'GET' && url.pathname === '/report') {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AI Tank 统计</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Arial, sans-serif; background: #0e0f10; color: #f5f2e6; margin: 0; }
      .wrap { max-width: 720px; margin: 40px auto; padding: 24px; background: #1a1c20; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); }
      h1 { font-size: 22px; margin: 0 0 16px; }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
      .card { background: #121318; padding: 16px; border-radius: 12px; border: 1px solid #2a2f36; }
      .label { font-size: 12px; color: #a3a7b0; margin-bottom: 8px; }
      .value { font-size: 28px; font-weight: 700; }
      .note { font-size: 12px; color: #7f8694; margin-top: 16px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>AI Tank 实时统计</h1>
      <div class="grid">
        <div class="card">
          <div class="label">累计游玩人数</div>
          <div class="value" id="total">0</div>
        </div>
        <div class="card">
          <div class="label">当前在线</div>
          <div class="value" id="online">0</div>
        </div>
        <div class="card">
          <div class="label">在线单机</div>
          <div class="value" id="single">0</div>
        </div>
        <div class="card">
          <div class="label">在线对战</div>
          <div class="value" id="multi">0</div>
        </div>
      </div>
      <div class="note">每 5 秒自动刷新</div>
    </div>
    <script>
      async function refresh() {
        const res = await fetch('/report.json');
        const data = await res.json();
        document.getElementById('total').textContent = data.totalPlays;
        document.getElementById('online').textContent = data.online;
        document.getElementById('single').textContent = data.onlineSingle;
        document.getElementById('multi').textContent = data.onlineMulti;
      }
      refresh();
      setInterval(refresh, 5000);
    </script>
  </body>
</html>`)
    return
  }

  if (req.method === 'GET' && url.pathname === '/report.json') {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(stats))
    return
  }

  if (req.method === 'POST' && url.pathname === '/track') {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1e6) req.destroy()
    })
    req.on('end', () => {
      let payload
      try {
        payload = JSON.parse(raw || '{}')
      } catch {
        res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false }))
        return
      }
      const id = String(payload.sessionId || '').trim()
      const mode = payload.mode === 'multi' ? 'multi' : 'single'
      const action = payload.action
      if (!id) {
        res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false }))
        return
      }

      const existing = sessions.get(id)
      if (action === 'join') {
        if (!existing) {
          sessions.set(id, { mode, online: true })
          stats.totalPlays += 1
          stats.online += 1
          if (mode === 'single') stats.onlineSingle += 1
          if (mode === 'multi') stats.onlineMulti += 1
        } else if (!existing.online) {
          existing.online = true
          stats.online += 1
          adjustModeCounts(null, existing.mode)
        } else if (existing.mode !== mode) {
          adjustModeCounts(existing.mode, mode)
          existing.mode = mode
        }
      } else if (action === 'mode') {
        if (existing && existing.online) {
          adjustModeCounts(existing.mode, mode)
          existing.mode = mode
        }
      } else if (action === 'leave') {
        if (existing && existing.online) {
          existing.online = false
          stats.online = Math.max(0, stats.online - 1)
          if (existing.mode === 'single') stats.onlineSingle = Math.max(0, stats.onlineSingle - 1)
          if (existing.mode === 'multi') stats.onlineMulti = Math.max(0, stats.onlineMulti - 1)
        }
      }

      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true }))
    })
    return
  }

  res.writeHead(404, { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Not Found')
}

wss.on('connection', (ws) => {
  ws.roomCode = null
  ws.role = null

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'create') {
      const requested = String(msg.code || '').trim().toUpperCase()
      if (!requested || requested.length < 4 || requested.length > 8) {
        send(ws, { type: 'join_error', message: '房间号需要 4-8 位。' })
        return
      }
      if (rooms.has(requested)) {
        send(ws, { type: 'join_error', message: '房间号已被占用。' })
        return
      }
      const code = requested
      const room = {
        code,
        status: 'waiting',
        host: ws,
        guest: null,
        ready: { host: false, guest: false },
      }
      rooms.set(code, room)
      ws.roomCode = code
      ws.role = 'host'
      send(ws, { type: 'room_created', code })
      return
    }

    if (msg.type === 'join') {
      const room = getRoom(msg.code)
      if (!room || room.guest) {
        send(ws, { type: 'join_error', message: '房间不存在或已满。' })
        return
      }
      room.guest = ws
      ws.roomCode = room.code
      ws.role = 'guest'
      send(ws, { type: 'room_joined', code: room.code })
      broadcast(room, { type: 'room_status', status: room.status })
      return
    }

    const room = getRoom(ws.roomCode)
    if (!room) return

    if (msg.type === 'ready') {
      room.ready[ws.role] = msg.value === true
      broadcast(room, { type: 'ready_state', ready: room.ready })
      if (room.ready.host && room.ready.guest) {
        room.status = 'playing'
        broadcast(room, { type: 'start' })
      }
      return
    }

    if (msg.type === 'state' && ws.role === 'host') {
      if (room.guest) send(room.guest, msg)
      return
    }

    if (msg.type === 'input' && ws.role === 'guest') {
      if (room.host) send(room.host, msg)
      return
    }

    if (msg.type === 'end') {
      room.status = 'ended'
      broadcast(room, { type: 'end', winner: msg.winner })
      return
    }
  })

  ws.on('close', () => {
    const room = getRoom(ws.roomCode)
    if (!room) return
    if (ws.role === 'host') {
      if (room.guest) send(room.guest, { type: 'end', winner: 'guest', reason: 'host_left' })
      rooms.delete(room.code)
    } else if (ws.role === 'guest') {
      if (room.host) send(room.host, { type: 'end', winner: 'host', reason: 'guest_left' })
      room.guest = null
      room.ready.guest = false
      room.status = 'waiting'
      broadcast(room, { type: 'room_status', status: room.status })
    }
  })
})

const PORT = process.env.PORT || 10087
server.listen(PORT, () => {
  console.log(`Multiplayer server running on ws://localhost:${PORT}`)
})
