import { DEFAULT_TICKER_WALL_ID } from "/imports/api/ticker/collections"
import { Meteor } from "meteor/meteor"

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
    id: record?.id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    text,
    receivedAt,
  }
}

export async function ingestRawRecord(record, wallId = DEFAULT_TICKER_WALL_ID) {
  const item = normalizeRawRecord(record)
  if (!item) {
    return { playedCount: 0 }
  }

  await Meteor.callAsync("ticker.playNow", { wallId, text: item.text })
  return { playedCount: 1 }
}
