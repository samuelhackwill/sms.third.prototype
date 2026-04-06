import { Template } from "meteor/templating"
import { FlowRouter } from "meteor/ostrio:flow-router-extra"

import "/imports/ui/components/adminWallNav/adminWallNav.html"

const ADMIN_WALL_TABS = [
  { label: "Stage", routeName: "adminStage", path: "/admin/stage" },
  { label: "Ticker", routeName: "adminTicker", path: "/admin/ticker" },
  { label: "Video", routeName: "adminVideo", path: "/admin/video" },
  { label: "Television", routeName: "adminTelevision", path: "/admin/television" },
]

function currentRouteName() {
  return FlowRouter.current()?.route?.name ?? null
}

Template.AdminWallNav.helpers({
  tabs() {
    const activeRouteName = currentRouteName()
    return ADMIN_WALL_TABS.map((tab) => ({
      ...tab,
      isActive: tab.routeName === activeRouteName,
    }))
  },
})
