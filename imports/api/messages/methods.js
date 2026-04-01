import { Meteor } from "meteor/meteor"

import { MESSAGE_STATUSES, Messages } from "/imports/api/messages/messages"

function normalizeIdList(ids) {
  if (!Array.isArray(ids)) {
    return []
  }

  return [...new Set(ids.filter((value) => typeof value === "string" && value.trim()))]
}

Meteor.methods({
  async "messages.setStatus"({ messageId, status } = {}) {
    if (typeof messageId !== "string" || !messageId.trim()) {
      throw new Meteor.Error("messages.invalidId", "messageId is required.")
    }

    if (!MESSAGE_STATUSES.includes(status)) {
      throw new Meteor.Error("messages.invalidStatus", `Unsupported status: ${status}`)
    }

    return Messages.updateAsync(
      { id: messageId },
      {
        $set: {
          status,
          updatedAt: new Date(),
        },
      },
    )
  },

  async "messages.remove"({ messageId } = {}) {
    if (typeof messageId !== "string" || !messageId.trim()) {
      throw new Meteor.Error("messages.invalidId", "messageId is required.")
    }

    return Messages.removeAsync({ id: messageId })
  },

  async "messages.removeMany"({ messageIds } = {}) {
    const normalizedIds = normalizeIdList(messageIds)

    if (normalizedIds.length === 0) {
      throw new Meteor.Error("messages.invalidIds", "At least one message id is required.")
    }

    return Messages.removeAsync({ id: { $in: normalizedIds } })
  },
})
