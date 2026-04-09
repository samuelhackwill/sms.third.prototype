function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
}

function absolutizeUrl(maybeUrl, endpoint) {
  if (!maybeUrl || typeof maybeUrl !== "string") {
    return null
  }

  try {
    return new URL(maybeUrl, endpoint || "http://localhost").toString()
  } catch (error) {
    return maybeUrl
  }
}

export function resolveClipUrl(payload, endpoint) {
  if (!payload) {
    return null
  }

  if (typeof payload === "string") {
    const trimmed = payload.trim()
    return trimmed ? absolutizeUrl(trimmed, endpoint) : null
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const resolved = resolveClipUrl(item, endpoint)
      if (resolved) {
        return resolved
      }
    }
    return null
  }

  if (isObject(payload)) {
    const directKeys = ["media_url", "videoUrl", "url", "src", "playbackUrl", "streamUrl", "mp4"]
    for (const key of directKeys) {
      const resolved = resolveClipUrl(payload[key], endpoint)
      if (resolved) {
        return resolved
      }
    }

    const nestedKeys = ["clip", "video", "data", "result", "item", "items", "clips", "videos"]
    for (const key of nestedKeys) {
      const resolved = resolveClipUrl(payload[key], endpoint)
      if (resolved) {
        return resolved
      }
    }
  }

  return null
}

function toFiniteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function extractTrimWindow(payload) {
  if (!isObject(payload)) {
    return null
  }

  const kissStartSec = toFiniteNumber(
    payload.kiss_start_seconds
    ?? payload.kiss_start
    ?? payload.kissStart
    ?? payload.kiss_start_sec,
  )
  const kissEndSec = toFiniteNumber(
    payload.kiss_end_seconds
    ?? payload.kiss_end
    ?? payload.kissEnd
    ?? payload.kiss_end_sec,
  )

  if (kissStartSec === null && kissEndSec === null) {
    return null
  }

  return { kissStartSec, kissEndSec }
}

export function resolveClipData(payload, endpoint) {
  if (!payload) {
    return { clipUrl: null, trimWindow: null }
  }

  if (typeof payload === "string") {
    const clipUrl = resolveClipUrl(payload, endpoint)
    return { clipUrl, trimWindow: null }
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const resolved = resolveClipData(item, endpoint)
      if (resolved.clipUrl) {
        return resolved
      }
    }
    return { clipUrl: null, trimWindow: null }
  }

  if (isObject(payload)) {
    const directKeys = ["media_url", "videoUrl", "url", "src", "playbackUrl", "streamUrl", "mp4"]
    for (const key of directKeys) {
      const clipUrl = resolveClipUrl(payload[key], endpoint)
      if (clipUrl) {
        return {
          clipUrl,
          trimWindow: extractTrimWindow(payload),
        }
      }
    }

    const nestedKeys = ["clip", "video", "data", "result", "item", "items", "clips", "videos"]
    for (const key of nestedKeys) {
      const resolved = resolveClipData(payload[key], endpoint)
      if (resolved.clipUrl) {
        return resolved
      }
    }
  }

  return { clipUrl: null, trimWindow: null }
}
