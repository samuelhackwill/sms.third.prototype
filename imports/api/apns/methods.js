import { Meteor } from "meteor/meteor"

import { ApnsDevices } from "/imports/api/apns/collections"
import { sendApnsYoToToken } from "/imports/startup/server/apns"

Meteor.methods({
  async "apns.sendYoToToken"({ token } = {}) {
    if (typeof token !== "string" || !token.trim()) {
      throw new Meteor.Error("apns.invalidToken", "token is required")
    }

    const normalizedToken = token.trim()
    try {
      const result = await sendApnsYoToToken(normalizedToken)

      await ApnsDevices.updateAsync(
        { token: normalizedToken },
        {
          $set: {
            lastSentAt: new Date(),
            lastSendResult: result,
            lastSendError: null,
            updatedAt: new Date(),
          },
        },
      )

      return result
    } catch (error) {
      await ApnsDevices.updateAsync(
        { token: normalizedToken },
        {
          $set: {
            lastSendError: error?.message ?? String(error),
            updatedAt: new Date(),
          },
        },
      )

      throw error
    }
  },

  async "apns.sendYoToAll"() {
    const devices = await ApnsDevices.find({}, { sort: { updatedAt: -1 } }).fetchAsync()
    const results = []

    for (const device of devices) {
      try {
        const result = await sendApnsYoToToken(device.token)
        await ApnsDevices.updateAsync(
          { _id: device._id },
          {
            $set: {
              lastSentAt: new Date(),
              lastSendResult: result,
              updatedAt: new Date(),
            },
          },
        )
        results.push({ token: device.token, deviceName: device.deviceName ?? null, result })
      } catch (error) {
        await ApnsDevices.updateAsync(
          { _id: device._id },
          {
            $set: {
              lastSendError: error?.message ?? String(error),
              updatedAt: new Date(),
            },
          },
        )
        results.push({
          token: device.token,
          deviceName: device.deviceName ?? null,
          error: error?.message ?? String(error),
        })
      }
    }

    return results
  },

  async "apns.deleteDevice"({ token } = {}) {
    if (typeof token !== "string" || !token.trim()) {
      throw new Meteor.Error("apns.invalidToken", "token is required")
    }

    const normalizedToken = token.trim()
    const removedCount = await ApnsDevices.removeAsync({ token: normalizedToken })

    return {
      ok: true,
      removedCount,
      token: normalizedToken,
    }
  },

  async "apns.flushDevices"() {
    const removedCount = await ApnsDevices.removeAsync({})

    return {
      ok: true,
      removedCount,
    }
  },
})
