const queuesByWall = new Map()
const playingByWall = new Map()

function ensureQueue(wallId) {
  if (!queuesByWall.has(wallId)) {
    queuesByWall.set(wallId, [])
  }

  return queuesByWall.get(wallId)
}

export function enqueueTickerMessage(wallId, item) {
  const queue = ensureQueue(wallId)
  queue.push(item)
  return queue.length
}

export function dequeueTickerMessage(wallId) {
  const queue = ensureQueue(wallId)
  return queue.shift() ?? null
}

export function getTickerQueueSnapshot(wallId) {
  const queue = ensureQueue(wallId)
  return [...queue]
}

export function clearTickerQueue(wallId) {
  queuesByWall.set(wallId, [])
}

export function getTickerPlaying(wallId) {
  return playingByWall.get(wallId) ?? null
}

export function setTickerPlaying(wallId, playing) {
  if (!playing) {
    playingByWall.delete(wallId)
    return
  }

  playingByWall.set(wallId, playing)
}
