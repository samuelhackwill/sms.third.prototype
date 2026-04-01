import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"
import * as PIXI from "pixi.js"
import { streamer } from "/imports/both/streamer"
import {
  STAGE_BACKGROUND_EVENT,
  STAGE_CURATION_EVENT,
  STAGE_TEST_EVENT,
} from "/imports/ui/pages/stage/stageEvents"
import {
  DEFAULT_STAGE_VIDEO_KEY,
  videoSrcForKey,
} from "/imports/ui/pages/stage/stageVideos"

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

function curationFontSizePx() {
  if (typeof window === "undefined") {
    return 60
  }

  return window.innerWidth >= 768 ? 60 : 36
}

function measureTextWidth(text, { fontSizePx, fontFamily = "Arial", fontWeight = "600" } = {}) {
  if (typeof document === "undefined") {
    return text.length * fontSizePx * 0.6
  }

  const canvas = measureTextWidth.canvas ?? document.createElement("canvas")
  const context = canvas.getContext("2d")

  measureTextWidth.canvas = canvas
  context.font = `${fontWeight} ${fontSizePx}px ${fontFamily}`
  return context.measureText(text).width
}

function splitTextIntoDisplayLines(text, { maxWidthPx, fontSizePx } = {}) {
  const normalizedText = typeof text === "string" ? text.trim() : ""

  if (!normalizedText) {
    return []
  }

  const paragraphs = normalizedText.split(/\n+/)
  const lines = []

  paragraphs.forEach((paragraph) => {
    const words = paragraph.split(/\s+/).filter(Boolean)

    if (words.length === 0) {
      return
    }

    let currentLine = words[0]

    for (let index = 1; index < words.length; index += 1) {
      const candidateLine = `${currentLine} ${words[index]}`

      if (measureTextWidth(candidateLine, { fontSizePx }) <= maxWidthPx) {
        currentLine = candidateLine
        continue
      }

      lines.push(currentLine)
      currentLine = words[index]
    }

    lines.push(currentLine)
  })

  return lines
}

function buildCurationMessageState(payload) {
  const body = typeof payload?.body === "string" ? payload.body.trim() : ""

  if (!body) {
    return null
  }

  const fontSizePx = curationFontSizePx()
  const maxWidthPx = Math.max(240, Math.floor((typeof window === "undefined" ? 1280 : window.innerWidth) * 0.82))
  const lines = splitTextIntoDisplayLines(body, { maxWidthPx, fontSizePx })

  return {
    id: payload?.messageId ?? null,
    body,
    sender: payload?.sender ?? null,
    mode: payload?.mode === "word" ? "word" : "line",
    lines,
    words: body.split(/\s+/).filter(Boolean),
    revealedWordCount: payload?.mode === "word" ? 1 : 0,
    animationDurationMs: Math.max(300, Number.parseInt(payload?.animationDurationMs, 10) || 420),
    animationStepMs: Math.max(120, Number.parseInt(payload?.animationStepMs, 10) || 180),
  }
}
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

  mountEl.style.width = "100%"
  mountEl.style.height = "100%"
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
    antialias: false,
    resizeTo: mountEl,
    resolution: 1, // clamp
    autoDensity: true,
    backgroundAlpha: 0,
  })

  mountEl.appendChild(app.view)
  app.view.style.width = "100%"
  app.view.style.height = "100%"

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
  this.currentVideoKey = new ReactiveVar(null)
  this.curationMessage = new ReactiveVar(null)
  this.soundEnabled = new ReactiveVar(false)
  this.stageTestHandler = null
  this.stageBackgroundHandler = null
  this.stageCurationHandler = null
  this.rawSpawnHandler = null
  this.pixiStage = null
})

Template.stage.onRendered(function onRendered() {
  if (this.pixiStage) return

  document.body.classList.add("stage-page")
  const mountEl = this.find("#stageCanvasHost")
  const videoEl = this.find("#stageBackgroundVideo")
  videoEl.muted = !this.soundEnabled.get()
  this.handleResize = () => {
    const currentMessage = this.curationMessage.get()
    if (!currentMessage) {
      return
    }

    this.curationMessage.set(buildCurationMessageState(currentMessage))
  }
  window.addEventListener("resize", this.handleResize)

  this.pixiStage = createPixiStage({ mountEl })
  this.pixiStage.start()

  this.stageTestHandler = (payload) => {
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
  streamer.on(STAGE_TEST_EVENT, this.stageTestHandler)

  this.stageBackgroundHandler = (payload) => {
    this.lastEvent.set(JSON.stringify(payload))

    if (!payload || typeof payload !== "object") {
      return
    }

    if (payload.action === "stop") {
      const videoEl = this.find("#stageBackgroundVideo")
      if (!videoEl) {
        return
      }

      videoEl.pause()
      videoEl.currentTime = 0
      videoEl.removeAttribute("src")
      videoEl.load()
      return
    }

    const nextVideoKey = payload.videoKey || DEFAULT_STAGE_VIDEO_KEY
    const nextVideoSrc = payload.videoSrc || videoSrcForKey(nextVideoKey)

    this.currentVideoKey.set(nextVideoKey)

    const videoEl = this.find("#stageBackgroundVideo")
    if (!videoEl) {
      return
    }

    if (videoEl.getAttribute("src") !== nextVideoSrc) {
      videoEl.src = nextVideoSrc
      videoEl.load()
    }

    videoEl.muted = !this.soundEnabled.get()
    videoEl.currentTime = 0
    videoEl.play().catch(() => {})
  }

  streamer.on(STAGE_BACKGROUND_EVENT, this.stageBackgroundHandler)

  this.stageCurationHandler = (payload) => {
    this.lastEvent.set(JSON.stringify(payload))

    if (!payload || typeof payload !== "object") {
      return
    }

    if (payload.action === "hide") {
      this.curationMessage.set(null)
      return
    }

    if (payload.action === "advance-word") {
      const currentMessage = this.curationMessage.get()

      if (!currentMessage || currentMessage.mode !== "word") {
        return
      }

      this.curationMessage.set({
        ...currentMessage,
        revealedWordCount: Math.min(
          currentMessage.words.length,
          (currentMessage.revealedWordCount ?? 0) + 1,
        ),
      })
      return
    }

    this.curationMessage.set(buildCurationMessageState(payload))
  }

  streamer.on(STAGE_CURATION_EVENT, this.stageCurationHandler)

  this.rawSpawnHandler = (payload) => {
    this.lastEvent.set(JSON.stringify(payload))

    if (!payload || typeof payload !== "object") {
      return
    }

    this.pixiStage.spawnMessages(payload.messages)
  }

  streamer.on("stage.raw.spawn", this.rawSpawnHandler)
})

Template.stage.events({
  'click [data-action="toggle-sound"]'(event, instance) {
    event.preventDefault()

    const nextSoundEnabled = !instance.soundEnabled.get()
    instance.soundEnabled.set(nextSoundEnabled)

    const videoEl = instance.find("#stageBackgroundVideo")
    if (!videoEl) {
      return
    }

    videoEl.muted = !nextSoundEnabled

    if (nextSoundEnabled && videoEl.getAttribute("src")) {
      videoEl.play().catch(() => {})
    }
  },
})

Template.stage.onDestroyed(function onDestroyed() {
  document.body.classList.remove("stage-page")

  if (this.handleResize) {
    window.removeEventListener("resize", this.handleResize)
    this.handleResize = null
  }

  if (this.stageTestHandler) {
    streamer.removeListener(STAGE_TEST_EVENT, this.stageTestHandler)
    this.stageTestHandler = null
  }

  if (this.stageBackgroundHandler) {
    streamer.removeListener(STAGE_BACKGROUND_EVENT, this.stageBackgroundHandler)
    this.stageBackgroundHandler = null
  }

  if (this.stageCurationHandler) {
    streamer.removeListener(STAGE_CURATION_EVENT, this.stageCurationHandler)
    this.stageCurationHandler = null
  }

  if (this.rawSpawnHandler) {
    streamer.removeListener("stage.raw.spawn", this.rawSpawnHandler)
    this.rawSpawnHandler = null
  }

  this.pixiStage?.destroy()
  this.pixiStage = null
})

Template.stage.helpers({
  curationMessageLines() {
    const message = Template.instance().curationMessage.get()
    const lines = message?.lines ?? []
    const animationDurationMs = message?.animationDurationMs ?? 420
    const animationStepMs = message?.animationStepMs ?? 180

    return lines.map((text, index) => ({
      text,
      animationStyle: `opacity: 0; animation: curation-line-in ${animationDurationMs}ms ease-out forwards; animation-delay: ${index * animationStepMs}ms;`,
    }))
  },
  curationVisibleWords() {
    const message = Template.instance().curationMessage.get()

    if (!message || message.mode !== "word") {
      return ""
    }

    return message.words.slice(0, message.revealedWordCount).join(" ")
  },
  curationWordTokens() {
    const message = Template.instance().curationMessage.get()

    if (!message || message.mode !== "word") {
      return []
    }

    return message.words.map((word, index) => ({
      text: index < message.words.length - 1 ? `${word} ` : word,
      visibilityStyle: index < message.revealedWordCount ? "visibility: visible;" : "visibility: hidden;",
    }))
  },
  hasCurationMessage() {
    const body = Template.instance().curationMessage.get()?.body ?? ""
    return body.length > 0
  },
  isWordRevealMode() {
    return Template.instance().curationMessage.get()?.mode === "word"
  },
  soundToggleLabel() {
    return Template.instance().soundEnabled.get() ? "sound on" : "sound off"
  },
  lastEvent() {
    return Template.instance().lastEvent.get()
  },
})

export {
  DEFAULT_STAGE_VIDEO_KEY,
  STAGE_BACKGROUND_EVENT,
}
