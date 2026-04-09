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
  background: '#1a1a1a',
  board: '#1f1f1f',
  roadEdge: '#2a2a2a',
  roadLine: '#3a3a3a',
  roadDust: '#8f8f8f',
  hud: '#101010',
  brick: '#b35a3f',
  brickDamaged: '#8f3f2f',
  steel: '#8c8c8c',
  forest: '#4c7a3f',
  water: '#1890ff',
  base: '#f7d51d',
  text: '#ffffff',
  playerMain: '#52c41a',
  playerAccent: '#2c7a0b',
  enemyMain: '#ff4d4f',
  enemyAccent: '#8f2022',
  bullet: '#ffffff',
}
const PIXEL_FONT = "'Press Start 2P', 'Pixel Operator', 'VT323', monospace"

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

const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36)

function getReportBase() {
  const wsUrl = getWsUrl()
  try {
    const url = new URL(wsUrl)
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    return url.origin
  } catch {
    return ''
  }
}

function trackSession(action, nextMode = mode.value) {
  const base = getReportBase()
  if (!base) {
    return
  }
  const payload = { sessionId, mode: nextMode, action }
  if (action === 'leave' && navigator.sendBeacon) {
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
    navigator.sendBeacon(`${base}/track`, blob)
    return
  }
  fetch(`${base}/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {})
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

const joystickBaseRef = ref(null)
const joystickActive = ref(false)
const joystickVector = ref({ x: 0, y: 0 })

function resetJoystick() {
  joystickActive.value = false
  joystickVector.value = { x: 0, y: 0 }
  controls.up = false
  controls.down = false
  controls.left = false
  controls.right = false
  sendInput()
}

function updateJoystickDirection() {
  const { x, y } = joystickVector.value
  const distance = Math.hypot(x, y)
  if (distance < 0.2) {
    controls.up = false
    controls.down = false
    controls.left = false
    controls.right = false
    sendInput()
    return
  }
  if (Math.abs(x) > Math.abs(y)) {
    controls.left = x < 0
    controls.right = x > 0
    controls.up = false
    controls.down = false
  } else {
    controls.up = y < 0
    controls.down = y > 0
    controls.left = false
    controls.right = false
  }
  sendInput()
}

function handleJoystickPointer(event) {
  if (!joystickBaseRef.value) {
    return
  }
  const rect = joystickBaseRef.value.getBoundingClientRect()
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2
  const rawX = event.clientX - centerX
  const rawY = event.clientY - centerY
  const radius = rect.width * 0.35
  const distance = Math.hypot(rawX, rawY) || 1
  const clamped = Math.min(distance, radius)
  joystickVector.value = {
    x: (rawX / distance) * (clamped / radius),
    y: (rawY / distance) * (clamped / radius),
  }
  updateJoystickDirection()
}

function onJoystickStart(event) {
  joystickActive.value = true
  handleJoystickPointer(event)
}

function onJoystickMove(event) {
  if (!joystickActive.value) {
    return
  }
  handleJoystickPointer(event)
}

function onJoystickEnd() {
  resetJoystick()
}

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
  if (mode.value !== nextMode) {
    trackSession('mode', nextMode)
  }
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

  const patternLibrary = [
    (c, r) => [
      ...createBrickCluster(c, r, 4, 1),
      ...createBrickCluster(c, r + 3, 4, 1),
    ],
    (c, r) => [
      ...createBrickCluster(c, r, 1, 4),
      ...createBrickCluster(c + 3, r, 1, 4),
    ],
    (c, r) => [
      ...createBrickCluster(c, r, 2, 2),
      ...createBrickCluster(c + 2, r + 2, 2, 2),
    ],
    (c, r) => [
      createSteelRect(c + 1, r, 2, 1),
      createSteelRect(c + 1, r + 3, 2, 1),
      createSteelRect(c, r + 1, 1, 2),
      createSteelRect(c + 3, r + 1, 1, 2),
    ],
    (c, r) => [
      createForestRect(c, r, 2, 2),
      createForestRect(c + 2, r + 2, 2, 2),
    ],
    (c, r) => [
      createWaterRect(c + 1, r, 2, 2),
      createWaterRect(c + 1, r + 2, 2, 2),
    ],
    (c, r) => [
      ...createBrickCluster(c, r + 1, 4, 2),
      createSteelRect(c + 1, r, 2, 1),
    ],
    (c, r) => [
      createForestRect(c, r, 4, 1),
      createForestRect(c, r + 3, 4, 1),
      ...createBrickCluster(c + 1, r + 1, 2, 2),
    ],
  ]

  const slots = [
    [2, 3],
    [8, 3],
    [16, 3],
    [20, 3],
    [2, 9],
    [8, 9],
    [16, 9],
    [20, 9],
    [2, 15],
    [8, 15],
    [16, 15],
    [20, 15],
  ]

  const shuffled = [...slots].sort(() => Math.random() - 0.5)
  for (const [col, row] of shuffled) {
    const slotRect = { x: col * TILE, y: row * TILE, w: 4 * TILE, h: 4 * TILE }
    if (isOverlapping(slotRect, reserved) || isOverlapping(slotRect, map)) {
      continue
    }
    const pattern = patternLibrary[Math.floor(Math.random() * patternLibrary.length)]
    const items = pattern(col, row)
    if (items.some((item) => isOverlapping(item, reserved) || isOverlapping(item, map))) {
      continue
    }
    map.push(...items)
  }

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
    recoil: 0,
    muzzleFlash: 0,
    treadOffset: 0,
    isMoving: false,
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
    recoil: 0,
    muzzleFlash: 0,
    treadOffset: 0,
    isMoving: false,
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

  const barrier = []
  const barrierTop = baseRow - 4
  const barrierBottom = baseRow - 3
  const barrierCols = [baseCol - 1, baseCol, baseCol + 1, baseCol + 2]
  const addBarrierRow = (row, useSteelEdges) => {
    if (row < 0) {
      return
    }
    barrierCols.forEach((col, index) => {
      if (col < 0 || col >= BOARD_COLS) {
        return
      }
      if (useSteelEdges && (index === 0 || index === barrierCols.length - 1)) {
        barrier.push(createSteelRect(col, row, 1, 1))
      } else {
        const block = createBrickRect(col, row)
        block.canBeDestroyed = true
        barrier.push(block)
      }
    })
  }
  addBarrierRow(barrierTop, true)
  addBarrierRow(barrierBottom, false)
  state.obstacles.push(...barrier)

  const centerCol = 11
  const centerRow = 12
  if (centerRow >= 0 && centerRow + 1 < BOARD_ROWS) {
    const centerBricks = createBrickCluster(centerCol, centerRow, 4, 2)
    centerBricks.forEach((brick) => {
      brick.canBeDestroyed = true
    })
    state.obstacles.push(...centerBricks)
  }
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
    return true
  }
  return false
}

function updateTankMotionFx(tank, moved, deltaMs) {
  tank.isMoving = moved
  if (moved) {
    tank.treadOffset = (tank.treadOffset + deltaMs * 0.18) % 3
  }
  tank.recoil = Math.max(0, tank.recoil - deltaMs * 0.018)
  tank.muzzleFlash = Math.max(0, tank.muzzleFlash - deltaMs)
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
  owner.recoil = 2.4
  owner.muzzleFlash = 85
  owner.fireCooldown = owner.kind === 'enemy' ? ENEMY_FIRE_COOLDOWN : PLAYER_FIRE_COOLDOWN
}

function handleTankInput(tank, controlSet, deltaMs, trackMoving) {
  if (!tank || !tank.alive || state.gameOver) {
    if (tank) {
      updateTankMotionFx(tank, false, deltaMs)
    }
    return
  }

  const speedMultiplier = tank === state.player ? getPlayerSpeedMultiplier() : 1
  const distance = tank.speed * speedMultiplier * (deltaMs / 16.67)
  const useStepMove = !isMultiplayer.value && tank === state.player && speedMultiplier > 1
  let moved = false

  const move = (direction) => {
    tank.dir = direction
    if (useStepMove) {
      const beforeX = tank.x
      const beforeY = tank.y
      moveTankStepwise(tank, distance)
      moved = tank.x !== beforeX || tank.y !== beforeY
      return
    }
    moved = tryMoveTank(tank, distance)
  }

  if (controlSet.up) {
    move('up')
  } else if (controlSet.down) {
    move('down')
  } else if (controlSet.left) {
    move('left')
  } else if (controlSet.right) {
    move('right')
  }
  if (trackMoving) {
    updateTankMotionFx(tank, moved, deltaMs)
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
    const distanceToPlayer = Math.hypot(state.player.x - enemy.x, state.player.y - enemy.y)
    if (distanceToPlayer <= ENEMY_AGGRO_RANGE * 0.65 || !baseAlive) {
      enemy.targetKind = 'player'
    } else {
      enemy.targetKind = 'base'
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
  const horizontalBias = Math.abs(player.x - enemy.x) > Math.abs(player.y - enemy.y)
  const preferredDir = horizontalBias
      ? (player.x > enemy.x ? 'right' : 'left')
      : (player.y > enemy.y ? 'down' : 'up')
  const preferredBlocked = !passable.includes(preferredDir)
  let bestDir = passable[0]
  let bestScore = -Infinity

  for (const dir of passable) {
    const vector = DIRECTION_VECTORS[dir]
    const nextX = enemy.x + vector.x * TILE * 1.5
    const nextY = enemy.y + vector.y * TILE * 1.5
    const distanceScore = -Math.hypot(player.x - nextX, player.y - nextY)
    const preferredScore = dir === preferredDir ? 24 : 0
    const sightScore = getEnemyAttackDirection(
        { ...enemy, x: nextX, y: nextY },
        player,
    )
        ? 36
        : 0
    const reversePenalty = dir === opposite ? -18 : 0
    const keepMovingBonus = dir === enemy.lastDir ? 8 : 0
    const detourBonus = preferredBlocked && dir !== opposite ? 10 : 0
    const score = distanceScore + preferredScore + sightScore + reversePenalty + keepMovingBonus + detourBonus

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
    const moved = tryMoveTank(enemy, distance)
    updateTankMotionFx(enemy, moved, deltaMs)

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
  const px = Math.floor(x)
  const py = Math.floor(y)
  const pw = Math.floor(w)
  const ph = Math.floor(h)

  ctx.fillStyle = color
  ctx.fillRect(px, py, pw, ph)

  if (accent) {
    ctx.fillStyle = accent
    for (let row = 0; row < ph; row += 4) {
      for (let col = (row / 4) % 2 === 0 ? 0 : 2; col < pw; col += 4) {
        ctx.fillRect(px + col, py + row, 2, 2)
      }
    }
  }

  ctx.fillStyle = 'rgba(0, 0, 0, 0.25)'
  ctx.fillRect(px, py + ph - 2, pw, 2)
  ctx.fillRect(px + pw - 2, py, 2, ph)
}

function drawTank(tank) {
  if (!tank.alive) {
    return
  }

  const x = Math.floor(tank.x)
  const y = Math.floor(tank.y)
  const { size, dir } = tank
  const renderSize = tank.renderSize ?? size
  const renderOffset = (size - renderSize) / 2
  const renderScale = renderSize / size
  const recoilVector = DIRECTION_VECTORS[dir]

  ctx.save()
  ctx.translate(x + size / 2, y + size / 2)
  ctx.translate(-recoilVector.x * tank.recoil, -recoilVector.y * tank.recoil)
  ctx.scale(renderScale, renderScale)
  const angleMap = { up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 }
  ctx.rotate(angleMap[dir])
  ctx.translate(-size / 2, -size / 2)

  ctx.fillStyle = '#1f1f1f'
  ctx.fillRect(0, 0, 4, size)
  ctx.fillRect(size - 4, 0, 4, size)

  ctx.fillStyle = '#444'
  for (let i = -tank.treadOffset; i < size; i += 4) {
    ctx.fillRect(1, i, 2, 2)
    ctx.fillRect(size - 3, i, 2, 2)
  }

  ctx.fillStyle = tank.colorMain
  ctx.fillRect(4, 2, size - 8, size - 4)
  ctx.fillStyle = tank.colorAccent
  ctx.fillRect(5, 5, size - 10, size - 10)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(5, 3, size - 10, 2)

  ctx.fillStyle = darkenColor(tank.colorMain, 24)
  ctx.fillRect(size / 2 - 3, size / 2 - 3, 6, 6)

  ctx.fillStyle = '#2b2b2b'
  ctx.fillRect(size / 2 - 2, -2, 4, size / 2 + 2)
  ctx.fillStyle = '#a0a0a0'
  ctx.fillRect(size / 2 - 1, -1, 2, size / 2)

  ctx.restore()

  if (tank.muzzleFlash > 0) {
    const frontX = Math.floor(x + size / 2 + recoilVector.x * (size / 2 + 4))
    const frontY = Math.floor(y + size / 2 + recoilVector.y * (size / 2 + 4))
    ctx.fillStyle = '#f7d51d'
    ctx.fillRect(frontX - 2, frontY - 2, 5, 5)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(frontX - 1, frontY - 1, 3, 3)
  }

  if (tank.isMoving && Math.random() < 0.12) {
    const dustX = x + size / 2 - recoilVector.x * (size / 2 - 1) + (Math.random() - 0.5) * 4
    const dustY = y + size / 2 - recoilVector.y * (size / 2 - 1) + (Math.random() - 0.5) * 4
    state.particles.push({
      x: dustX,
      y: dustY,
      life: 180 + Math.random() * 120,
      age: 0,
      vx: (Math.random() - 0.5) * 0.55 - recoilVector.x * 0.45,
      vy: (Math.random() - 0.5) * 0.55 - recoilVector.y * 0.45,
      color: COLORS.roadDust,
      size: 1.5 + Math.random() * 1.5,
    })
  }

  if (tank.kind === 'player' || tank.kind === 'player2') {
    const hpRatio = tank.hp / tank.maxHp
    ctx.fillStyle = '#000000'
    ctx.fillRect(x + renderOffset - 1, y + renderOffset - 7, renderSize + 2, 4)
    const armorActive = tank.buffs?.armorActive
    ctx.fillStyle = armorActive ? '#52c41a' : tank.kind === 'player2' ? '#1890ff' : '#f7d51d'
    ctx.fillRect(x + renderOffset, y + renderOffset - 6, Math.floor(renderSize * hpRatio), 2)

    if (tank.buffs?.powerUntil > 0 && Math.floor(lastTime / 160) % 2 === 0) {
      ctx.strokeStyle = '#ff4d4f'
      ctx.strokeRect(x + renderOffset - 2, y + renderOffset - 2, renderSize + 4, renderSize + 4)
    }
    if (tank.buffs?.speedUntil > 0 && Math.floor(lastTime / 220) % 2 === 0) {
      ctx.strokeStyle = '#1890ff'
      ctx.strokeRect(x + renderOffset - 3, y + renderOffset - 3, renderSize + 6, renderSize + 6)
    }
  }

  if (tank.kind === 'enemy') {
    const hpRatio = tank.hp / tank.maxHp
    ctx.fillStyle = '#000000'
    ctx.fillRect(x + renderOffset - 1, y + renderOffset - 7, renderSize + 2, 4)
    ctx.fillStyle = '#ff4d4f'
    ctx.fillRect(x + renderOffset, y + renderOffset - 6, Math.floor(renderSize * hpRatio), 2)
  }

  if (tank.spawnShield > 0) {
    if (Math.floor(lastTime / 120) % 2 === 0) {
      ctx.strokeStyle = '#ffffff'
      ctx.strokeRect(x + renderOffset - 4, y + renderOffset - 4, renderSize + 8, renderSize + 8)
    }
  }
}

function drawPowerup(item) {
  const meta = powerupTypes[item.type]
  const x = Math.floor(item.x)
  const y = Math.floor(item.y)
  const size = Math.floor(item.size)
  const centerX = x + size / 2
  const centerY = y + size / 2
  const blink = Math.floor(lastTime / 150) % 2 === 0

  ctx.fillStyle = '#000000'
  ctx.fillRect(x - 1, y - 1, size + 2, size + 2)
  ctx.fillStyle = meta.color
  ctx.fillRect(x, y, size, size)
  ctx.fillStyle = blink ? '#ffffff' : meta.accent

  if (item.type === 'power') {
    ctx.fillRect(centerX - 1, y + 2, 2, size - 4)
    ctx.fillRect(centerX - 3, centerY - 1, 6, 2)
    return
  }

  if (item.type === 'speed') {
    ctx.fillRect(centerX - 3, centerY - 3, 6, 6)
    ctx.fillRect(centerX + 3, centerY - 1, 4, 2)
    ctx.fillRect(centerX - 7, centerY - 1, 3, 2)
    return
  }

  ctx.fillRect(centerX - 4, centerY - 5, 8, 2)
  ctx.fillRect(centerX - 4, centerY + 3, 8, 2)
  ctx.fillRect(centerX - 1, centerY - 8, 2, 16)
}

function drawScene() {
  if (!ctx) {
    return
  }

  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = COLORS.background
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)

  const boardWidth = BOARD_COLS * TILE
  ctx.fillStyle = COLORS.board
  ctx.fillRect(0, 0, boardWidth, CANVAS_HEIGHT)

  for (let row = 0; row < BOARD_ROWS; row += 1) {
    for (let col = 0; col < BOARD_COLS; col += 1) {
      const tileX = col * TILE
      const tileY = row * TILE
      ctx.fillStyle = (col + row) % 2 === 0 ? '#222222' : '#252525'
      ctx.fillRect(tileX, tileY, TILE, TILE)
      ctx.fillStyle = '#2d2d2d'
      ctx.fillRect(tileX, tileY, TILE, 1)
      ctx.fillRect(tileX, tileY, 1, TILE)
    }
  }

  ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)'
  ctx.lineWidth = 1
  for (let x = 0; x <= boardWidth; x += TILE) {
    ctx.beginPath()
    ctx.moveTo(x + 0.5, 0)
    ctx.lineTo(x + 0.5, CANVAS_HEIGHT)
    ctx.stroke()
  }
  for (let y = 0; y <= CANVAS_HEIGHT; y += TILE) {
    ctx.beginPath()
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(boardWidth, y + 0.5)
    ctx.stroke()
  }

  for (const obstacle of state.obstacles) {
    if (obstacle.type === 'brick') {
      const damageLevel = obstacle.maxHp - obstacle.hp
      const brickColor = damageLevel > 0 ? COLORS.brickDamaged : COLORS.brick
      const accent = obstacle.hp === 1 ? '#f7c7a8' : '#d08a6a'
      drawTileRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h, brickColor, accent)
    } else if (obstacle.type === 'fortress') {
      drawTileRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h, '#8c8c8c', '#bfbfbf')
    } else if (obstacle.type === 'steel') {
      drawTileRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h, COLORS.steel, '#bfbfbf')
    } else if (obstacle.type === 'water') {
      const waveColor = Math.floor(lastTime / 200) % 2 === 0 ? '#7fc8ff' : '#4da7ff'
      drawTileRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h, COLORS.water, waveColor)
    }
  }

  if (state.base && state.base.alive) {
    drawTileRect(state.base.x, state.base.y, state.base.w, state.base.h, COLORS.base, '#fff3a0')
    ctx.fillStyle = '#5a4500'
    ctx.fillRect(state.base.x + 10, state.base.y + 8, 12, 14)
    ctx.fillStyle = '#fff3a0'
    ctx.fillRect(state.base.x + 14, state.base.y + 10, 4, 3)
    ctx.fillRect(state.base.x + 12, state.base.y + 15, 8, 2)
  }

  state.powerups.forEach(drawPowerup)

  for (const bullet of state.bullets) {
    if (!bullet.trail || bullet.trail.length < 2) {
      continue
    }
    for (let i = 0; i < bullet.trail.length; i += 1) {
      const point = bullet.trail[i]
      const alpha = (i + 1) / bullet.trail.length
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.45})`
      ctx.fillRect(Math.floor(point.x) - 1, Math.floor(point.y) - 1, 2, 2)
    }
  }
  drawTank(state.player)
  if (state.player2) {
    drawTank(state.player2)
  }
  state.enemies.forEach(drawTank)

  for (const obstacle of state.obstacles) {
    if (obstacle.type === 'forest') {
      drawTileRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h, COLORS.forest, '#95cf71')
    }
  }

  ctx.fillStyle = COLORS.bullet
  for (const bullet of state.bullets) {
    if (bullet.burning) {
      const bx = Math.floor(bullet.x)
      const by = Math.floor(bullet.y)
      const pulse = Math.floor(lastTime / 80) % 2 === 0
      ctx.fillStyle = pulse ? '#ff4d4f' : '#f7d51d'
      ctx.fillRect(bx - 3, by - 3, 6, 6)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(bx - 1, by - 1, 2, 2)

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
      ctx.fillRect(Math.floor(bullet.x) - 2, Math.floor(bullet.y) - 2, 4, 4)
    }
  }

  for (const particle of state.particles) {
    const alpha = 1 - particle.age / particle.life
    ctx.fillStyle = rgba(particle.color, alpha)
    const size = Math.max(1, Math.floor(particle.size || 3))
    ctx.fillRect(Math.floor(particle.x - size / 2), Math.floor(particle.y - size / 2), size, size)
  }

  const hudX = BOARD_COLS * TILE
  const hudTime = Math.max(0, Math.ceil((GAME_TIME - gameTime) / 1000))
  const hudLife = isMultiplayer.value ? 'INF' : String(stats.value.playerLives)
  const buffPower = state.player.buffs.powerUntil > 0 ? Math.ceil(state.player.buffs.powerUntil / 1000) : 0
  const buffSpeed = state.player.buffs.speedUntil > 0 ? Math.ceil(state.player.buffs.speedUntil / 1000) : 0

  ctx.fillStyle = '#0a0a0a'
  ctx.fillRect(hudX, 0, HUD_WIDTH, CANVAS_HEIGHT)
  ctx.strokeStyle = '#c2a36a'
  ctx.lineWidth = 2
  ctx.strokeRect(hudX + 1, 1, HUD_WIDTH - 2, CANVAS_HEIGHT - 2)
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 1
  ctx.strokeRect(hudX + 5, 6, HUD_WIDTH - 12, CANVAS_HEIGHT - 12)

  ctx.fillStyle = COLORS.text
  ctx.font = `12px ${PIXEL_FONT}`
  ctx.fillText('TANK 90', hudX + 12, 28)
  ctx.fillRect(hudX + 10, 36, HUD_WIDTH - 20, 2)

  ctx.font = `10px ${PIXEL_FONT}`
  ctx.fillText(`TIME ${String(hudTime).padStart(3, ' ')}`, hudX + 12, 56)
  ctx.fillText(`LIFE ${hudLife.padStart(3, ' ')}`, hudX + 12, 76)
  ctx.fillText(`HP   ${String(state.player.hp).padStart(3, ' ')}`, hudX + 12, 96)
  if (state.player2) {
    const p2life = isMultiplayer.value ? 'INF' : String(stats.value.player2Lives)
    ctx.fillText(`P2   ${p2life.padStart(3, ' ')}`, hudX + 12, 116)
  }
  ctx.fillText(`LEFT ${String(stats.value.enemyLeft).padStart(3, ' ')}`, hudX + 12, 136)
  if (isMultiplayer.value) {
    ctx.fillText(`K ${stats.value.killsA}-${stats.value.killsB}`, hudX + 12, 156)
  }
  ctx.fillRect(hudX + 10, 166, HUD_WIDTH - 20, 2)
  ctx.fillText('SCORE', hudX + 12, 186)
  ctx.fillText(`B ${String(buffPower).padStart(3, ' ')}`, hudX + 12, 206)
  ctx.fillText(`S ${String(buffSpeed).padStart(3, ' ')}`, hudX + 12, 226)
  ctx.fillText(String(stats.value.score).padStart(6, ' '), hudX + 12, 246)
  ctx.fillRect(hudX + 10, 256, HUD_WIDTH - 20, 2)
  ctx.fillText('MOVE', hudX + 12, 276)
  ctx.fillText('< ^ v >', hudX + 12, 296)
  ctx.fillText('FIRE SPACE', hudX + 12, 316)

  if (state.gameOver) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)'
    ctx.fillRect(52, 146, 312, 108)
    ctx.strokeStyle = '#ffffff'
    ctx.strokeRect(52, 146, 312, 108)
    ctx.fillStyle = COLORS.text
    ctx.font = `24px ${PIXEL_FONT}`
    ctx.fillText(state.victory ? 'YOU WIN' : 'GAME OVER', 100, 188)
    ctx.font = `10px ${PIXEL_FONT}`
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

function renderGameToText() {
  const payload = {
    mode: state.gameOver ? (state.victory ? 'victory' : 'game_over') : 'playing',
    coords: 'origin=(0,0) top-left; +x right; +y down; unit=pixels',
    board: { width: BOARD_COLS * TILE, height: BOARD_ROWS * TILE, tile: TILE },
    timerSec: Math.max(0, Math.ceil((GAME_TIME - gameTime) / 1000)),
    score: stats.value.score,
    playerLives: stats.value.playerLives,
    player: {
      x: Math.round(state.player.x),
      y: Math.round(state.player.y),
      dir: state.player.dir,
      hp: state.player.hp,
      powerSec: Math.ceil(state.player.buffs.powerUntil / 1000),
      speedSec: Math.ceil(state.player.buffs.speedUntil / 1000),
      armor: state.player.buffs.armorActive,
    },
    enemies: state.enemies
        .filter((enemy) => enemy.alive)
        .map((enemy) => ({ x: Math.round(enemy.x), y: Math.round(enemy.y), dir: enemy.dir, hp: enemy.hp })),
    bullets: state.bullets.map((bullet) => ({ x: Math.round(bullet.x), y: Math.round(bullet.y), dir: bullet.dir, owner: bullet.owner })),
    powerups: state.powerups.map((item) => ({ type: item.type, x: item.x, y: item.y, lifeMs: Math.round(item.life) })),
    base: { alive: state.base.alive, x: state.base.x, y: state.base.y },
    enemyLeft: stats.value.enemyLeft,
  }
  return JSON.stringify(payload)
}

function runFrame(deltaMs, now) {
  lastTime = now

  if (!state.gameOver) {
    gameTime += deltaMs

    if (gameTime >= GAME_TIME && !state.victory) {
      state.gameOver = true
      state.victory = true
      statusText.value = '时间到！你成功守住了基地。按 Enter 重新开始。'
    }

    state.player.fireCooldown -= deltaMs
    state.player.spawnShield = Math.max(0, state.player.spawnShield - deltaMs)

    handleTankInput(state.player, controls, deltaMs, true)
    if (isMultiplayer.value) {
      handleTankInput(state.player2, remoteControls, deltaMs, false)
    }
    updateEnemies(deltaMs, now)
    updatePowerups(deltaMs, now)
    updateBullets(deltaMs)
    updateParticles(deltaMs)
  } else {
    updatePowerups(deltaMs, now)
    updateParticles(deltaMs)
  }

  drawScene()
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
  trackSession('join', mode.value)
  window.addEventListener('beforeunload', () => trackSession('leave', mode.value))
  setupBgm()
  window.render_game_to_text = renderGameToText
  window.advanceTime = (ms) => {
    const stepMs = 1000 / 60
    const steps = Math.max(1, Math.round(ms / stepMs))
    for (let i = 0; i < steps; i += 1) {
      runFrame(stepMs, lastTime + stepMs)
    }
  }
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
  delete window.render_game_to_text
  delete window.advanceTime
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
      <div class="joystick-wrap">
        <div
          ref="joystickBaseRef"
          class="joystick-base"
          @pointerdown.prevent="onJoystickStart"
          @pointermove.prevent="onJoystickMove"
          @pointerup.prevent="onJoystickEnd"
          @pointercancel.prevent="onJoystickEnd"
          @pointerleave.prevent="onJoystickEnd"
        >
          <div
            class="joystick-knob"
            :style="{
              transform: `translate(${joystickVector.x * 24}px, ${joystickVector.y * 24}px)`
            }"
          ></div>
        </div>
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
