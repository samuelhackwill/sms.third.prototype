import { Mongo } from "meteor/mongo"

import { DEFAULT_WALL_ID } from "/imports/api/wall/collections"

export const DEFAULT_KISS_O_MATIC_STATE_ID = DEFAULT_WALL_ID
export const KissOMaticStates = new Mongo.Collection("kissOMaticStates")
