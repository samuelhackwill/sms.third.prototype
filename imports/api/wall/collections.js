import { Mongo } from "meteor/mongo"

export const DEFAULT_WALL_ID = "default"

export const WallClients = new Mongo.Collection("tickerClients")
export const Walls = new Mongo.Collection("tickerWalls")
