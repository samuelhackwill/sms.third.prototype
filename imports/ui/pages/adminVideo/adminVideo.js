import { Template } from "meteor/templating"

import { streamer } from "/imports/both/streamer"
import { VIDEO_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/video/videoEvents"
import "./adminVideo.html"

Template.AdminVideoPage.onRendered(function onRendered() {
  document.body.classList.add("admin-page")
})

Template.AdminVideoPage.onDestroyed(function onDestroyed() {
  document.body.classList.remove("admin-page")
})

Template.AdminVideoPage.events({
  'click [data-action="move-video-clients-to-ticker"]'(event) {
    event.preventDefault()
    streamer.emit(VIDEO_ROUTE_CONTROL_EVENT, {
      from: "video",
      target: "ticker",
    })
  },
})
