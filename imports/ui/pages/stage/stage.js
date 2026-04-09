import { Meteor } from "meteor/meteor"
import { Spacebars } from "meteor/spacebars"
import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"
import * as PIXI from "pixi.js"
import QRCode from "qrcode"
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

const TENDA_ROUTER_IP = "10.73.73.5"
const SETUP_GUIDE_URL = "/mise-armoire-a-textos.md"

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

const FONT_SIZE = 72
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
const MAX_DISPLAY_CHARS = 200

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

async function fetchSetupGuide(instance) {
  instance.setupGuide.set("")

  try {
    const response = await fetch(SETUP_GUIDE_URL, { cache: "no-store" })
    if (!response.ok) {
      throw new Error(`Failed to load setup guide (${response.status})`)
    }

    instance.setupGuide.set(await response.text())
  } catch (error) {
    instance.setupGuide.set(
      error instanceof Error ? error.message : "Failed to load setup guide"
    )
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function renderInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code class=\"rounded bg-black/30 px-1.5 py-0.5 text-cyan-100\">$1</code>")
}

function renderSetupGuideMarkdown(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n")
  const html = []
  let inCodeBlock = false
  let inList = false
  let paragraph = []

  function flushParagraph() {
    if (!paragraph.length) {
      return
    }

    html.push(`<p class="text-sm leading-7 text-slate-200">${renderInlineMarkdown(paragraph.join(" "))}</p>`)
    paragraph = []
  }

  function closeList() {
    if (!inList) {
      return
    }

    html.push("</ul>")
    inList = false
  }

  lines.forEach((line) => {
    const trimmed = line.trim()

    if (inCodeBlock) {
      if (trimmed.startsWith("```")) {
        html.push("</code></pre>")
        inCodeBlock = false
      } else {
        html.push(`${escapeHtml(line)}\n`)
      }
      return
    }

    if (trimmed.startsWith("```")) {
      flushParagraph()
      closeList()
      html.push("<pre class=\"mt-4 overflow-x-auto rounded-2xl border border-slate-800 bg-black/30 p-4 font-mono text-sm leading-6 text-slate-100\"><code>")
      inCodeBlock = true
      return
    }

    if (!trimmed) {
      flushParagraph()
      closeList()
      return
    }

    if (trimmed.startsWith("### ")) {
      flushParagraph()
      closeList()
      html.push(`<h3 class="mt-6 text-lg font-semibold text-white">${renderInlineMarkdown(trimmed.slice(4))}</h3>`)
      return
    }

    if (trimmed.startsWith("## ")) {
      flushParagraph()
      closeList()
      html.push(`<h2 class="text-2xl font-semibold text-white">${renderInlineMarkdown(trimmed.slice(3))}</h2>`)
      return
    }

    const checklistMatch = trimmed.match(/^- \[ \] (.+)$/)
    if (checklistMatch) {
      flushParagraph()
      if (!inList) {
        html.push("<ul class=\"space-y-3 text-sm text-slate-200\">")
        inList = true
      }
      html.push(
        `<li class="flex gap-3 leading-6"><span class="mt-[2px] text-cyan-300">□</span><span>${renderInlineMarkdown(checklistMatch[1])}</span></li>`
      )
      return
    }

    closeList()
    paragraph.push(trimmed)
  })

  flushParagraph()
  closeList()

  if (inCodeBlock) {
    html.push("</code></pre>")
  }

  return html.join("")
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

    if (!Array.isArray(payload.messages)) {
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

async function fetchRouterSanity(instance) {
  instance.routerSanity.set({
    status: "checking",
    latencyMs: null,
    checkedAt: new Date(),
    error: null,
  })

  try {
    const response = await fetch("/api/sanity/router", {
      method: "GET",
      cache: "no-store",
    })
    const payload = await response.json()

    instance.routerSanity.set({
      status: payload?.ok ? "ok" : "down",
      latencyMs:
        Number.isFinite(payload?.latencyMs) ? payload.latencyMs : null,
      checkedAt: new Date(),
      error: payload?.error || null,
    })
  } catch (error) {
    instance.routerSanity.set({
      status: "down",
      latencyMs: null,
      checkedAt: new Date(),
      error: error instanceof Error ? error.message : "Unable to reach sanity endpoint",
    })
  }
}

async function fetchScraperSanity(instance) {
  instance.scraperSanity.set({
    status: "checking",
    pid: null,
    heartbeatAgeMs: null,
    lastHeartbeatAt: null,
    lastIngestCount: null,
    error: null,
  })

  try {
    const response = await fetch("/api/sanity/tenda-router-scraper", {
      method: "GET",
      cache: "no-store",
    })
    const payload = await response.json()

    instance.scraperSanity.set({
      status: payload?.ok || payload?.running ? "ok" : "down",
      pid: payload?.pid ?? null,
      heartbeatAgeMs:
        Number.isFinite(payload?.heartbeatAgeMs) ? payload.heartbeatAgeMs : null,
      lastHeartbeatAt: payload?.lastHeartbeatAt ? new Date(payload.lastHeartbeatAt) : null,
      lastIngestCount:
        Number.isFinite(payload?.lastIngestCount) ? payload.lastIngestCount : 0,
      error:
        payload?.lastIngestError || (payload?.running ? null : "Scraper is not running"),
    })
  } catch (error) {
    instance.scraperSanity.set({
      status: "down",
      pid: null,
      heartbeatAgeMs: null,
      lastHeartbeatAt: null,
      lastIngestCount: null,
      error: error instanceof Error ? error.message : "Unable to reach scraper sanity endpoint",
    })
  }
}

async function buildTickerQrCode(instance) {
  let tickerUrl = "/ticker"

  try {
    const response = await fetch("/api/sanity/host", {
      method: "GET",
      cache: "no-store",
    })
    const payload = await response.json()

    if (typeof payload?.tickerUrl === "string" && payload.tickerUrl.length > 0) {
      tickerUrl = payload.tickerUrl
    } else if (typeof window !== "undefined") {
      tickerUrl = new URL("/ticker", window.location.origin).toString()
    }
  } catch (error) {
    if (typeof window !== "undefined") {
      tickerUrl = new URL("/ticker", window.location.origin).toString()
    }
  }

  instance.tickerUrl.set(tickerUrl)

  try {
    const dataUrl = await QRCode.toDataURL(tickerUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 960,
      color: {
        dark: "#000000",
        light: "#ffffff",
      },
    })
    instance.tickerQrCodeDataUrl.set(dataUrl)
  } catch (error) {
    instance.tickerQrCodeDataUrl.set(null)
  }
}

Template.home.onCreated(function onCreated() {
  this.setupGuide = new ReactiveVar("")
  this.routerSanity = new ReactiveVar({
    status: "checking",
    latencyMs: null,
    checkedAt: null,
    error: null,
  })
  this.scraperSanity = new ReactiveVar({
    status: "checking",
    pid: null,
    heartbeatAgeMs: null,
    lastHeartbeatAt: null,
    lastIngestCount: null,
    error: null,
  })
  this.scraperStartPending = new ReactiveVar(false)
  this.scraperStartResult = new ReactiveVar(null)
  this.tickerQrCodeDataUrl = new ReactiveVar(null)
  this.tickerUrl = new ReactiveVar("/ticker")
})

Template.home.onRendered(function onRendered() {
  fetchSetupGuide(this)
  fetchRouterSanity(this)
  fetchScraperSanity(this)
  buildTickerQrCode(this)
})

Template.home.helpers({
  setupGuideHtml() {
    return Spacebars.SafeString(renderSetupGuideMarkdown(Template.instance().setupGuide.get()))
  },
  routerStatusLabel() {
    const status = Template.instance().routerSanity.get()?.status

    if (status === "ok") {
      return `Router ${TENDA_ROUTER_IP} reachable`
    }

    if (status === "down") {
      return `Router ${TENDA_ROUTER_IP} unreachable`
    }

    return `Checking router ${TENDA_ROUTER_IP}...`
  },
  routerStatusDotClass() {
    const status = Template.instance().routerSanity.get()?.status

    if (status === "ok") {
      return "bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.95)]"
    }

    if (status === "down") {
      return "bg-rose-400 shadow-[0_0_12px_rgba(251,113,133,0.95)]"
    }

    return "bg-amber-300 shadow-[0_0_12px_rgba(252,211,77,0.95)]"
  },
  routerLatencyLabel() {
    const latencyMs = Template.instance().routerSanity.get()?.latencyMs
    return Number.isFinite(latencyMs) ? `${latencyMs.toFixed(1)} ms` : "-"
  },
  routerCheckedAtLabel() {
    const checkedAt = Template.instance().routerSanity.get()?.checkedAt
    return checkedAt instanceof Date ? checkedAt.toLocaleTimeString() : "-"
  },
  routerError() {
    return Template.instance().routerSanity.get()?.error || null
  },
  scraperStatusLabel() {
    const status = Template.instance().scraperSanity.get()?.status

    if (status === "ok") {
      return "Scraper healthy"
    }

    if (status === "down") {
      return "Scraper down"
    }

    return "Checking scraper..."
  },
  scraperStatusDotClass() {
    const status = Template.instance().scraperSanity.get()?.status

    if (status === "ok") {
      return "bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.95)]"
    }

    return "bg-rose-400 shadow-[0_0_12px_rgba(251,113,133,0.95)]"
  },
  scraperPidLabel() {
    const pid = Template.instance().scraperSanity.get()?.pid
    return pid ?? "-"
  },
  scraperStartButtonLabel() {
    const instance = Template.instance()
    if (instance.scraperStartPending.get()) {
      return "STARTING..."
    }
    if (instance.scraperSanity.get()?.status === "ok") {
      return "TENDA SCRAPER RUNNING"
    }
    return "START TENDA SCRAPER"
  },
  isScraperStartDisabled() {
    const instance = Template.instance()
    return instance.scraperStartPending.get() || instance.scraperSanity.get()?.status === "ok"
  },
  scraperStartDisabledAttr() {
    const instance = Template.instance()
    return instance.scraperStartPending.get() || instance.scraperSanity.get()?.status === "ok"
      ? "disabled"
      : null
  },
  scraperHeartbeatAgeLabel() {
    const heartbeatAgeMs = Template.instance().scraperSanity.get()?.heartbeatAgeMs
    return Number.isFinite(heartbeatAgeMs) ? `${Math.round(heartbeatAgeMs / 1000)} s` : "-"
  },
  scraperLastIngestCountLabel() {
    const count = Template.instance().scraperSanity.get()?.lastIngestCount
    return Number.isFinite(count) ? String(count) : "-"
  },
  scraperCheckedAtLabel() {
    const checkedAt = Template.instance().scraperSanity.get()?.lastHeartbeatAt
    return checkedAt instanceof Date ? checkedAt.toLocaleTimeString() : "-"
  },
  scraperError() {
    return Template.instance().scraperSanity.get()?.error || null
  },
  scraperStartResult() {
    return Template.instance().scraperStartResult.get()
  },
  tickerQrCodeDataUrl() {
    return Template.instance().tickerQrCodeDataUrl.get()
  },
  tickerUrl() {
    return Template.instance().tickerUrl.get()
  },
})

Template.home.events({
  "click [data-action='refresh-router-check']"(event, instance) {
    event.preventDefault()
    fetchRouterSanity(instance)
  },
  "click [data-action='refresh-scraper-check']"(event, instance) {
    event.preventDefault()
    fetchScraperSanity(instance)
  },
  async "click [data-action='start-tenda-scraper']"(event, instance) {
    event.preventDefault()

    if (instance.scraperStartPending.get() || instance.scraperSanity.get()?.status === "ok") {
      return
    }

    instance.scraperStartPending.set(true)
    instance.scraperStartResult.set(null)

    try {
      const result = await Meteor.callAsync("tendaRouterScraper.start")
      if (result?.alreadyRunning) {
        instance.scraperStartResult.set("Scraper was already running.")
      } else {
        instance.scraperStartResult.set("Tenda router scraper started.")
      }
    } catch (error) {
      instance.scraperStartResult.set(
        error instanceof Error ? error.message : "Failed to start scraper"
      )
    } finally {
      instance.scraperStartPending.set(false)
      fetchScraperSanity(instance)
    }
  },
})

export {
  DEFAULT_STAGE_VIDEO_KEY,
  STAGE_BACKGROUND_EVENT,
}
