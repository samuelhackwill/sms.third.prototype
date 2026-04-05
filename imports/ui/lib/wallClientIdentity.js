const SESSION_CLIENT_ID_KEY = "clientId"
const LEGACY_SESSION_CLIENT_ID_KEY = "ticker.clientId"
const LOCAL_STORAGE_CLIENT_ID_KEY = "ticker.clientId"
const DEVICE_KEY_STORAGE_KEY = "ticker.deviceKey"

function readStorage(storage, key) {
  try {
    return storage?.getItem(key) ?? null
  } catch (error) {
    return null
  }
}

function writeStorage(storage, key, value) {
  try {
    storage?.setItem(key, value)
  } catch (error) {
    // Ignore storage access failures and fall back to the other store.
  }
}

function makeClientId() {
  const browserCrypto = globalThis.crypto
  if (browserCrypto && typeof browserCrypto.randomUUID === "function") {
    return browserCrypto.randomUUID()
  }

  if (browserCrypto && typeof browserCrypto.getRandomValues === "function") {
    const bytes = browserCrypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80

    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function getOrCreateClientId() {
  const existing = readStorage(globalThis.localStorage, LOCAL_STORAGE_CLIENT_ID_KEY)
    || readStorage(globalThis.sessionStorage, SESSION_CLIENT_ID_KEY)
  if (existing) {
    writeStorage(globalThis.localStorage, LOCAL_STORAGE_CLIENT_ID_KEY, existing)
    writeStorage(globalThis.sessionStorage, SESSION_CLIENT_ID_KEY, existing)
    return existing
  }

  const legacy = readStorage(globalThis.localStorage, LEGACY_SESSION_CLIENT_ID_KEY)
    || readStorage(globalThis.sessionStorage, LEGACY_SESSION_CLIENT_ID_KEY)
  if (legacy) {
    writeStorage(globalThis.localStorage, LOCAL_STORAGE_CLIENT_ID_KEY, legacy)
    writeStorage(globalThis.sessionStorage, SESSION_CLIENT_ID_KEY, legacy)
    return legacy
  }

  const nextId = makeClientId()
  writeStorage(globalThis.localStorage, LOCAL_STORAGE_CLIENT_ID_KEY, nextId)
  writeStorage(globalThis.sessionStorage, SESSION_CLIENT_ID_KEY, nextId)
  return nextId
}

export function getOrCreateDeviceKey() {
  const existing = readStorage(globalThis.localStorage, DEVICE_KEY_STORAGE_KEY)
    || readStorage(globalThis.sessionStorage, DEVICE_KEY_STORAGE_KEY)
  if (existing) {
    writeStorage(globalThis.localStorage, DEVICE_KEY_STORAGE_KEY, existing)
    writeStorage(globalThis.sessionStorage, DEVICE_KEY_STORAGE_KEY, existing)
    return existing
  }

  const nextKey = makeClientId()
  writeStorage(globalThis.localStorage, DEVICE_KEY_STORAGE_KEY, nextKey)
  writeStorage(globalThis.sessionStorage, DEVICE_KEY_STORAGE_KEY, nextKey)
  return nextKey
}

export function toShortCode(clientId) {
  return clientId.replace(/-/g, "").slice(0, 5).toUpperCase()
}
