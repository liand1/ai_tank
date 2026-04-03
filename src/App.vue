<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const TILE = 16
const BOARD_COLS = 26
const BOARD_ROWS = 26
const HUD_WIDTH = 128
const CANVAS_WIDTH = BOARD_COLS * TILE + HUD_WIDTH
const CANVAS_HEIGHT = BOARD_ROWS * TILE
const PLAYER_SPEED = 1.65
const ENEMY_SPEED = PLAYER_SPEED * 0.175
const BULLET_SPEED = 4.8
const PLAYER_FIRE_COOLDOWN = 260
const ENEMY_FIRE_COOLDOWN = Math.round(((PLAYER_FIRE_COOLDOWN / 0.7) * 2) * 2)
const MAX_PLAYER_BULLETS = 1
const BRICK_HP = 3
const ENEMY_HP = 5
const MP_ENEMY_HP = 3
const PLAYER_HP = 3
const SINGLE_LIVES = 3
const MP_PLAYER_HP = 3
const ENEMY_AGGRO_RANGE = TILE * 20
const BGM_SRC = '/audio/suspense.mp3'
const SFX_EXPLOSION = '/audio/explosion.ogg'
const SFX_POWERUP = '/audio/powerup.ogg'
const POWERUP_DURATION = 30000
const POWERUP_SPAWN_INTERVAL = 12000
const POWERUP_LIFETIME = 10000
const FORTIFY_DURATION = 20000
const BOMB_SPAWN_INTERVAL = 6000
const GAME_TIME = 150000
const MP_GAME_TIME = 180000
const EXTRA_ENEMY_INTERVAL = 50000
const WS_PORT = 10087
const DIRECTIONS = ['up', 'right', 'down', 'left']
const DIRECTION_VECTORS = {
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
}
const COLORS = {
  background: '#12120f',
  board: '#1c1c15',
  hud: '#0f0f0d',
  brick: '#b55239',
  brickDamaged: '#8a3f29',
  steel: '#7c93a4',
  forest: '#2f6b3f',
  water: '#2f5f9b',
  base: '#e0c46c',
  text: '#f1e7c7',
  playerMain: '#f4c542',
  playerAccent: '#7c3b00',
  enemyMain: '#d8d8d8',
  enemyAccent: '#d04a3a',
  bullet: '#f4f4f4',
}

const canvasRef = ref(null)
const statusText = ref('按方向键移动，空格发射，守住基地。')
const mode = ref('single')
const roomInput = ref('')
const roomCode = ref('')
const mpStatus = ref('idle')
const isHost = ref(false)
const localReady = ref(false)
const remoteReady = ref(false)
const stats = ref({
  playerLives: 3,
  player2Lives: 3,
  enemyLeft: 10,
  score: 0,
  killsA: 0,
  killsB: 0,
})

let ctx = null
let animationFrame = 0
let lastTime = 0
let lastEnemySpawn = 0
let lastPowerupSpawn = 0
let enemyDecisionTimer = 0
let mpTime = 0
let gameTime = 0
let state
let bgm = null
let audioUnlocked = false
let ws = null
let remoteControls = {
  up: false,
  down: false,
  left: false,
  right: false,
  fire: false,
}

const controls = {
  up: false,
  down: false,
  left: false,
  right: false,
  fire: false,
}

const mobileHint = computed(() => window.innerWidth < 860)
const isMultiplayer = computed(() => mode.value === 'multi')

const powerupTypes = {
  power: {
    label: '火力',
    color: '#ff7043',
    accent: '#ffd6c8',
    duration: POWERUP_DURATION,
  },
  speed: {
    label: '引擎',
    color: '#29b6f6',
    accent: '#d3f2ff',
    duration: POWERUP_DURATION,
  },
  armor: {
    label: '装甲',
    color: '#66bb6a',
    accent: '#e0f6d5',
    duration: 0,
  },
  fortress: {
    label: '加固',
    color: '#c18f59',
    accent: '#f2d3aa',
    duration: FORTIFY_DURATION,
  },
  bomb: {
    label: '爆破',
    color: '#ff6b35',
    accent: '#ffe0d4',
    duration: 0,
  },
}

function setControl(key, pressed) {
  controls[key] = pressed
  sendInput()
}

function tapAction(key) {
  controls[key] = true
  window.setTimeout(() => {
    controls[key] = false
  }, 90)
  sendInput()
}

function handleRestart() {
  if (state.gameOver) {
    resetState()
  }
}

function tryPlayBgm() {
  if (!bgm) {
    return
  }
  bgm.play().catch(() => {})
}

function playSfx(src, volume = 0.5) {
  if (!audioUnlocked) {
    return
  }
  const sound = new Audio(src)
  sound.volume = volume
  sound.play().catch(() => {})
}

function setupBgm() {
  bgm = new Audio(BGM_SRC)
  bgm.loop = true
  bgm.volume = 0.35

  const unlock = () => {
    audioUnlocked = true
    tryPlayBgm()
  }

  window.addEventListener('pointerdown', unlock, { once: true })
  window.addEventListener('keydown', unlock, { once: true })
}

function getWsUrl() {
  const params = new URLSearchParams(window.location.search)
  const wsParam = params.get('ws')
  if (wsParam) {
    if (wsParam.startsWith('ws://') || wsParam.startsWith('wss://')) {
      return wsParam
    }
    return `ws://${wsParam}`
  }
  return `ws://${window.location.hostname}:${WS_PORT}`
}

function connectWs() {
  if (ws) {
    ws.close()
  }
  ws = new WebSocket(getWsUrl())
  ws.onmessage = (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }

    if (msg.type === 'room_created') {
      roomCode.value = msg.code
      mpStatus.value = 'waiting'
      isHost.value = true
      return
    }

    if (msg.type === 'room_joined') {
      roomCode.value = msg.code
      mpStatus.value = 'waiting'
      isHost.value = false
      return
    }

    if (msg.type === 'join_error') {
      statusText.value = msg.message || '加入失败。'
      return
    }

    if (msg.type === 'room_status') {
      mpStatus.value = msg.status
      return
    }

    if (msg.type === 'ready_state') {
      localReady.value = isHost.value ? msg.ready.host : msg.ready.guest
      remoteReady.value = isHost.value ? msg.ready.guest : msg.ready.host
      return
    }

    if (msg.type === 'start') {
      mpStatus.value = 'playing'
      startMultiplayer()
      return
    }

    if (msg.type === 'state' && !isHost.value) {
      state = msg.state
      return
    }

    if (msg.type === 'input' && isHost.value) {
      remoteControls = { ...remoteControls, ...msg.controls }
      return
    }

    if (msg.type === 'end') {
      mpStatus.value = 'ended'
      statusText.value = msg.winner === 'host'
        ? '对手退出，你获胜。'
        : msg.winner === 'guest'
          ? '对手获胜。'
          : '游戏结束。'
    }
  }
}

function selectMode(nextMode) {
  mode.value = nextMode
  resetState()
  mpStatus.value = 'idle'
  roomCode.value = ''
  roomInput.value = ''
  localReady.value = false
  remoteReady.value = false
  isHost.value = false
  if (ws) {
    ws.close()
    ws = null
  }
}

function createRoom() {
  if (!roomInput.value.trim()) {
    statusText.value = '请输入房间号。'
    return
  }
  connectWs()
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'create', code: roomInput.value.trim().toUpperCase() }))
  }, { once: true })
}

function joinRoom() {
  if (!roomInput.value.trim()) {
    statusText.value = '请输入房间号。'
    return
  }
  connectWs()
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', code: roomInput.value.trim().toUpperCase() }))
  }, { once: true })
}

function setReady(value) {
  localReady.value = value
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ready', value }))
  }
}

function sendInput() {
  if (!ws || ws.readyState !== WebSocket.OPEN || isHost.value || mpStatus.value !== 'playing') {
    return
  }
  ws.send(JSON.stringify({ type: 'input', controls }))
}

function sendStateToGuest() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !isHost.value || mpStatus.value !== 'playing') {
    return
  }
  ws.send(JSON.stringify({ type: 'state', state }))
}

function startMultiplayer() {
  resetState()
  if (isHost.value) {
    state.player2 = createPlayer()
    state.player2.kind = 'player2'
    state.player2.x = 12 * TILE
    state.player2.y = 2 * TILE
    state.player2.colorMain = '#9bd2ff'
    state.player2.colorAccent = '#2b6cb0'
    state.baseA = null
    state.baseB = null
    state.enemyQueue = 0
    state.enemies = []
  }
}


function createBrickRect(col, row, width = 1, height = 1) {
  return {
    x: col * TILE,
    y: row * TILE,
    w: width * TILE,
    h: height * TILE,
    type: 'brick',
    hp: BRICK_HP,
    maxHp: BRICK_HP,
  }
}

function createBrickCluster(col, row, width = 1, height = 1) {
  const bricks = []

  for (let offsetY = 0; offsetY < height; offsetY += 1) {
    for (let offsetX = 0; offsetX < width; offsetX += 1) {
      bricks.push(createBrickRect(col + offsetX, row + offsetY))
    }
  }

  return bricks
}

function createSteelRect(col, row, width = 1, height = 1) {
  return {
    x: col * TILE,
    y: row * TILE,
    w: width * TILE,
    h: height * TILE,
    type: 'steel',
    hp: Infinity,
  }
}

function createForestRect(col, row, width = 1, height = 1) {
  return {
    x: col * TILE,
    y: row * TILE,
    w: width * TILE,
    h: height * TILE,
    type: 'forest',
    hp: Infinity,
  }
}

function createWaterRect(col, row, width = 1, height = 1) {
  return {
    x: col * TILE,
    y: row * TILE,
    w: width * TILE,
    h: height * TILE,
    type: 'water',
    hp: Infinity,
  }
}

function createFortressRect(col, row) {
  return {
    x: col * TILE,
    y: row * TILE,
    w: TILE,
    h: TILE,
    type: 'fortress',
    hp: Infinity,
  }
}

function createMap(options = {}) {
  const { random = false, preserveBaseRing = false } = options
  const map = []

  if (!random) {
    ;[
      [2, 3, 4, 2],
      [20, 3, 4, 2],
      [6, 8, 3, 3],
      [17, 8, 3, 3],
      [3, 14, 4, 2],
      [19, 14, 4, 2],
      [8, 18, 10, 2],
      [10, 21, 2, 1],
      [14, 21, 2, 1],
    ].forEach(([c, r, w, h]) => map.push(...createBrickCluster(c, r, w, h)))

    ;[
      [11, 5, 4, 2],
      [0, 10, 2, 4],
      [24, 10, 2, 4],
      [11, 11, 4, 1],
      [11, 23, 1, 2],
      [14, 23, 1, 2],
    ].forEach(([c, r, w, h]) => map.push(createSteelRect(c, r, w, h)))

    ;[
      [9, 3, 2, 2],
      [15, 3, 2, 2],
      [5, 11, 4, 2],
      [17, 11, 4, 2],
      [8, 15, 2, 2],
      [16, 15, 2, 2],
    ].forEach(([c, r, w, h]) => map.push(createForestRect(c, r, w, h)))

    ;[
      [11, 15, 4, 2],
      [2, 19, 4, 2],
      [20, 19, 4, 2],
    ].forEach(([c, r, w, h]) => map.push(createWaterRect(c, r, w, h)))

    return map
  }

  const reserved = []
  const addReservedRect = (col, row, width, height) => {
    reserved.push({ x: col * TILE, y: row * TILE, w: width * TILE, h: height * TILE })
  }
  const isOverlapping = (rect, list) => list.some((item) => rectsOverlap(rect, item))

  if (preserveBaseRing) {
    const baseCol = 12
    const baseRow = 24
    addReservedRect(baseCol - 1, baseRow - 1, 4, 4)
  }
  addReservedRect(11, 21, 4, 3)
  addReservedRect(11, 1, 4, 3)
  addReservedRect(0, 0, 2, 2)
  addReservedRect(24, 0, 2, 2)

  const tryPlace = (factory, minW, maxW, minH, maxH, count) => {
    for (let i = 0; i < count; i += 1) {
      let placed = false
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const width = minW + Math.floor(Math.random() * (maxW - minW + 1))
        const height = minH + Math.floor(Math.random() * (maxH - minH + 1))
        const col = Math.floor(Math.random() * (BOARD_COLS - width))
        const row = Math.floor(Math.random() * (BOARD_ROWS - height))
        const rect = { x: col * TILE, y: row * TILE, w: width * TILE, h: height * TILE }
        if (isOverlapping(rect, reserved)) {
          continue
        }
        const items = factory(col, row, width, height)
        const list = Array.isArray(items) ? items : [items]
        if (list.some((item) => isOverlapping(item, map))) {
          continue
        }
        map.push(...list)
        placed = true
        break
      }
      if (!placed) {
        continue
      }
    }
  }

  const makeCluster = (col, row, width, height) => createBrickCluster(col, row, width, height)

  tryPlace(makeCluster, 2, 3, 1, 2, 18)
  tryPlace(createSteelRect, 1, 2, 1, 2, 8)
  tryPlace(createForestRect, 2, 3, 1, 2, 8)
  tryPlace(createWaterRect, 2, 3, 1, 2, 6)

  return map
}

function createPlayer(isMultiplayerMode = false) {
  return {
    kind: 'player',
    x: 12 * TILE,
    y: 22 * TILE,
    size: 14,
    renderSize: 15,
    dir: 'up',
    speed: PLAYER_SPEED,
    hp: isMultiplayerMode ? MP_PLAYER_HP : PLAYER_HP,
    maxHp: isMultiplayerMode ? MP_PLAYER_HP : PLAYER_HP,
    colorMain: COLORS.playerMain,
    colorAccent: COLORS.playerAccent,
    fireCooldown: 0,
    alive: true,
    spawnShield: 1400,
    buffs: {
      powerUntil: 0,
      speedUntil: 0,
      armorActive: false,
    },
  }
}

function createEnemy(spawnX, spawnY = 0, hpOverride = null) {
  const hpValue = hpOverride ?? ENEMY_HP
  return {
    kind: 'enemy',
    x: spawnX,
    y: spawnY,
    size: 14,
    renderSize: 15,
    dir: 'down',
    speed: ENEMY_SPEED,
    hp: hpValue,
    maxHp: hpValue,
    colorMain: COLORS.enemyMain,
    colorAccent: COLORS.enemyAccent,
    fireCooldown: ENEMY_FIRE_COOLDOWN * (0.35 + Math.random() * 0.5),
    alive: true,
    lastDir: 'down',
    aiTurnIn: 500 + Math.random() * 1200,
    spawnShield: 800,
    targetKind: null,
  }
}

function resetState() {
  state = {
    player: createPlayer(isMultiplayer.value),
    enemies: [],
    bullets: [],
    particles: [],
    powerups: [],
    obstacles: createMap({ random: true, preserveBaseRing: !isMultiplayer.value }),
    fortress: {
      until: 0,
      obstacles: [],
    },
    bombSpawnSlow: false,
    base: mode.value === 'single'
        ? {
            x: 12 * TILE,
            y: 24 * TILE,
            w: 2 * TILE,
            h: 2 * TILE,
            alive: true,
          }
        : null,
    enemyQueue: 10,
    extraEnemiesSpawned: 0,
    gameOver: false,
    victory: false,
  }
  if (!isMultiplayer.value) {
    addBaseBrickRing()
  }
  stats.value = {
    playerLives: isMultiplayer.value ? 3 : SINGLE_LIVES,
    player2Lives: 3,
    enemyLeft: state.enemyQueue,
    score: 0,
    killsA: 0,
    killsB: 0,
  }
  statusText.value = '按方向键移动，空格发射，守住基地。'
  lastEnemySpawn = 0
  lastPowerupSpawn = 0
  enemyDecisionTimer = 0
  mpTime = 0
  gameTime = 0
}

function rectsOverlap(a, b) {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  )
}

function tankRect(tank, x = tank.x, y = tank.y) {
  return { x, y, w: tank.size, h: tank.size }
}

function bulletRect(bullet) {
  return { x: bullet.x - 2, y: bullet.y - 2, w: 4, h: 4 }
}

function itemRect(item) {
  return { x: item.x, y: item.y, w: item.size, h: item.size }
}

function rgba(hexColor, alpha) {
  const r = Number.parseInt(hexColor.slice(1, 3), 16)
  const g = Number.parseInt(hexColor.slice(3, 5), 16)
  const b = Number.parseInt(hexColor.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function darkenColor(hexColor, amount) {
  const r = Math.max(0, Number.parseInt(hexColor.slice(1, 3), 16) - amount)
  const g = Math.max(0, Number.parseInt(hexColor.slice(3, 5), 16) - amount)
  const b = Math.max(0, Number.parseInt(hexColor.slice(5, 7), 16) - amount)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

function isBlocked(rect, ignoreTank) {
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.w > BOARD_COLS * TILE ||
    rect.y + rect.h > BOARD_ROWS * TILE
  ) {
    return true
  }

  for (const obstacle of state.obstacles) {
    if (obstacle.type === 'forest') {
      continue
    }
    if (rectsOverlap(rect, obstacle)) {
      return true
    }
  }

  if (state.base && state.base.alive && rectsOverlap(rect, state.base)) {
    return true
  }
  if (state.baseA && state.baseA.alive && rectsOverlap(rect, state.baseA)) {
    return true
  }
  if (state.baseB && state.baseB.alive && rectsOverlap(rect, state.baseB)) {
    return true
  }

  const tanks = [state.player, ...(state.player2 ? [state.player2] : []), ...state.enemies]
  for (const tank of tanks) {
    if (!tank.alive || tank === ignoreTank) {
      continue
    }
    if (rectsOverlap(rect, tankRect(tank))) {
      return true
    }
  }

  return false
}

function isAreaOpen(rect) {
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.w > BOARD_COLS * TILE ||
    rect.y + rect.h > BOARD_ROWS * TILE
  ) {
    return false
  }

  for (const obstacle of state.obstacles) {
    if (rectsOverlap(rect, obstacle)) {
      return false
    }
  }

  if (state.base && state.base.alive && rectsOverlap(rect, state.base)) {
    return false
  }
  if (state.baseA && state.baseA.alive && rectsOverlap(rect, state.baseA)) {
    return false
  }
  if (state.baseB && state.baseB.alive && rectsOverlap(rect, state.baseB)) {
    return false
  }

  if (rectsOverlap(rect, tankRect(state.player))) {
    return false
  }

  for (const enemy of state.enemies) {
    if (enemy.alive && rectsOverlap(rect, tankRect(enemy))) {
      return false
    }
  }

  for (const item of state.powerups) {
    if (rectsOverlap(rect, itemRect(item))) {
      return false
    }
  }

  return true
}

function getPlayerDamage() {
  return state.player.buffs.powerUntil > 0 ? 3 : 1
}

function getPlayerSpeedMultiplier() {
  return state.player.buffs.speedUntil > 0 ? 2 : 1
}

function createPowerup(type, x, y) {
  return {
    type,
    x,
    y,
    size: 14,
    life: POWERUP_LIFETIME,
  }
}

function addBaseFortress() {
  if (!state.base) {
    return
  }
  const baseCol = Math.round(state.base.x / TILE)
  const baseRow = Math.round(state.base.y / TILE)
  const ring = []
  for (let r = baseRow - 1; r <= baseRow + 2; r += 1) {
    for (let c = baseCol - 1; c <= baseCol + 2; c += 1) {
      if (r < 0 || r >= BOARD_ROWS || c < 0 || c >= BOARD_COLS) {
        continue
      }
      const insideBase = c >= baseCol && c <= baseCol + 1 && r >= baseRow && r <= baseRow + 1
      if (insideBase) {
        continue
      }
      ring.push(createFortressRect(c, r))
    }
  }
  state.obstacles.push(...ring)
  state.fortress.obstacles = ring
  state.fortress.until = FORTIFY_DURATION
}

function addBaseBrickRing() {
  if (!state.base) {
    return
  }
  const baseCol = Math.round(state.base.x / TILE)
  const baseRow = Math.round(state.base.y / TILE)
  state.obstacles = state.obstacles.filter((obstacle) => {
    if (obstacle.type !== 'steel') {
      return true
    }
    const col = Math.round(obstacle.x / TILE)
    const row = Math.round(obstacle.y / TILE)
    const inRing = col >= baseCol - 1 && col <= baseCol + 2 && row >= baseRow - 1 && row <= baseRow + 2
    return !inRing
  })
  const ring = []
  for (let r = baseRow - 1; r <= baseRow + 2; r += 1) {
    for (let c = baseCol - 1; c <= baseCol + 2; c += 1) {
      if (r < 0 || r >= BOARD_ROWS || c < 0 || c >= BOARD_COLS) {
        continue
      }
      const insideBase = c >= baseCol && c <= baseCol + 1 && r >= baseRow && r <= baseRow + 1
      if (insideBase) {
        continue
      }
        const brick = createBrickRect(c, r)
        brick.canBeDestroyed = true
        ring.push(brick)
    }
  }
  state.obstacles.push(...ring)
}

function spawnPowerup(now) {
  if (now - lastPowerupSpawn < POWERUP_SPAWN_INTERVAL || state.powerups.length >= 1) {
    return
  }

  const candidates = []
  for (let row = 2; row < BOARD_ROWS - 2; row += 1) {
    for (let col = 1; col < BOARD_COLS - 1; col += 1) {
      const rect = { x: col * TILE + 1, y: row * TILE + 1, w: 14, h: 14 }
      if (isAreaOpen(rect)) {
        candidates.push({ x: rect.x, y: rect.y })
      }
    }
  }

  if (candidates.length === 0) {
    return
  }

  const types = isMultiplayer.value
    ? ['power', 'speed', 'armor']
    : ['power', 'speed', 'armor', 'fortress', 'bomb']
  const spot = candidates[Math.floor(Math.random() * candidates.length)]
  const type = types[Math.floor(Math.random() * types.length)]
  state.powerups.push(createPowerup(type, spot.x, spot.y))
  lastPowerupSpawn = now
}

function applyPowerup(type, tank = state.player, now = 0) {
  playSfx(SFX_POWERUP, 0.45)
  if (type === 'power') {
    tank.buffs.powerUntil = POWERUP_DURATION
    statusText.value = '拿到火力徽章，30 秒内两炮击毁敌军。'
    return
  }

  if (type === 'speed') {
    tank.buffs.speedUntil = POWERUP_DURATION
    statusText.value = '拿到引擎徽章，30 秒内移动速度翻倍。'
    return
  }

  if (type === 'bomb' && !isMultiplayer.value) {
    for (const enemy of state.enemies) {
      if (!enemy.alive) {
        continue
      }
      enemy.alive = false
      explode(enemy.x + enemy.size / 2, enemy.y + enemy.size / 2, COLORS.enemyAccent)
    }
    state.bombSpawnSlow = true
    lastEnemySpawn = now
    stats.value.enemyLeft = state.enemyQueue + state.enemies.filter((enemy) => enemy.alive).length
    statusText.value = '爆破炸弹引爆，全屏敌军清除。'
    return
  }

  tank.buffs.armorActive = true
  tank.maxHp = 6
  tank.hp = Math.max(tank.hp, 6)
  statusText.value = '拿到装甲徽章，这条命需要 6 发炮弹才会被击毁。'
  if (type === 'fortress' && !isMultiplayer.value) {
    addBaseFortress()
    statusText.value = '总部加固，20 秒铜墙铁壁。'
  }
}

function updatePowerups(deltaMs, now) {
  spawnPowerup(now)

  for (const item of state.powerups) {
    item.life -= deltaMs
    if (rectsOverlap(itemRect(item), tankRect(state.player))) {
      item.life = 0
      applyPowerup(item.type, state.player, now)
    } else if (state.player2 && rectsOverlap(itemRect(item), tankRect(state.player2))) {
      item.life = 0
      applyPowerup(item.type, state.player2, now)
    }
  }

  state.powerups = state.powerups.filter((item) => item.life > 0)

  state.player.buffs.powerUntil = Math.max(0, state.player.buffs.powerUntil - deltaMs)
  state.player.buffs.speedUntil = Math.max(0, state.player.buffs.speedUntil - deltaMs)

  if (state.fortress.until > 0) {
    state.fortress.until = Math.max(0, state.fortress.until - deltaMs)
    if (state.fortress.until === 0 && state.fortress.obstacles.length) {
      state.obstacles = state.obstacles.filter((item) => !state.fortress.obstacles.includes(item))
      state.fortress.obstacles = []
    }
  }
}

function getEnemyAttackDirection(enemy, player) {
  const tolerance = 10
  const enemyCenterX = enemy.x + enemy.size / 2
  const enemyCenterY = enemy.y + enemy.size / 2
  const targetWidth = player.size ?? player.w
  const targetHeight = player.size ?? player.h
  const playerCenterX = player.x + targetWidth / 2
  const playerCenterY = player.y + targetHeight / 2

  if (Math.abs(enemyCenterX - playerCenterX) <= tolerance) {
    const top = Math.min(enemyCenterY, playerCenterY)
    const bottom = Math.max(enemyCenterY, playerCenterY)
    const lane = {
      x: enemyCenterX - 3,
      y: top,
      w: 6,
      h: Math.max(1, bottom - top),
    }

    const blocked = state.obstacles.some((obstacle) => {
      if (obstacle.type === 'forest') {
        return false
      }
      return rectsOverlap(lane, obstacle)
    })

    if (!blocked) {
      return playerCenterY < enemyCenterY ? 'up' : 'down'
    }
  }

  if (Math.abs(enemyCenterY - playerCenterY) <= tolerance) {
    const left = Math.min(enemyCenterX, playerCenterX)
    const right = Math.max(enemyCenterX, playerCenterX)
    const lane = {
      x: left,
      y: enemyCenterY - 3,
      w: Math.max(1, right - left),
      h: 6,
    }

    const blocked = state.obstacles.some((obstacle) => {
      if (obstacle.type === 'forest') {
        return false
      }
      return rectsOverlap(lane, obstacle)
    })

    if (!blocked) {
      return playerCenterX < enemyCenterX ? 'left' : 'right'
    }
  }

  return null
}

function getOppositeDirection(direction) {
  switch (direction) {
    case 'up':
      return 'down'
    case 'down':
      return 'up'
    case 'left':
      return 'right'
    case 'right':
      return 'left'
    default:
      return direction
  }
}

function getPassableDirections(enemy) {
  return DIRECTIONS.filter((dir) => {
    const vector = DIRECTION_VECTORS[dir]
    const probe = tankRect(
      enemy,
      enemy.x + vector.x * enemy.speed * 6,
      enemy.y + vector.y * enemy.speed * 6,
    )
    return !isBlocked(probe, enemy)
  })
}

function tryMoveTank(tank, distance) {
  const vector = DIRECTION_VECTORS[tank.dir]
  const nextX = tank.x + vector.x * distance
  const nextY = tank.y + vector.y * distance
  const nextRect = tankRect(tank, nextX, nextY)

  if (!isBlocked(nextRect, tank)) {
    tank.x = nextX
    tank.y = nextY
  }
}

function moveTankStepwise(tank, distance) {
  let remaining = distance
  const step = 1
  while (remaining > 0.0001) {
    const delta = Math.min(step, remaining)
    const beforeX = tank.x
    const beforeY = tank.y
    tryMoveTank(tank, delta)
    if (tank.x === beforeX && tank.y === beforeY) {
      break
    }
    remaining -= delta
  }
}

function fireBullet(owner) {
  const activeBullets = state.bullets.filter((bullet) => bullet.owner === owner.kind)
  if ((owner.kind === 'player' || owner.kind === 'player2') && activeBullets.length >= MAX_PLAYER_BULLETS) {
    return
  }

  const vector = DIRECTION_VECTORS[owner.dir]
  const hasPowerBuff = owner.kind === 'player'
    ? state.player.buffs.powerUntil > 0
    : owner.kind === 'player2'
      ? state.player2?.buffs.powerUntil > 0
      : false
  
  state.bullets.push({
    owner: owner.kind,
    x: owner.x + owner.size / 2 + vector.x * (owner.size / 2),
    y: owner.y + owner.size / 2 + vector.y * (owner.size / 2),
    dir: owner.dir,
    speed: BULLET_SPEED,
    damage: owner.kind === 'player' ? getPlayerDamage() : 1,
    alive: true,
    burning: hasPowerBuff,
    trail: [],
  })
  owner.fireCooldown = owner.kind === 'enemy' ? ENEMY_FIRE_COOLDOWN : PLAYER_FIRE_COOLDOWN
}

function handleTankInput(tank, controlSet, deltaMs, trackMoving) {
  if (!tank || !tank.alive || state.gameOver) {
    return
  }

  const speedMultiplier = tank === state.player ? getPlayerSpeedMultiplier() : 1
  const distance = tank.speed * speedMultiplier * (deltaMs / 16.67)
  const useStepMove = !isMultiplayer.value && tank === state.player && speedMultiplier > 1

  if (controlSet.up) {
    tank.dir = 'up'
    useStepMove ? moveTankStepwise(tank, distance) : tryMoveTank(tank, distance)
  } else if (controlSet.down) {
    tank.dir = 'down'
    useStepMove ? moveTankStepwise(tank, distance) : tryMoveTank(tank, distance)
  } else if (controlSet.left) {
    tank.dir = 'left'
    useStepMove ? moveTankStepwise(tank, distance) : tryMoveTank(tank, distance)
  } else if (controlSet.right) {
    tank.dir = 'right'
    useStepMove ? moveTankStepwise(tank, distance) : tryMoveTank(tank, distance)
  }

  if (controlSet.fire && tank.fireCooldown <= 0) {
    fireBullet(tank)
  }
}

function spawnEnemy(now) {
  const aliveCount = state.enemies.filter((enemy) => enemy.alive).length
  if (isMultiplayer.value) {
    if (aliveCount >= 2) {
      return
    }
  } else {
    const maxEnemies = 2 + Math.floor(gameTime / 30000)
    if (state.enemyQueue <= 0 && aliveCount === 0) {
      state.enemyQueue = 10
    }
    if (state.enemyQueue <= 0 || aliveCount >= maxEnemies) {
      return
    }
  }
  if (!isMultiplayer.value) {
    const interval = state.bombSpawnSlow ? BOMB_SPAWN_INTERVAL : 1800
    if (now - lastEnemySpawn < interval) {
      return
    }
  }

  let spawnX = null
  let spawnY = null

  if (isMultiplayer.value) {
    for (let tries = 0; tries < 20; tries += 1) {
      const sideX = Math.random() > 0.5 ? 0 : 24 * TILE
      const row = Math.floor(Math.random() * BOARD_ROWS)
      const candidateY = row * TILE
      const probe = { x: sideX, y: candidateY, w: 14, h: 14 }
      if (!isBlocked(probe)) {
        spawnX = sideX
        spawnY = candidateY
        break
      }
    }
  } else {
    const spawnPoints = [0, 12 * TILE, 24 * TILE]
    const available = spawnPoints.filter((x) => {
      const probe = { x, y: 0, w: 14, h: 14 }
      return !isBlocked(probe)
    })
    if (available.length) {
      spawnX = available[Math.floor(Math.random() * available.length)]
      spawnY = 0
    }
  }

  if (spawnX === null) {
    return
  }

  state.enemies.push(createEnemy(spawnX, spawnY, isMultiplayer.value ? MP_ENEMY_HP : null))
  if (!isMultiplayer.value) {
    state.enemyQueue -= 1
    if (state.bombSpawnSlow) {
      const maxEnemies = 2 + Math.floor(gameTime / 30000)
      const afterSpawnCount = aliveCount + 1
      if (afterSpawnCount >= maxEnemies) {
        state.bombSpawnSlow = false
      }
    }
  }
  stats.value.enemyLeft = state.enemyQueue + state.enemies.filter((enemy) => enemy.alive).length
  lastEnemySpawn = now
}

function getEnemyTarget(enemy) {
    if (!isMultiplayer.value || !state.player2) {
      const baseAlive = state.base && state.base.alive
      if (!enemy.targetKind || enemy.aiTurnIn <= 0 || (enemy.targetKind === 'base' && !baseAlive)) {
        enemy.targetKind = baseAlive && Math.random() < 1 / 2 ? 'base' : 'player'
      }
      return enemy.targetKind === 'base' && baseAlive ? state.base : state.player
    }

  if (!enemy.targetKind) {
    const targetCounts = { player: 0, player2: 0 }
    for (const e of state.enemies) {
      if (!e.alive) continue
      if (e.targetKind === 'player') targetCounts.player += 1
      if (e.targetKind === 'player2') targetCounts.player2 += 1
    }
    enemy.targetKind = targetCounts.player <= targetCounts.player2 ? 'player' : 'player2'
  }

  return enemy.targetKind === 'player2' ? state.player2 : state.player
}

function spawnExtraEnemy(now) {
  if (gameTime >= GAME_TIME) {
    return
  }
  
  const extraEnemyCount = Math.floor(gameTime / EXTRA_ENEMY_INTERVAL)
  if (extraEnemyCount <= state.extraEnemiesSpawned) {
    return
  }
  
  if (state.enemies.filter((enemy) => enemy.alive).length >= 2) {
    return
  }

  let spawnX = null
  const spawnPoints = [0, 12 * TILE, 24 * TILE]
  const available = spawnPoints.filter((x) => {
    const probe = { x, y: 0, w: 14, h: 14 }
    return !isBlocked(probe)
  })

  if (available.length === 0) {
    return
  }

  spawnX = available[Math.floor(Math.random() * available.length)]
  state.enemies.push(createEnemy(spawnX, 0))
  state.extraEnemiesSpawned += 1
  statusText.value = '敌军增援到达！'
}

function chooseEnemyDirection(enemy) {
  const player = getEnemyTarget(enemy)
  const passable = getPassableDirections(enemy)
  if (passable.length === 0) {
    return
  }

  const opposite = getOppositeDirection(enemy.lastDir)
  let bestDir = passable[0]
  let bestScore = -Infinity

  for (const dir of passable) {
    const vector = DIRECTION_VECTORS[dir]
    const nextX = enemy.x + vector.x * TILE * 1.5
    const nextY = enemy.y + vector.y * TILE * 1.5
    const distanceScore = -Math.hypot(player.x - nextX, player.y - nextY)
    const horizontalBias = Math.abs(player.x - enemy.x) > Math.abs(player.y - enemy.y)
    const preferredDir = horizontalBias
      ? (player.x > enemy.x ? 'right' : 'left')
      : (player.y > enemy.y ? 'down' : 'up')
    const preferredScore = dir === preferredDir ? 24 : 0
    const sightScore = getEnemyAttackDirection(
      { ...enemy, x: nextX, y: nextY },
      player,
    )
      ? 36
      : 0
    const reversePenalty = dir === opposite ? -18 : 0
    const keepMovingBonus = dir === enemy.lastDir ? 8 : 0
    const score = distanceScore + preferredScore + sightScore + reversePenalty + keepMovingBonus

    if (score > bestScore) {
      bestScore = score
      bestDir = dir
    }
  }

  enemy.dir = bestDir
  enemy.lastDir = bestDir
}

function updateEnemies(deltaMs, now) {
  enemyDecisionTimer += deltaMs

  if (isMultiplayer.value) {
    while (state.enemies.filter((enemy) => enemy.alive).length < 2) {
      spawnEnemy(now)
    }
  }

  for (const enemy of state.enemies) {
    if (!enemy.alive) {
      continue
    }

    enemy.aiTurnIn -= deltaMs
    enemy.fireCooldown -= deltaMs
    enemy.spawnShield = Math.max(0, enemy.spawnShield - deltaMs)

    const target = getEnemyTarget(enemy)
    const distanceToPlayer = Math.hypot(target.x - enemy.x, target.y - enemy.y)
    const playerNearby = distanceToPlayer <= ENEMY_AGGRO_RANGE

    if (playerNearby) {
      enemy.aiTurnIn -= deltaMs * 1.8
    }

    if (enemy.aiTurnIn <= 0 || enemyDecisionTimer > 420) {
      chooseEnemyDirection(enemy)
      enemy.aiTurnIn = playerNearby ? 180 + Math.random() * 260 : 400 + Math.random() * 900
    }

    const distance = (playerNearby ? enemy.speed * 1.2 : enemy.speed) * (deltaMs / 16.67)
    const oldX = enemy.x
    const oldY = enemy.y
    tryMoveTank(enemy, distance)

    if (oldX === enemy.x && oldY === enemy.y) {
      chooseEnemyDirection(enemy)
    } else {
      enemy.lastDir = enemy.dir
    }

    if (enemy.fireCooldown <= 0) {
      const lockDir = getEnemyAttackDirection(enemy, target)

      if (lockDir) {
        enemy.dir = lockDir
        fireBullet(enemy)
      } else if (playerNearby && Math.random() > 0.55) {
        chooseEnemyDirection(enemy)
        fireBullet(enemy)
      } else if (Math.random() > 0.985) {
        fireBullet(enemy)
      }
    }
  }

  if (enemyDecisionTimer > 420) {
    enemyDecisionTimer = 0
  }

  spawnEnemy(now)
}

  function damageTank(tank, damage, attackerKind = null) {
  if (!tank.alive) {
    return
  }

  tank.hp -= damage
  if (tank.hp > 0) {
    explode(tank.x + tank.size / 2, tank.y + tank.size / 2, tank.colorAccent)
    if (tank.kind === 'enemy') {
      statusText.value = `敌军坦克剩余 ${tank.hp} 点耐久。`
    }
    return
  }

  tank.alive = false
  playSfx(SFX_EXPLOSION, 0.6)
  explode(tank.x + tank.size / 2, tank.y + tank.size / 2, tank.colorMain)

      if (tank.kind === 'enemy') {
        stats.value.score += 100
        stats.value.enemyLeft = state.enemyQueue + state.enemies.filter((enemy) => enemy.alive).length
        } else {
      if (tank.hp > 0) {
        statusText.value = `我方坦克剩余 ${tank.hp} 点耐久。`
      } else if (tank.kind === 'player2') {
        if (!isMultiplayer.value) {
          stats.value.player2Lives -= 1
        }
        if (isMultiplayer.value) {
          stats.value.killsA += 1
          if (stats.value.killsA >= 10) {
            state.gameOver = true
            statusText.value = '黄色坦克 10 次击杀，获胜！'
            if (isHost.value) {
              ws?.readyState === WebSocket.OPEN &&
                ws.send(JSON.stringify({ type: 'end', winner: 'host' }))
            }
          }
        }
        if (isMultiplayer.value) {
          const respawn = createPlayer(true)
          respawn.kind = 'player2'
          respawn.x = 12 * TILE
          respawn.y = 2 * TILE
          respawn.colorMain = '#9bd2ff'
          respawn.colorAccent = '#2b6cb0'
          state.player2 = respawn
          statusText.value = '蓝色坦克被击毁，已复活。'
        } else if (stats.value.player2Lives > 0) {
          const respawn = createPlayer(false)
          respawn.kind = 'player2'
          respawn.x = 12 * TILE
          respawn.y = 2 * TILE
          respawn.colorMain = '#9bd2ff'
          respawn.colorAccent = '#2b6cb0'
          state.player2 = respawn
          statusText.value = `蓝色坦克被击毁，剩余生命 ${stats.value.player2Lives}。`
        } else {
          state.gameOver = true
          statusText.value = '蓝色坦克耗尽生命，游戏结束。'
        }
      } else {
        if (!isMultiplayer.value) {
          stats.value.playerLives -= 1
        }
        if (isMultiplayer.value) {
          stats.value.killsB += 1
          if (stats.value.killsB >= 10) {
            state.gameOver = true
            statusText.value = '蓝色坦克 10 次击杀，获胜！'
            if (isHost.value) {
              ws?.readyState === WebSocket.OPEN &&
                ws.send(JSON.stringify({ type: 'end', winner: 'guest' }))
            }
          }
        }
        if (isMultiplayer.value) {
          state.player = createPlayer(true)
          statusText.value = '黄色坦克被击毁，已复活。'
        } else if (stats.value.playerLives > 0) {
          state.player = createPlayer(false)
          statusText.value = `你被击毁了，剩余生命 ${stats.value.playerLives}。`
        } else {
          state.gameOver = true
          statusText.value = '游戏结束，基地失守前你已耗尽生命。按 Enter 重新开始。'
        }
      }
    }
  }

function damageObstacle(obstacle) {
  if (obstacle.type !== 'brick' && !obstacle.canBeDestroyed) {
    return false
  }

  obstacle.hp -= 1
  if (obstacle.hp <= 0) {
    state.obstacles = state.obstacles.filter((item) => item !== obstacle)
  }
  return true
}

function explode(x, y, color) {
  for (let i = 0; i < 8; i += 1) {
    state.particles.push({
      x,
      y,
      life: 300 + Math.random() * 220,
      age: 0,
      vx: (Math.random() - 0.5) * 2.8,
      vy: (Math.random() - 0.5) * 2.8,
      color,
    })
  }
}

function updateBullets(deltaMs) {
  const step = BULLET_SPEED * (deltaMs / 16.67)

  for (const bullet of state.bullets) {
    if (!bullet.alive) {
      continue
    }

    const vector = DIRECTION_VECTORS[bullet.dir]
    bullet.x += vector.x * step
    bullet.y += vector.y * step
    bullet.trail.push({ x: bullet.x, y: bullet.y })
    if (bullet.trail.length > 8) {
      bullet.trail.shift()
    }

    const rect = bulletRect(bullet)
    if (
      rect.x < 0 ||
      rect.y < 0 ||
      rect.x + rect.w > BOARD_COLS * TILE ||
      rect.y + rect.h > BOARD_ROWS * TILE
    ) {
      bullet.alive = false
      continue
    }

    for (const obstacle of state.obstacles) {
      if (obstacle.type === 'forest' || obstacle.type === 'water') {
        continue
      }
      if (rectsOverlap(rect, obstacle)) {
        if (damageObstacle(obstacle)) {
          explode(bullet.x, bullet.y, COLORS.brick)
          if (obstacle.hp > 0) {
            statusText.value = `砖块还需要 ${obstacle.hp} 发炮弹。`
          }
        } else {
          explode(bullet.x, bullet.y, COLORS.steel)
        }
        bullet.alive = false
        break
      }
    }

    if (!bullet.alive) {
      continue
    }

    if (state.base && state.base.alive && rectsOverlap(rect, state.base)) {
      state.base.alive = false
      bullet.alive = false
      explode(state.base.x + TILE, state.base.y + TILE, COLORS.base)
      if (!isMultiplayer.value) {
        state.gameOver = true
        state.victory = false
        statusText.value = '总部被摧毁，失败。按 Enter 重新开始。'
      } else {
        statusText.value = '总部被摧毁。'
      }
      continue
    }

    if (state.baseA && state.baseA.alive && rectsOverlap(rect, state.baseA)) {
      state.baseA.alive = false
      bullet.alive = false
      explode(state.baseA.x + TILE, state.baseA.y + TILE, COLORS.base)
      continue
    }

    if (state.baseB && state.baseB.alive && rectsOverlap(rect, state.baseB)) {
      state.baseB.alive = false
      bullet.alive = false
      explode(state.baseB.x + TILE, state.baseB.y + TILE, COLORS.base)
      continue
    }

    let targets = []
    if (isMultiplayer.value && state.player2) {
      if (bullet.owner === 'player') targets = [state.player2, ...state.enemies]
      else if (bullet.owner === 'player2') targets = [state.player, ...state.enemies]
      else if (bullet.owner === 'enemy') targets = [state.player, state.player2]
    } else {
      targets = bullet.owner === 'player' ? state.enemies : [state.player]
    }
    for (const target of targets) {
      if (!target.alive || target.spawnShield > 0) {
        continue
      }
      if (rectsOverlap(rect, tankRect(target))) {
        bullet.alive = false
        damageTank(target, bullet.damage, bullet.owner)
        break
      }
    }
  }

  for (let i = 0; i < state.bullets.length; i += 1) {
    const bulletA = state.bullets[i]
    if (!bulletA.alive) {
      continue
    }
    for (let j = i + 1; j < state.bullets.length; j += 1) {
      const bulletB = state.bullets[j]
      if (!bulletB.alive || bulletA.owner === bulletB.owner) {
        continue
      }
      if (rectsOverlap(bulletRect(bulletA), bulletRect(bulletB))) {
        bulletA.alive = false
        bulletB.alive = false
        explode((bulletA.x + bulletB.x) / 2, (bulletA.y + bulletB.y) / 2, COLORS.bullet)
      }
    }
  }

  state.bullets = state.bullets.filter((bullet) => bullet.alive)
}

function updateParticles(deltaMs) {
  for (const particle of state.particles) {
    particle.age += deltaMs
    particle.x += particle.vx * (deltaMs / 16.67)
    particle.y += particle.vy * (deltaMs / 16.67)
  }
  state.particles = state.particles.filter((particle) => particle.age < particle.life)
}

function tick(now) {
  const deltaMs = Math.min(now - lastTime || 16.67, 33.34)
  lastTime = now

      if (!state.gameOver) {
        if (isMultiplayer.value) {
          mpTime += deltaMs
          if (mpTime >= MP_GAME_TIME && !state.gameOver) {
            state.gameOver = true
            const winner =
              stats.value.killsA === stats.value.killsB
                ? 'draw'
                : stats.value.killsA > stats.value.killsB
                  ? 'host'
                  : 'guest'
            statusText.value = winner === 'draw'
              ? '时间到，平局。'
              : winner === 'host'
                ? '时间到，你获胜！'
                : '时间到，你失败。'
            if (isMultiplayer.value && isHost.value) {
              ws?.readyState === WebSocket.OPEN &&
                ws.send(JSON.stringify({ type: 'end', winner }))
            }
          }
        } else {
          gameTime += deltaMs
          if (gameTime >= GAME_TIME && !state.victory) {
            state.gameOver = true
            state.victory = true
            statusText.value = '时间到！你成功守住了基地。按 Enter 重新开始。'
          }
        }

        if (!isMultiplayer.value || isHost.value) {
          state.player.fireCooldown -= deltaMs
          if (isMultiplayer.value && state.player2) {
            state.player2.fireCooldown -= deltaMs
            state.player2.spawnShield = Math.max(0, state.player2.spawnShield - deltaMs)
          }
          state.player.spawnShield = Math.max(0, state.player.spawnShield - deltaMs)

        if (isMultiplayer.value) {
          handleTankInput(state.player, controls, deltaMs, true)
          handleTankInput(state.player2, remoteControls, deltaMs, false)
        } else {
          handleTankInput(state.player, controls, deltaMs, true)
        }
        updateEnemies(deltaMs, now)
        updatePowerups(deltaMs, now)
        updateBullets(deltaMs)
        updateParticles(deltaMs)
        if (isMultiplayer.value) {
          sendStateToGuest()
        }
      }
    } else {
      updatePowerups(deltaMs, now)
      updateParticles(deltaMs)
    }

  drawScene()
  animationFrame = requestAnimationFrame(tick)
}

function drawTileRect(x, y, w, h, color, accent) {
  ctx.fillStyle = color
  ctx.fillRect(x, y, w, h)
  if (!accent) {
    return
  }

  ctx.fillStyle = accent
  for (let row = 0; row < h; row += 8) {
    ctx.fillRect(x, y + row, w, 2)
  }
}

function drawTank(tank) {
  if (!tank.alive) {
    return
  }

  const { x, y, size, dir } = tank
  const renderSize = tank.renderSize ?? size
  const renderOffset = (size - renderSize) / 2
  const renderScale = renderSize / size
  ctx.save()
  ctx.translate(x + size / 2, y + size / 2)
  ctx.scale(renderScale, renderScale)
  const angleMap = { up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 }
  ctx.rotate(angleMap[dir])
  ctx.translate(-size / 2, -size / 2)

  // 履带部分 - 两侧
  ctx.fillStyle = '#2a2a2a'
  ctx.fillRect(0, 0, 4, size)
  ctx.fillRect(size - 4, 0, 4, size)
  
  // 履带纹理
  ctx.fillStyle = '#1a1a1a'
  for (let i = 0; i < size; i += 3) {
    ctx.fillRect(1, i, 2, 1.5)
    ctx.fillRect(size - 3, i, 2, 1.5)
  }

  // 车身主体
  ctx.fillStyle = tank.colorMain
  ctx.fillRect(4, 2, size - 8, size - 4)
  
  // 车身装饰线条
  ctx.fillStyle = tank.colorAccent
  ctx.fillRect(5, 3, size - 10, size - 6)
  
  // 车体细节 - 前部装甲
  ctx.fillStyle = rgba(tank.colorMain, 0.7)
  ctx.fillRect(5, 2, size - 10, 4)

  // 炮塔基座
  ctx.fillStyle = darkenColor(tank.colorMain, 20)
  ctx.fillRect(size / 2 - 3, size / 2 - 3, 6, 6)

  // 主炮管
  ctx.fillStyle = '#3a3a3a'
  ctx.fillRect(size / 2 - 2, -2, 4, size / 2 + 2)
  
  // 炮管高光
  ctx.fillStyle = '#5a5a5a'
  ctx.fillRect(size / 2 - 1, -1, 2, size / 2)

  // 炮塔顶部
  ctx.fillStyle = tank.colorAccent
  ctx.fillRect(size / 2 - 2.5, size / 2 - 2.5, 5, 5)
  
  // 炮塔细节
  ctx.fillStyle = rgba(tank.colorMain, 0.8)
  ctx.fillRect(size / 2 - 1.5, size / 2 - 1.5, 3, 3)

  ctx.restore()

  // 生命条
    if (tank.kind === 'player' || tank.kind === 'player2') {
      const hpRatio = tank.hp / tank.maxHp
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
      ctx.fillRect(x + renderOffset - 1, y + renderOffset - 7, renderSize + 2, 4)
      const armorActive = tank.buffs?.armorActive
      ctx.fillStyle = armorActive ? '#4ade80' : tank.kind === 'player2' ? '#60a5fa' : '#fbbf24'
      ctx.fillRect(x + renderOffset, y + renderOffset - 6, renderSize * hpRatio, 2)
      
      // 能量效果（如果有增益）
      if (tank.buffs?.powerUntil > 0) {
        ctx.strokeStyle = 'rgba(255, 112, 67, 0.6)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(x + renderOffset + renderSize / 2, y + renderOffset + renderSize / 2, renderSize / 2 + 2, 0, Math.PI * 2)
        ctx.stroke()
      }
      if (tank.buffs?.speedUntil > 0) {
        ctx.strokeStyle = 'rgba(41, 182, 246, 0.5)'
        ctx.lineWidth = 1
        ctx.beginPath()
      ctx.arc(x + renderOffset + renderSize / 2, y + renderOffset + renderSize / 2, renderSize / 2 + 3, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  if (tank.kind === 'enemy') {
    const hpRatio = tank.hp / tank.maxHp
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
    ctx.fillRect(x + renderOffset - 1, y + renderOffset - 7, renderSize + 2, 4)
    ctx.fillStyle = '#ef4444'
    ctx.fillRect(x + renderOffset, y + renderOffset - 6, renderSize * hpRatio, 2)
  }

  // 出生护盾
  if (tank.spawnShield > 0) {
    const alpha = 0.4 + 0.4 * Math.sin(Date.now() / 100)
    ctx.strokeStyle = `rgba(100, 200, 255, ${alpha})`
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(x + renderOffset + renderSize / 2, y + renderOffset + renderSize / 2, renderSize / 2 + 5, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function drawPowerup(item) {
  const meta = powerupTypes[item.type]
  const centerX = item.x + item.size / 2
  const centerY = item.y + item.size / 2

  ctx.fillStyle = rgba(meta.color, 0.2)
  ctx.beginPath()
  ctx.arc(centerX, centerY, 11, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = meta.color
  ctx.fillRect(item.x, item.y, item.size, item.size)
  ctx.fillStyle = meta.accent

  if (item.type === 'power') {
    ctx.beginPath()
    ctx.moveTo(centerX + 1, item.y + 1)
    ctx.lineTo(centerX - 3, centerY)
    ctx.lineTo(centerX + 1, centerY)
    ctx.lineTo(centerX - 1, item.y + item.size - 1)
    ctx.lineTo(centerX + 4, centerY + 1)
    ctx.lineTo(centerX, centerY + 1)
    ctx.closePath()
    ctx.fill()
    return
  }

  if (item.type === 'speed') {
    ctx.beginPath()
    ctx.arc(centerX, centerY, 4.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillRect(centerX + 3, centerY - 1, 4, 2)
    ctx.fillRect(centerX - 7, centerY - 1, 3, 2)
    return
  }

  ctx.fillRect(centerX - 4, centerY - 5, 8, 10)
  ctx.fillRect(centerX - 1, centerY - 8, 2, 16)
}

function drawScene() {
  if (!ctx) {
    return
  }

  ctx.fillStyle = COLORS.background
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)

  ctx.fillStyle = COLORS.board
  ctx.fillRect(0, 0, BOARD_COLS * TILE, CANVAS_HEIGHT)

  ctx.fillStyle = 'rgba(255,255,255,0.03)'
  for (let i = 0; i < BOARD_ROWS; i += 1) {
    ctx.fillRect(0, i * TILE, BOARD_COLS * TILE, 1)
  }

  for (const obstacle of state.obstacles) {
    if (obstacle.type === 'brick') {
      const damageLevel = obstacle.maxHp - obstacle.hp
      const brickColor = damageLevel > 0 ? COLORS.brickDamaged : COLORS.brick
      const accent = obstacle.hp === 1 ? '#f1b18f' : '#d48357'
      drawTileRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h, brickColor, accent)
    } else if (obstacle.type === 'fortress') {
      drawTileRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h, '#b27a3f', '#f0d9b5')
    } else if (obstacle.type === 'steel') {
      drawTileRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h, COLORS.steel, '#c8d3dd')
    } else if (obstacle.type === 'water') {
      drawTileRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h, COLORS.water, '#75a5e6')
    }
  }

    if (state.base && state.base.alive) {
      drawTileRect(state.base.x, state.base.y, state.base.w, state.base.h, COLORS.base, '#f2db87')
      ctx.fillStyle = '#573500'
      ctx.fillRect(state.base.x + 9, state.base.y + 9, 14, 14)
    }

  state.powerups.forEach(drawPowerup)

  for (const bullet of state.bullets) {
    if (!bullet.trail || bullet.trail.length < 2) {
      continue
    }
    for (let i = 0; i < bullet.trail.length; i += 1) {
      const point = bullet.trail[i]
      const alpha = (i + 1) / bullet.trail.length
      ctx.fillStyle = `rgba(244, 244, 244, ${alpha * 0.45})`
      ctx.fillRect(point.x - 1, point.y - 1, 2, 2)
    }
  }
  drawTank(state.player)
  if (state.player2) {
    drawTank(state.player2)
  }
  state.enemies.forEach(drawTank)

  for (const obstacle of state.obstacles) {
    if (obstacle.type === 'forest') {
      drawTileRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h, COLORS.forest, '#72b15e')
    }
  }

  ctx.fillStyle = COLORS.bullet
  for (const bullet of state.bullets) {
    if (bullet.burning) {
      // 燃烧效果的炮弹 - 核心
      const gradient = ctx.createRadialGradient(bullet.x, bullet.y, 0, bullet.x, bullet.y, 6)
      gradient.addColorStop(0, '#fff7e6')
      gradient.addColorStop(0.3, '#ff9500')
      gradient.addColorStop(0.7, '#ff4500')
      gradient.addColorStop(1, 'rgba(255, 69, 0, 0)')
      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.arc(bullet.x, bullet.y, 6, 0, Math.PI * 2)
      ctx.fill()
      
      // 燃烧尾迹粒子
      if (Math.random() < 0.6) {
        state.particles.push({
          x: bullet.x,
          y: bullet.y,
          life: 180 + Math.random() * 100,
          age: 0,
          vx: (Math.random() - 0.5) * 0.8 - DIRECTION_VECTORS[bullet.dir].x * 1.5,
          vy: (Math.random() - 0.5) * 0.8 - DIRECTION_VECTORS[bullet.dir].y * 1.5,
          color: ['#ff6b35', '#ff8c42', '#ffa94d', '#ffd43b'][Math.floor(Math.random() * 4)],
          size: 2 + Math.random() * 2,
        })
      }
    } else {
      ctx.fillRect(bullet.x - 2, bullet.y - 2, 4, 4)
    }
  }

  for (const particle of state.particles) {
    const alpha = 1 - particle.age / particle.life
    ctx.fillStyle = rgba(particle.color, alpha)
    const size = particle.size || 3
    ctx.fillRect(particle.x - size / 2, particle.y - size / 2, size, size)
  }

  ctx.fillStyle = COLORS.hud
  ctx.fillRect(BOARD_COLS * TILE, 0, HUD_WIDTH, CANVAS_HEIGHT)

  ctx.fillStyle = COLORS.text
  ctx.font = 'bold 16px monospace'
  ctx.fillText('TANK', BOARD_COLS * TILE + 24, 40)
  ctx.fillText('90', BOARD_COLS * TILE + 36, 60)

  ctx.font = '14px monospace'
  ctx.fillText(`TIME ${Math.max(0, Math.ceil((GAME_TIME - gameTime) / 1000))}`, BOARD_COLS * TILE + 18, 96)
  ctx.fillText(`LIFE ${isMultiplayer.value ? '∞' : stats.value.playerLives}`, BOARD_COLS * TILE + 18, 120)
  ctx.fillText(`HP ${state.player.hp}`, BOARD_COLS * TILE + 18, 142)
  if (state.player2) {
    ctx.fillText(`P2 ${isMultiplayer.value ? '∞' : stats.value.player2Lives}`, BOARD_COLS * TILE + 18, 164)
  }
  ctx.fillText(`LEFT ${stats.value.enemyLeft}`, BOARD_COLS * TILE + 18, 186)
  if (isMultiplayer.value) {
    ctx.fillText(`K ${stats.value.killsA}-${stats.value.killsB}`, BOARD_COLS * TILE + 18, 208)
  }
  ctx.fillText('SCORE', BOARD_COLS * TILE + 18, 230)
  ctx.fillText(`${stats.value.score}`, BOARD_COLS * TILE + 18, 252)
  ctx.fillText(`P ${state.player.buffs.powerUntil > 0 ? Math.ceil(state.player.buffs.powerUntil / 1000) : 0}`, BOARD_COLS * TILE + 18, 252)
  ctx.fillText(`S ${state.player.buffs.speedUntil > 0 ? Math.ceil(state.player.buffs.speedUntil / 1000) : 0}`, BOARD_COLS * TILE + 18, 274)
  ctx.fillText('MOVE', BOARD_COLS * TILE + 18, 292)
  ctx.fillText('ARROWS', BOARD_COLS * TILE + 18, 314)
  ctx.fillText('FIRE', BOARD_COLS * TILE + 18, 354)
  ctx.fillText('SPACE', BOARD_COLS * TILE + 18, 376)

  if (state.gameOver) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.52)'
    ctx.fillRect(48, 144, 320, 112)
    ctx.fillStyle = COLORS.text
    ctx.font = 'bold 24px monospace'
    ctx.fillText(state.victory ? 'YOU WIN' : 'GAME OVER', 100, 188)
    ctx.font = '14px monospace'
    ctx.fillText('PRESS ENTER TO RESTART', 84, 220)
  }
}

function keyFromEvent(event) {
  switch (event.code) {
    case 'ArrowUp':
      return 'up'
    case 'ArrowDown':
      return 'down'
    case 'ArrowLeft':
      return 'left'
    case 'ArrowRight':
      return 'right'
    case 'Space':
      return 'fire'
    default:
      return null
  }
}

function handleKeyDown(event) {
  const key = keyFromEvent(event)
  if (key) {
    event.preventDefault()
    controls[key] = true
    sendInput()
    return
  }

  if (event.code === 'Enter' && state.gameOver) {
    resetState()
  }
}

function handleKeyUp(event) {
  const key = keyFromEvent(event)
  if (!key) {
    return
  }
  event.preventDefault()
  controls[key] = false
  sendInput()
}

onMounted(() => {
  const canvas = canvasRef.value
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT
  ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false

  resetState()
  setupBgm()
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
  animationFrame = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animationFrame)
  if (bgm) {
    bgm.pause()
    bgm = null
  }
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
})
</script>

<template>
  <main class="page-shell">
    <section class="title-block">
      <p class="eyebrow">Vue + Canvas</p>
      <h1>红白机风格坦克大战</h1>
      <p class="subtitle">{{ statusText }}</p>
      <div class="mode-switch">
        <button class="mode-btn" :class="{ active: mode === 'single' }" @click="selectMode('single')">
          单机模式
        </button>
        <button class="mode-btn" :class="{ active: mode === 'multi' }" @click="selectMode('multi')">
          联机对战
        </button>
      </div>

      <div v-if="mode === 'multi'" class="room-panel">
        <div v-if="!roomCode" class="room-actions">
          <button class="room-btn" @click="createRoom">创建房间</button>
          <div class="room-join">
            <input v-model="roomInput" placeholder="房间号" />
            <button class="room-btn" @click="joinRoom">加入</button>
          </div>
        </div>
        <div v-else class="room-status">
          <p>房间号：{{ roomCode }}</p>
          <p>状态：{{ mpStatus }}</p>
          <p>准备：你 {{ localReady ? '已准备' : '未准备' }} / 对方 {{ remoteReady ? '已准备' : '未准备' }}</p>
          <button class="room-btn" @click="setReady(!localReady)">
            {{ localReady ? '取消准备' : '准备' }}
          </button>
        </div>
      </div>
      <p v-if="mobileHint" class="mobile-tip">
        建议用桌面端体验，当前版本按键控制为方向键移动、空格开火。
      </p>
    </section>

    <section class="game-frame">
      <canvas ref="canvasRef" class="game-canvas"></canvas>
    </section>

    <section v-if="mobileHint" class="touch-controls">
      <div class="touch-pad">
        <button
          class="touch-btn touch-up"
          @touchstart.prevent="setControl('up', true)"
          @touchend.prevent="setControl('up', false)"
          @touchcancel.prevent="setControl('up', false)"
          @mousedown.prevent="setControl('up', true)"
          @mouseup.prevent="setControl('up', false)"
          @mouseleave.prevent="setControl('up', false)"
        >
          ↑
        </button>
        <button
          class="touch-btn touch-left"
          @touchstart.prevent="setControl('left', true)"
          @touchend.prevent="setControl('left', false)"
          @touchcancel.prevent="setControl('left', false)"
          @mousedown.prevent="setControl('left', true)"
          @mouseup.prevent="setControl('left', false)"
          @mouseleave.prevent="setControl('left', false)"
        >
          ←
        </button>
        <button
          class="touch-btn touch-down"
          @touchstart.prevent="setControl('down', true)"
          @touchend.prevent="setControl('down', false)"
          @touchcancel.prevent="setControl('down', false)"
          @mousedown.prevent="setControl('down', true)"
          @mouseup.prevent="setControl('down', false)"
          @mouseleave.prevent="setControl('down', false)"
        >
          ↓
        </button>
        <button
          class="touch-btn touch-right"
          @touchstart.prevent="setControl('right', true)"
          @touchend.prevent="setControl('right', false)"
          @touchcancel.prevent="setControl('right', false)"
          @mousedown.prevent="setControl('right', true)"
          @mouseup.prevent="setControl('right', false)"
          @mouseleave.prevent="setControl('right', false)"
        >
          →
        </button>
      </div>

      <div class="action-pad">
        <button
          class="touch-btn touch-fire"
          @touchstart.prevent="tapAction('fire')"
          @mousedown.prevent="tapAction('fire')"
        >
          开火
        </button>
        <button
          class="touch-btn touch-restart"
          @touchstart.prevent="handleRestart"
          @mousedown.prevent="handleRestart"
        >
          重开
        </button>
      </div>
    </section>
  </main>
</template>
