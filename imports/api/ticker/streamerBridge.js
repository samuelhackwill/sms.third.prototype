import { Meteor } from "meteor/meteor"

import {
  DEFAULT_TICKER_WALL_ID,
  TickerClients,
} from "/imports/api/ticker/collections"
import { maybeStartNext } from "/imports/api/ticker/methods"
import { enqueueTickerMessage } from "/imports/api/ticker/queue"
import { streamer } from "/imports/both/streamer"

let bridgeInitialized = false
let cleanupIntervalId = null

const STALE_CLIENT_SECONDS = 10080
const CLEANUP_INTERVAL_MS = 60 * 1000

export function initTickerStreamerBridge() {
  if (!Meteor.isServer || bridgeInitialized) {
    return
  }

  bridgeInitialized = true

  streamer.on("stage.raw.spawn", async (payload) => {
    const messages = Array.isArray(payload?.messages) ? payload.messages : []

    messages.forEach((message) => {
      enqueueTickerMessage(DEFAULT_TICKER_WALL_ID, {
        id: message?.id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        text: message?.body ?? "",
        receivedAt: new Date(),
      })
    })

    if (messages.length > 0) {
      await maybeStartNext(DEFAULT_TICKER_WALL_ID)
    }
  })

  cleanupIntervalId = Meteor.setInterval(async () => {
    const staleBefore = new Date(Date.now() - (STALE_CLIENT_SECONDS * 1000))
    await TickerClients.removeAsync({
      wallId: DEFAULT_TICKER_WALL_ID,
      lastSeenAt: { $lt: staleBefore },
    })
  }, CLEANUP_INTERVAL_MS)

  Meteor.onExit(() => {
    if (cleanupIntervalId) {
      Meteor.clearInterval(cleanupIntervalId)
      cleanupIntervalId = null
    }
  })
}
