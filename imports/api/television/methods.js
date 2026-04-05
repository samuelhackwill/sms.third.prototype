import { Meteor } from "meteor/meteor"

import { DEFAULT_TELEVISION_STATE_ID, TelevisionStates } from "/imports/api/television/collections"

function ensureTelevisionStateDoc(stateId = DEFAULT_TELEVISION_STATE_ID) {
  return TelevisionStates.upsertAsync(
    { _id: stateId },
    {
      $setOnInsert: {
        sourceUrl: "",
        playbackState: "idle",
        startedAtServerMs: null,
        muted: true,
        loop: true,
        updatedAt: new Date(),
        createdAt: new Date(),
      },
    },
  )
}

Meteor.methods({
  async "television.playUrl"({
    stateId = DEFAULT_TELEVISION_STATE_ID,
    sourceUrl,
    muted = true,
    loop = true,
  } = {}) {
    if (typeof sourceUrl !== "string" || !sourceUrl.trim()) {
      throw new Meteor.Error("television.playUrl.invalidSourceUrl", "sourceUrl is required")
    }

    await ensureTelevisionStateDoc(stateId)
    await TelevisionStates.updateAsync(
      { _id: stateId },
      {
        $set: {
          sourceUrl: sourceUrl.trim(),
          playbackState: "playing",
          startedAtServerMs: Date.now(),
          muted: Boolean(muted),
          loop: Boolean(loop),
          updatedAt: new Date(),
        },
      },
    )

    return { ok: true, stateId, sourceUrl: sourceUrl.trim() }
  },

  async "television.stop"({ stateId = DEFAULT_TELEVISION_STATE_ID } = {}) {
    await ensureTelevisionStateDoc(stateId)
    await TelevisionStates.updateAsync(
      { _id: stateId },
      {
        $set: {
          playbackState: "idle",
          startedAtServerMs: null,
          updatedAt: new Date(),
        },
      },
    )

    return { ok: true, stateId }
  },
})
