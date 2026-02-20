import { streamer } from "/imports/both/streamer"
import "/imports/startup/server/index.js"

streamer.allowRead("all")
streamer.allowWrite("all")
