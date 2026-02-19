import { Messages } from "/imports/api/messages/messages"

export async function ensureMessagesIndexes() {
  // Indexes are mainly for performance, but some index types also enforce constraints:

  const rawMessages = Messages.rawCollection()

  // Integrity/validation-like constraints: unique indexes enforce no duplicates at DB level.
  await rawMessages.createIndex({ id: 1 }, { unique: true, name: "messages_id_unique" })

  // Performance: speed up find, sort, and filters.
  await rawMessages.createIndex({ receivedAt: -1 }, { name: "messages_receivedAt_desc" })
  await rawMessages.createIndex({ status: 1 }, { name: "messages_status_asc" })
  await rawMessages.createIndex({ source: 1 }, { name: "messages_source_asc" })
}
