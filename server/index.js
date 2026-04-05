import http from 'http'
import { WebSocketServer } from 'ws'

const server = http.createServer()
const wss = new WebSocketServer({ server })

const rooms = new Map()

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
