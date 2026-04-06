import { Mongo } from "meteor/mongo"

import { DEFAULT_WALL_ID } from "/imports/api/wall/collections"

export const DEFAULT_TELEVISION_STATE_ID = DEFAULT_WALL_ID
export const TelevisionStates = new Mongo.Collection("televisionStates")
