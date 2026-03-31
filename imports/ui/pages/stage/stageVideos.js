export const STAGE_VIDEOS = {
  premiere: "/premiere.mp4",
  deuxieme: "/deuxieme.mp4",
}

export const DEFAULT_STAGE_VIDEO_KEY = "premiere"

export function videoSrcForKey(key) {
  return STAGE_VIDEOS[key] ?? STAGE_VIDEOS[DEFAULT_STAGE_VIDEO_KEY]
}
