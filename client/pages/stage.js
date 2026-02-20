import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"
import * as PIXI from "pixi.js"

import "./stage.html"

const PIXI_CHARS_FR =
  " " + // SPACE (must include)
  "0123456789" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
  "abcdefghijklmnopqrstuvwxyz" +
  // Common French diacritics (both cases) + œ/Œ + ÿ/Ÿ
  "ÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸ" +
  "àâäçéèêëîïôöùûüÿ" +
  "ÆŒæœ" +
  // Basic ASCII punctuation
  ".,;:!?…()[]{}<>\"'`“”‘’«»" +
  "-–—_" +
  "/\\|@#&%$€£" +
  "+*=^~" +
  // Whitespace / controls you might want
  "\n\t" +
  // Misc common symbols in messages
  "°©®™✓•·"

const CHANNEL_NAME = "stage_test"
const FONT_SIZE = 36
const LANE_PADDING = 8
const LANE_HEIGHT = FONT_SIZE + LANE_PADDING
const SPAWN_PADDING = 20
const SPEED_MIN = 240
const SPEED_MAX = 800
const MAX_BULLETS = 200
const BITMAP_FONT_NAME = "StageBulletFont"
const BRIGHTNESS_MIN = 150
const BRIGHTNESS_MAX = 245
const USE_BITMAP_TEXT = true
// const LANEATTRIBUTION = "RANDOM"
const LANEATTRIBUTION = "ROUND_ROBIN"
const MAX_DISPLAY_CHARS = 150

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomInRange(min, max) {
  return min + Math.random() * (max - min)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function brightness(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function messageLengthSpeed(body) {
  const text = typeof body === "string" ? body : ""
  const length = text.length
  const minLength = 8
  const maxLength = 420
  const normalized = clamp((length - minLength) / (maxLength - minLength), 0, 1)
  const baseSpeed = SPEED_MIN + normalized * (SPEED_MAX - SPEED_MIN)
  const jitter = randomInRange(-12, 12)
  return clamp(baseSpeed + jitter, SPEED_MIN, SPEED_MAX)
}

function normalizeDisplayBody(body) {
  const text = typeof body === "string" ? body : ""

  if (text.length <= MAX_DISPLAY_CHARS) {
    return text
  }

  const suffix = "[...]"
  const prefixLength = Math.max(0, MAX_DISPLAY_CHARS - suffix.length)
  return `${text.slice(0, prefixLength)}${suffix}`
}

function randomBrightColor() {
  for (let i = 0; i < 1000; i += 1) {
    const r = randomInt(0, 255)
    const g = randomInt(0, 255)
    const b = randomInt(0, 255)
    const value = brightness(r, g, b)

    if (value >= BRIGHTNESS_MIN && value <= BRIGHTNESS_MAX) {
      return (r << 16) | (g << 8) | b
    }
  }

  return 0xffffff
}

function createPixiText({ body, color }) {
  const safeBody = typeof body === "string" && body.length > 0 ? body : "<empty>"

  if (USE_BITMAP_TEXT) {
    const text = new PIXI.BitmapText(safeBody, {
      fontName: BITMAP_FONT_NAME,
      fontSize: FONT_SIZE,
    })
    text.tint = color
    return text
  }

  return new PIXI.Text(safeBody, {
    fill: color,
    fontFamily: "Arial",
    fontSize: FONT_SIZE,
  })
}

export function createPixiStage({ mountEl }) {
  if (!mountEl) {
    throw new Error("createPixiStage requires a mountEl.")
  }

  mountEl.style.width = "100vw"
  mountEl.style.height = "100vh"
  mountEl.style.background = "#000"
  mountEl.style.overflow = "hidden"

  if (USE_BITMAP_TEXT && !PIXI.BitmapFont.available[BITMAP_FONT_NAME]) {
    PIXI.BitmapFont.from(
      BITMAP_FONT_NAME,
      {
        fontFamily: "Arial",
        fontSize: FONT_SIZE,
        fill: "#ffffff",
      },
      { chars: PIXI_CHARS_FR },
    )
  }

  const app = new PIXI.Application({
    background: 0x000000,
    antialias: false,
    resizeTo: mountEl,
    resolution: 1, // clamp
    autoDensity: true,
  })

  mountEl.appendChild(app.view)

  const activeBullets = new Map()
  const phoneColors = new Map()
  let nextLaneIndex = 0

  function laneCount() {
    return Math.max(1, Math.floor(app.screen.height / LANE_HEIGHT))
  }

  function phoneColor(phone) {
    const key = phone ?? "<unknown>"

    if (!phoneColors.has(key)) {
      phoneColors.set(key, randomBrightColor())
    }

    return phoneColors.get(key)
  }

  function removeBullet(id) {
    const bullet = activeBullets.get(id)
    if (!bullet) {
      return
    }

    app.stage.removeChild(bullet.display)
    bullet.display.destroy()
    activeBullets.delete(id)
  }

  function clear() {
    for (const id of activeBullets.keys()) {
      removeBullet(id)
    }
  }

  function pickLaneIndex() {
    const count = laneCount()

    if (LANEATTRIBUTION === "RANDOM") {
      return randomInt(0, count - 1)
    }

    // Round-robin lane attribution: 0,1,2,... then loop.
    const laneIndex = nextLaneIndex % count
    nextLaneIndex = (nextLaneIndex + 1) % count
    return laneIndex
  }

  function spawnMessage(message) {
    if (activeBullets.size >= MAX_BULLETS) {
      return
    }

    const id = message?.id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const laneIndex = pickLaneIndex()
    const color = phoneColor(message?.phone)
    const displayBody = normalizeDisplayBody(message?.body)
    const display = createPixiText({ body: displayBody, color })
    const speedPxPerSec = messageLengthSpeed(displayBody)

    display.x = app.screen.width + SPAWN_PADDING
    display.y = clamp(laneIndex * LANE_HEIGHT, 0, Math.max(0, app.screen.height - FONT_SIZE))

    app.stage.addChild(display)

    activeBullets.set(id, {
      id,
      phone: message?.phone ?? null,
      body: displayBody,
      laneIndex,
      speedPxPerSec,
      display,
      widthPx: display.width,
    })
  }

  function spawnMessages(messages = []) {
    if (!Array.isArray(messages)) {
      return
    }

    messages.forEach((message) => {
      spawnMessage(message)
    })
  }

  function onTick() {
    const deltaSeconds = app.ticker.deltaMS / 1000
    const toRemove = []

    for (const bullet of activeBullets.values()) {
      bullet.display.x -= bullet.speedPxPerSec * deltaSeconds

      if (bullet.display.x + bullet.widthPx < 0) {
        toRemove.push(bullet.id)
      }
    }

    toRemove.forEach(removeBullet)
  }

  app.ticker.add(onTick)

  function start() {
    app.start()
  }

  function stop() {
    app.stop()
  }

  function destroy() {
    stop()
    clear()
    app.ticker.remove(onTick)
    app.destroy(true, { children: true })
  }

  return {
    start,
    stop,
    destroy,
    spawnMessages,
    clear,
  }
}

Template.stage.onCreated(function onCreated() {
  this.lastEvent = new ReactiveVar("no event yet")
  this.stageTestChannel = null
  this.pixiStage = null
})

Template.stage.onRendered(function onRendered() {
  if (this.pixiStage) return

  document.body.classList.add("stage-page")
  const mountEl = this.find("#stageCanvasHost")

  this.pixiStage = createPixiStage({ mountEl })
  this.pixiStage.start()

  this.stageTestChannel = new BroadcastChannel(CHANNEL_NAME)
  this.stageTestChannel.onmessage = (event) => {
    const payload = event?.data ?? null
    this.lastEvent.set(JSON.stringify(payload))

    if (!payload || typeof payload !== "object") {
      return
    }

    if (payload.type === "spawn") {
      this.pixiStage.spawnMessages(payload.messages)
      return
    }

    if (payload.type === "clear") {
      this.pixiStage.clear()
    }
  }
})

Template.stage.onDestroyed(function onDestroyed() {
  document.body.classList.remove("stage-page")

  this.stageTestChannel?.close()
  this.stageTestChannel = null

  this.pixiStage?.destroy()
  this.pixiStage = null
})

Template.stage.helpers({
  lastEvent() {
    return Template.instance().lastEvent.get()
  },
})
