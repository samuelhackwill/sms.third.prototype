import { FlowRouter } from "meteor/ostrio:flow-router-extra"
import { streamer } from "/imports/both/streamer"
import { WALL_ROUTE_CONTROL_EVENT } from "/imports/ui/lib/wallRouteControl"

const WALL_ADMIN_TABS = [
  { routeName: "adminStage", path: "/admin/stage", label: "Stage" },
  { routeName: "adminTicker", path: "/admin/ticker", label: "Ticker" },
  { routeName: "adminVideo", path: "/admin/video", label: "Video" },
  { routeName: "adminTelevision", path: "/admin/television", label: "Television" },
]

const WALL_ROUTE_TARGETS = [
  { routeName: "adminTicker", target: "ticker", label: "Move Clients To /ticker" },
  { routeName: "adminVideo", target: "video", label: "Move Clients To /video" },
  { routeName: "adminTelevision", target: "television", label: "Move Clients To /television" },
]

export function currentAdminRouteName() {
  return FlowRouter.current()?.route?.name
}

export function buildAdminWallTabs(currentRouteName = currentAdminRouteName()) {
  return WALL_ADMIN_TABS.map((tab) => ({
    ...tab,
    isActive: tab.routeName === currentRouteName,
  }))
}

export function buildAdminWallRouteTargets(currentRouteName = currentAdminRouteName()) {
  return WALL_ROUTE_TARGETS.map((routeTarget) => ({
    ...routeTarget,
    isActive: routeTarget.routeName === currentRouteName,
  }))
}

export function emitWallRouteTarget(target) {
  if (!target) {
    return
  }

  streamer.emit(WALL_ROUTE_CONTROL_EVENT, { target })
}
