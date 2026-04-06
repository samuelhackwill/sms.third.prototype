import { Meteor } from "meteor/meteor"

import { DEFAULT_TELEVISION_STATE_ID, TelevisionStates } from "/imports/api/television/collections"

const TELEVISION_STOP_FADE_MS = 900
const stopTimersByStateId = new Map()

function ensureTelevisionStateDoc(stateId = DEFAULT_TELEVISION_STATE_ID) {
  return TelevisionStates.upsertAsync(
    { _id: stateId },
    {
      $setOnInsert: {
        sourceUrl: "",
        playbackState: "idle",
        startedAtServerMs: null,
        stopRequestedAtServerMs: null,
        muted: true,
        loop: true,
        updatedAt: new Date(),
        createdAt: new Date(),
      },
    },
  )
}

function clearStopTimer(stateId) {
  const timer = stopTimersByStateId.get(stateId)
  if (timer) {
    Meteor.clearTimeout(timer)
    stopTimersByStateId.delete(stateId)
  }
}

Meteor.methods({
  async "television.loadUrl"({
    stateId = DEFAULT_TELEVISION_STATE_ID,
    sourceUrl,
    muted = true,
    loop = true,
  } = {}) {
    if (typeof sourceUrl !== "string" || !sourceUrl.trim()) {
      throw new Meteor.Error("television.loadUrl.invalidSourceUrl", "sourceUrl is required")
    }

    clearStopTimer(stateId)
    await ensureTelevisionStateDoc(stateId)
    await TelevisionStates.updateAsync(
      { _id: stateId },
      {
        $set: {
          sourceUrl: sourceUrl.trim(),
          playbackState: "loaded",
          startedAtServerMs: null,
          stopRequestedAtServerMs: null,
          muted: Boolean(muted),
          loop: Boolean(loop),
          updatedAt: new Date(),
        },
      },
    )

    return { ok: true, stateId, sourceUrl: sourceUrl.trim(), playbackState: "loaded" }
  },

  async "television.playLoaded"({ stateId = DEFAULT_TELEVISION_STATE_ID } = {}) {
    clearStopTimer(stateId)
    await ensureTelevisionStateDoc(stateId)
    const state = await TelevisionStates.findOneAsync({ _id: stateId })
    if (!state?.sourceUrl) {
      throw new Meteor.Error("television.playLoaded.noSource", "No source is loaded")
    }

    await TelevisionStates.updateAsync(
      { _id: stateId },
      {
        $set: {
          playbackState: "playing",
          startedAtServerMs: Date.now(),
          stopRequestedAtServerMs: null,
          updatedAt: new Date(),
        },
      },
    )

    return { ok: true, stateId, sourceUrl: state.sourceUrl, playbackState: "playing" }
  },

  async "television.playUrl"({
    stateId = DEFAULT_TELEVISION_STATE_ID,
    sourceUrl,
    muted = true,
    loop = true,
  } = {}) {
    await Meteor.callAsync("television.loadUrl", {
      stateId,
      sourceUrl,
      muted,
      loop,
    })
    return Meteor.callAsync("television.playLoaded", { stateId })
  },

  async "television.stop"({ stateId = DEFAULT_TELEVISION_STATE_ID } = {}) {
    clearStopTimer(stateId)
    await ensureTelevisionStateDoc(stateId)
    await TelevisionStates.updateAsync(
      { _id: stateId },
      {
        $set: {
          playbackState: "stopping",
          stopRequestedAtServerMs: Date.now(),
          updatedAt: new Date(),
        },
      },
    )

    const timer = Meteor.setTimeout(async () => {
      stopTimersByStateId.delete(stateId)
      await TelevisionStates.updateAsync(
        { _id: stateId },
        {
          $set: {
            playbackState: "idle",
            startedAtServerMs: null,
            stopRequestedAtServerMs: null,
            updatedAt: new Date(),
          },
        },
      )
    }, TELEVISION_STOP_FADE_MS)
    stopTimersByStateId.set(stateId, timer)

    return { ok: true, stateId }
  },
})
