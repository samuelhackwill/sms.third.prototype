import { createHash } from "node:crypto"

import { Messages } from "/imports/api/messages/messages"
import { ingestRawRecord as ingestTickerRawRecord } from "/imports/api/ticker/ingest"
import { streamer } from "/imports/both/streamer"
import { appendRawRecord } from "/imports/server/rawLog"

function normalizeBody(body) {
  if (typeof body === "string") {
    return body
  }

  if (body == null) {
    return ""
  }

  return String(body)
}

function normalizeReceivedAt(receivedAt) {
  if (!receivedAt) {
    return null
  }

  const value = new Date(receivedAt)
  return Number.isNaN(value.getTime()) ? null : value
}

function normalizeIngestedAt(ingestedAt) {
  if (!ingestedAt) {
    return new Date()
  }

  const value = new Date(ingestedAt)
  return Number.isNaN(value.getTime()) ? new Date() : value
}

function externalIdForRecord(record) {
  const source = record?.source ?? "unknown"
  const meta = record?.meta ?? {}

  if (source === "osx_messages_app" && meta.messagesRowId != null) {
    return String(meta.messagesRowId)
  }

  if (source === "sim_router") {
    if (meta.messageId != null) {
      return String(meta.messageId)
    }

    if (meta.routerMessageId != null) {
      return String(meta.routerMessageId)
    }
  }

  const fallbackKey = JSON.stringify({
    source,
    phoneNumberId: record?.phoneNumberId ?? null,
    sender: record?.sender ?? null,
    body: normalizeBody(record?.body),
    receivedAt: record?.receivedAt ?? null,
    meta,
  })

  return createHash("sha1").update(fallbackKey).digest("hex")
}

export function canonicalIdForRecord(record) {
  return `${record?.source ?? "unknown"}:${externalIdForRecord(record)}`
}

function buildCanonicalMessage(record) {
  const source = record?.source ?? null
  const externalId = externalIdForRecord(record)
  const body = normalizeBody(record?.body)
  const receivedAt = normalizeReceivedAt(record?.receivedAt)
  const ingestedAt = normalizeIngestedAt(record?.ingestedAt)

  return {
    id: canonicalIdForRecord(record),
    source,
    externalId,
    phoneNumberId: record?.phoneNumberId ?? null,
    sender: record?.sender ?? null,
    body,
    receivedAt,
    status: "raw",
    meta: record?.meta ?? {},
    rawSchemaVersion: record?.schema_version ?? null,
    rawIngestedAt: ingestedAt,
    updatedAt: new Date(),
  }
}

function buildStageSpawnMessage(rawRecord, canonicalMessage) {
  const body = normalizeBody(rawRecord?.body)
  if (!body.trim()) {
    return null
  }

  return {
    id: canonicalMessage?.id ?? canonicalIdForRecord(rawRecord),
    phone: rawRecord?.sender ?? canonicalMessage?.sender ?? null,
    body,
    receivedAt: rawRecord?.receivedAt ?? canonicalMessage?.receivedAt ?? null,
  }
}

export async function upsertIncomingMessage(record) {
  const message = buildCanonicalMessage(record)
  const rawMessages = Messages.rawCollection()

  await rawMessages.updateOne(
    { id: message.id },
    {
      $set: message,
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    { upsert: true },
  )

  return message
}

export async function ingestIncomingMessageRecord(record) {
  const rawRecord = await appendRawRecord(record)
  const canonicalMessage = await upsertIncomingMessage(rawRecord)
  const stageMessage = buildStageSpawnMessage(rawRecord, canonicalMessage)

  if (stageMessage) {
    try {
      streamer.emit("stage.raw.spawn", { messages: [stageMessage] })
    } catch (error) {
      console.error("[messages.ingest] stage.raw.spawn emit failed", error)
    }

    try {
      await ingestTickerRawRecord({
        id: stageMessage.id,
        text: stageMessage.body,
        sender: stageMessage.phone,
        receivedAt: stageMessage.receivedAt,
      })
    } catch (error) {
      console.error("[messages.ingest] ticker enqueue failed", error)
    }
  }

  return canonicalMessage
}
