import { Mongo } from "meteor/mongo"

export const MESSAGE_SOURCES = ["osx_messages_app", "sim_router"]
export const PHONE_NUMBER_IDS = ["primary", "fallback"]
export const MESSAGE_STATUSES = ["raw", "imported", "approved", "hidden", "flagged"]

export const Messages = new Mongo.Collection("messages")
