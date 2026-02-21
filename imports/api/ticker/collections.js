import { Mongo } from "meteor/mongo"

export const DEFAULT_TICKER_WALL_ID = "default"

export const TickerClients = new Mongo.Collection("tickerClients")
export const TickerWalls = new Mongo.Collection("tickerWalls")
