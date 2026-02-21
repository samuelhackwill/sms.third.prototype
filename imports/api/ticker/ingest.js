import { Random } from "meteor/random"

import { DEFAULT_TICKER_WALL_ID } from "/imports/api/ticker/collections"
import { maybeStartNext } from "/imports/api/ticker/methods"
import { enqueueTickerMessage } from "/imports/api/ticker/queue"

function normalizeRawText(message) {
  if (typeof message?.body === "string") {
    return message.body.trim()
  }
  if (typeof message?.text === "string") {
    return message.text.trim()
  }
  return ""
}

function normalizeRawRecord(record) {
  const text = normalizeRawText(record)
  if (!text) {
    return null
  }

  const parsedReceivedAt = record?.receivedAt ? new Date(record.receivedAt) : null
  const receivedAt =
    parsedReceivedAt && !Number.isNaN(parsedReceivedAt.getTime()) ? parsedReceivedAt : new Date()

  return {
    id: record?.id ?? Random.id(),
    text,
    receivedAt,
  }
}

export async function ingestRawRecord(record, wallId = DEFAULT_TICKER_WALL_ID) {
  const item = normalizeRawRecord(record)
  if (!item) {
    return { enqueuedCount: 0 }
  }

  enqueueTickerMessage(wallId, item)
  await maybeStartNext(wallId)
  return { enqueuedCount: 1 }
}
