import { Meteor } from "meteor/meteor"

import { DEFAULT_TICKER_WALL_ID } from "/imports/api/ticker/collections"
import { maybeStartNext } from "/imports/api/ticker/methods"
import { enqueueTickerMessage } from "/imports/api/ticker/queue"
import { streamer } from "/imports/both/streamer"

let bridgeInitialized = false

export function initTickerStreamerBridge() {
  if (!Meteor.isServer || bridgeInitialized) {
    return
  }

  bridgeInitialized = true

  streamer.on("stage.raw.spawn", async (payload) => {
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    let enqueuedCount = 0

    messages.forEach((message) => {
      const text = typeof message?.body === "string" ? message.body.trim() : ""
      if (!text) {
        return
      }

      const parsedReceivedAt = message?.receivedAt ? new Date(message.receivedAt) : null
      const receivedAt =
        parsedReceivedAt && !Number.isNaN(parsedReceivedAt.getTime()) ? parsedReceivedAt : new Date()

      enqueueTickerMessage(DEFAULT_TICKER_WALL_ID, {
        id: message?.id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        text,
        receivedAt,
      })
      enqueuedCount += 1
    })

    if (enqueuedCount > 0) {
      await maybeStartNext(DEFAULT_TICKER_WALL_ID)
    }
  })
}
