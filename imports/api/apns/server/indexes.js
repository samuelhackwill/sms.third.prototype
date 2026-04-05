import { ApnsDevices } from "/imports/api/apns/collections"

export async function ensureApnsIndexes() {
  const rawDevices = ApnsDevices.rawCollection()

  await rawDevices.createIndex({ token: 1 }, { unique: true, name: "apns_devices_token_unique" })
  await rawDevices.createIndex({ updatedAt: -1 }, { name: "apns_devices_updatedAt_desc" })
  await rawDevices.createIndex({ bundleId: 1 }, { name: "apns_devices_bundleId_asc" })
}
