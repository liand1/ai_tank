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
const PLAYER_HP = 3
const ENEMY_AGGRO_RANGE = TILE * 20
const BGM_SRC = '/audio/suspense.mp3'
const SFX_EXPLOSION = '/audio/explosion.ogg'
const SFX_POWERUP = '/audio/powerup.ogg'
const POWERUP_DURATION = 30000
const POWERUP_SPAWN_INTERVAL = 12000
const POWERUP_LIFETIME = 10000
const GAME_TIME = 150000
const EXTRA_ENEMY_INTERVAL = 50000
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
const stats = ref({
  playerLives: 3,
  enemyLeft: 10,
  score: 0,
})

let ctx = null
let animationFrame = 0
let lastTime = 0
let lastEnemySpawn = 0
let lastPowerupSpawn = 0
let enemyDecisionTimer = 0
let gameTime = 0
let state
let bgm = null
let audioUnlocked = false

const controls = {
  up: false,
  down: false,
  left: false,
  right: false,
  fire: false,
}

const mobileHint = computed(() => window.innerWidth < 860)

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
}

function setControl(key, pressed) {
  controls[key] = pressed
}

function tapAction(key) {
  controls[key] = true
  window.setTimeout(() => {
    controls[key] = false
  }, 90)
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
    if (engineAudio && playerMoving) {
      engineAudio.play().catch(() => {})
    }
  }

  window.addEventListener('pointerdown', unlock, { once: true })
  window.addEventListener('keydown', unlock, { once: true })
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

function createMap() {
  const map = []

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

function createPlayer() {
  return {
    kind: 'player',
    x: 12 * TILE,
    y: 22 * TILE,
    size: 14,
    renderSize: 15,
    dir: 'up',
    speed: PLAYER_SPEED,
    hp: PLAYER_HP,
    maxHp: PLAYER_HP,
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

function createEnemy(spawnX) {
  return {
    kind: 'enemy',
    x: spawnX,
    y: 0,
    size: 14,
    renderSize: 15,
    dir: 'down',
    speed: ENEMY_SPEED,
    hp: ENEMY_HP,
    maxHp: ENEMY_HP,
    colorMain: COLORS.enemyMain,
    colorAccent: COLORS.enemyAccent,
    fireCooldown: ENEMY_FIRE_COOLDOWN * (0.35 + Math.random() * 0.5),
    alive: true,
    lastDir: 'down',
    aiTurnIn: 500 + Math.random() * 1200,
    spawnShield: 800,
  }
}

function resetState() {
  state = {
    player: createPlayer(),
    enemies: [],
    bullets: [],
    particles: [],
    powerups: [],
    obstacles: createMap(),
    base: {
      x: 12 * TILE,
      y: 24 * TILE,
      w: 2 * TILE,
      h: 2 * TILE,
      alive: true,
    },
    enemyQueue: 10,
    extraEnemiesSpawned: 0,
    gameOver: false,
    victory: false,
  }
  stats.value = {
    playerLives: 3,
    enemyLeft: state.enemyQueue,
    score: 0,
  }
  statusText.value = '按方向键移动，空格发射，守住基地。'
  lastEnemySpawn = 0
  lastPowerupSpawn = 0
  enemyDecisionTimer = 0
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

  if (state.base.alive && rectsOverlap(rect, state.base)) {
    return true
  }

  const tanks = [state.player, ...state.enemies]
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

  if (state.base.alive && rectsOverlap(rect, state.base)) {
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

  const types = ['power', 'speed', 'armor']
  const spot = candidates[Math.floor(Math.random() * candidates.length)]
  const type = types[Math.floor(Math.random() * types.length)]
  state.powerups.push(createPowerup(type, spot.x, spot.y))
  lastPowerupSpawn = now
}

function applyPowerup(type) {
  playSfx(SFX_POWERUP, 0.45)
  if (type === 'power') {
    state.player.buffs.powerUntil = POWERUP_DURATION
    statusText.value = '拿到火力徽章，30 秒内两炮击毁敌军。'
    return
  }

  if (type === 'speed') {
    state.player.buffs.speedUntil = POWERUP_DURATION
    statusText.value = '拿到引擎徽章，30 秒内移动速度翻倍。'
    return
  }

  state.player.buffs.armorActive = true
  state.player.maxHp = 6
  state.player.hp = Math.max(state.player.hp, 6)
  statusText.value = '拿到装甲徽章，这条命需要 6 发炮弹才会被击毁。'
}

function updatePowerups(deltaMs, now) {
  spawnPowerup(now)

  for (const item of state.powerups) {
    item.life -= deltaMs
    if (rectsOverlap(itemRect(item), tankRect(state.player))) {
      item.life = 0
      applyPowerup(item.type)
    }
  }

  state.powerups = state.powerups.filter((item) => item.life > 0)

  state.player.buffs.powerUntil = Math.max(0, state.player.buffs.powerUntil - deltaMs)
  state.player.buffs.speedUntil = Math.max(0, state.player.buffs.speedUntil - deltaMs)
}

function getEnemyAttackDirection(enemy, player) {
  const tolerance = 10
  const enemyCenterX = enemy.x + enemy.size / 2
  const enemyCenterY = enemy.y + enemy.size / 2
  const playerCenterX = player.x + player.size / 2
  const playerCenterY = player.y + player.size / 2

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

function fireBullet(owner) {
  const activeBullets = state.bullets.filter((bullet) => bullet.owner === owner.kind)
  if (owner.kind === 'player' && activeBullets.length >= MAX_PLAYER_BULLETS) {
    return
  }

  const vector = DIRECTION_VECTORS[owner.dir]
  const hasPowerBuff = owner.kind === 'player' && state.player.buffs.powerUntil > 0
  
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
  owner.fireCooldown = owner.kind === 'player' ? PLAYER_FIRE_COOLDOWN : ENEMY_FIRE_COOLDOWN
}

function handlePlayerInput(deltaMs) {
  const player = state.player
  if (!player.alive || state.gameOver) {
    return
  }

  const distance = player.speed * getPlayerSpeedMultiplier() * (deltaMs / 16.67)
  if (controls.up) {
    player.dir = 'up'
    tryMoveTank(player, distance)
  } else if (controls.down) {
    player.dir = 'down'
    tryMoveTank(player, distance)
  } else if (controls.left) {
    player.dir = 'left'
    tryMoveTank(player, distance)
  } else if (controls.right) {
    player.dir = 'right'
    tryMoveTank(player, distance)
  }

  if (controls.fire && player.fireCooldown <= 0) {
    fireBullet(player)
  }
}

function spawnEnemy(now) {
  if (state.enemyQueue <= 0 || state.enemies.filter((enemy) => enemy.alive).length >= 2) {
    return
  }
  if (now - lastEnemySpawn < 1800) {
    return
  }

  const spawnPoints = [0, 12 * TILE, 24 * TILE]
  const available = spawnPoints.filter((spawnX) => {
    const probe = { x: spawnX, y: 0, w: 14, h: 14 }
    return !isBlocked(probe)
  })

  if (available.length === 0) {
    return
  }

  const spawnX = available[Math.floor(Math.random() * available.length)]
  state.enemies.push(createEnemy(spawnX))
  state.enemyQueue -= 1
  stats.value.enemyLeft = state.enemyQueue + state.enemies.filter((enemy) => enemy.alive).length
  lastEnemySpawn = now
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

  const spawnPoints = [0, 12 * TILE, 24 * TILE]
  const available = spawnPoints.filter((spawnX) => {
    const probe = { x: spawnX, y: 0, w: 14, h: 14 }
    return !isBlocked(probe)
  })

  if (available.length === 0) {
    return
  }

  const spawnX = available[Math.floor(Math.random() * available.length)]
  state.enemies.push(createEnemy(spawnX))
  state.extraEnemiesSpawned += 1
  statusText.value = '敌军增援到达！'
}

function chooseEnemyDirection(enemy) {
  const player = state.player
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

  for (const enemy of state.enemies) {
    if (!enemy.alive) {
      continue
    }

    enemy.aiTurnIn -= deltaMs
    enemy.fireCooldown -= deltaMs
    enemy.spawnShield = Math.max(0, enemy.spawnShield - deltaMs)

    const distanceToPlayer = Math.hypot(state.player.x - enemy.x, state.player.y - enemy.y)
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
      const lockDir = getEnemyAttackDirection(enemy, state.player)

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
  spawnExtraEnemy(now)
}

function damageTank(tank, damage) {
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
    if (state.enemyQueue === 0 && state.enemies.every((enemy) => !enemy.alive)) {
      state.victory = true
      state.gameOver = true
      statusText.value = '胜利，你守住了基地。按 Enter 重新开始。'
    }
  } else {
    if (tank.hp > 0) {
      statusText.value = `我方坦克剩余 ${tank.hp} 点耐久。`
    } else {
      stats.value.playerLives -= 1
      if (stats.value.playerLives > 0) {
        state.player = createPlayer()
        statusText.value = `你被击毁了，剩余生命 ${stats.value.playerLives}。`
      } else {
        state.gameOver = true
        statusText.value = '游戏结束，基地失守前你已耗尽生命。按 Enter 重新开始。'
      }
    }
  }
}

function damageObstacle(obstacle) {
  if (obstacle.type !== 'brick') {
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
      if (obstacle.type === 'forest') {
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

    if (state.base.alive && rectsOverlap(rect, state.base)) {
      state.base.alive = false
      state.gameOver = true
      bullet.alive = false
      explode(state.base.x + TILE, state.base.y + TILE, COLORS.base)
      statusText.value = '基地被摧毁了。按 Enter 重新开始。'
      continue
    }

    const targets = bullet.owner === 'player' ? state.enemies : [state.player]
    for (const target of targets) {
      if (!target.alive || target.spawnShield > 0) {
        continue
      }
      if (rectsOverlap(rect, tankRect(target))) {
        bullet.alive = false
        damageTank(target, bullet.damage)
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
    gameTime += deltaMs
    
    if (gameTime >= GAME_TIME && !state.victory) {
      state.gameOver = true
      state.victory = true
      statusText.value = '时间到！你成功守住了基地。按 Enter 重新开始。'
    }

    state.player.fireCooldown -= deltaMs
    state.player.spawnShield = Math.max(0, state.player.spawnShield - deltaMs)

    handlePlayerInput(deltaMs)
    updateEnemies(deltaMs, now)
    updatePowerups(deltaMs, now)
    updateBullets(deltaMs)
    updateParticles(deltaMs)
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
  if (tank.kind === 'player') {
    const hpRatio = tank.hp / tank.maxHp
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
    ctx.fillRect(x + renderOffset - 1, y + renderOffset - 7, renderSize + 2, 4)
    ctx.fillStyle = tank.buffs.armorActive ? '#4ade80' : '#fbbf24'
    ctx.fillRect(x + renderOffset, y + renderOffset - 6, renderSize * hpRatio, 2)
    
    // 能量效果（如果有增益）
    if (tank.buffs.powerUntil > 0) {
      ctx.strokeStyle = 'rgba(255, 112, 67, 0.6)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(x + renderOffset + renderSize / 2, y + renderOffset + renderSize / 2, renderSize / 2 + 2, 0, Math.PI * 2)
      ctx.stroke()
    }
    if (tank.buffs.speedUntil > 0) {
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
    } else if (obstacle.type === 'steel') {
      drawTileRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h, COLORS.steel, '#c8d3dd')
    } else if (obstacle.type === 'water') {
      drawTileRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h, COLORS.water, '#75a5e6')
    }
  }

  if (state.base.alive) {
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
  ctx.fillText(`LIFE ${stats.value.playerLives}`, BOARD_COLS * TILE + 18, 120)
  ctx.fillText(`HP ${state.player.hp}`, BOARD_COLS * TILE + 18, 142)
  ctx.fillText(`LEFT ${stats.value.enemyLeft}`, BOARD_COLS * TILE + 18, 176)
  ctx.fillText('SCORE', BOARD_COLS * TILE + 18, 206)
  ctx.fillText(`${stats.value.score}`, BOARD_COLS * TILE + 18, 228)
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
