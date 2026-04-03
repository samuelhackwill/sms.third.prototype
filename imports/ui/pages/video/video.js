import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"
import { FlowRouter } from "meteor/ostrio:flow-router-extra"

import { streamer } from "/imports/both/streamer"
import { VIDEO_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/video/videoEvents"
import "./video.html"

const DEFAULT_VIDEO_ENDPOINT_URL = "https://sms-clips.samuel.ovh/api/random-clips"

function configuredEndpoint() {
  const queryEndpoint = FlowRouter.getQueryParam("endpoint")
  if (queryEndpoint) {
    return queryEndpoint
  }

  return Meteor.settings.public?.videoEndpointUrl ?? DEFAULT_VIDEO_ENDPOINT_URL
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
}

function absolutizeUrl(maybeUrl, endpoint) {
  if (!maybeUrl || typeof maybeUrl !== "string") {
    return null
  }

  try {
    return new URL(maybeUrl, endpoint || window.location.href).toString()
  } catch (error) {
    return maybeUrl
  }
}

function resolveClipUrl(payload, endpoint) {
  if (!payload) {
    return null
  }

  if (typeof payload === "string") {
    const trimmed = payload.trim()
    return trimmed ? absolutizeUrl(trimmed, endpoint) : null
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const resolved = resolveClipUrl(item, endpoint)
      if (resolved) {
        return resolved
      }
    }
    return null
  }

  if (isObject(payload)) {
    const directKeys = ["media_url", "videoUrl", "url", "src", "playbackUrl", "streamUrl", "mp4"]
    for (const key of directKeys) {
      const resolved = resolveClipUrl(payload[key], endpoint)
      if (resolved) {
        return resolved
      }
    }

    const nestedKeys = ["clip", "video", "data", "result", "item", "items", "clips", "videos"]
    for (const key of nestedKeys) {
      const resolved = resolveClipUrl(payload[key], endpoint)
      if (resolved) {
        return resolved
      }
    }
  }

  return null
}

async function fetchClipUrl(endpoint) {
  if (!endpoint) {
    throw new Error("No video endpoint configured. Use ?endpoint=... or Meteor.settings.public.videoEndpointUrl.")
  }

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    },
    cache: "no-store",
  })

  if (!response.ok) {
    throw new Error(`Endpoint returned ${response.status}`)
  }

  const contentType = response.headers.get("content-type") ?? ""
  let payload

  if (contentType.includes("text/html")) {
    const htmlPayload = await response.text()
    const error = new Error("Endpoint returned HTML instead of JSON")
    error.responsePayload = htmlPayload
    throw error
  }

  if (contentType.includes("application/json")) {
    payload = await response.json()
  } else {
    payload = await response.text()
  }

  const clipUrl = resolveClipUrl(payload, endpoint)
  if (!clipUrl) {
    const error = new Error("Could not resolve a video URL from endpoint response")
    error.responsePayload = payload
    throw error
  }

  return { clipUrl, payload }
}

async function loadVideo(instance) {
  const endpoint = instance.endpoint.get()
  instance.isLoading.set(true)
  instance.errorMessage.set("")
  instance.lastResponse.set("[waiting for response]")

  try {
    const { clipUrl, payload } = await fetchClipUrl(endpoint)
    instance.currentSource.set(clipUrl)
    instance.lastResponse.set(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2))

    const videoEl = instance.find("#remoteVideoPlayer")
    if (!videoEl) {
      return
    }

    if (videoEl.getAttribute("src") !== clipUrl) {
      videoEl.src = clipUrl
      videoEl.load()
    }

    videoEl.muted = instance.isMuted.get()
    await videoEl.play().catch(() => {})
  } catch (error) {
    instance.errorMessage.set(error?.message ?? "Failed to load video")
    if (error?.responsePayload !== undefined) {
      const payload = error.responsePayload
      instance.lastResponse.set(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2))
    } else {
      instance.lastResponse.set(error?.stack || error?.message || "Failed to load video")
    }
  } finally {
    instance.isLoading.set(false)
  }
}

Template.VideoPage.onCreated(function onCreated() {
  this.endpoint = new ReactiveVar(configuredEndpoint())
  this.isLoading = new ReactiveVar(false)
  this.errorMessage = new ReactiveVar("")
  this.currentSource = new ReactiveVar("")
  this.isMuted = new ReactiveVar(true)
  this.lastResponse = new ReactiveVar("")
  this.routeControlHandler = null
})

Template.VideoPage.onRendered(function onRendered() {
  this.routeControlHandler = (payload) => {
    if (!payload || payload.from !== "video" || payload.target !== "ticker") {
      return
    }

    FlowRouter.go("/ticker")
  }

  streamer.on(VIDEO_ROUTE_CONTROL_EVENT, this.routeControlHandler)
  loadVideo(this)
})

Template.VideoPage.onDestroyed(function onDestroyed() {
  if (this.routeControlHandler) {
    streamer.removeListener(VIDEO_ROUTE_CONTROL_EVENT, this.routeControlHandler)
    this.routeControlHandler = null
  }
})

Template.VideoPage.helpers({
  endpointLabel() {
    return Template.instance().endpoint.get() || "No endpoint configured"
  },
  isLoading() {
    return Template.instance().isLoading.get()
  },
  errorMessage() {
    return Template.instance().errorMessage.get()
  },
  currentSource() {
    return Template.instance().currentSource.get()
  },
  lastResponse() {
    return Template.instance().lastResponse.get()
  },
  muteButtonLabel() {
    return Template.instance().isMuted.get() ? "Sound Off" : "Sound On"
  },
})

Template.VideoPage.events({
  'click [data-action="reload-video"]'(event, instance) {
    event.preventDefault()
    loadVideo(instance)
  },
  'click [data-action="toggle-mute"]'(event, instance) {
    event.preventDefault()
    const nextMuted = !instance.isMuted.get()
    instance.isMuted.set(nextMuted)

    const videoEl = instance.find("#remoteVideoPlayer")
    if (!videoEl) {
      return
    }

    videoEl.muted = nextMuted
    if (!nextMuted && videoEl.getAttribute("src")) {
      videoEl.play().catch(() => {})
    }
  },
})
