import { TickerClients, TickerWalls } from "/imports/api/ticker/collections"

export async function ensureTickerIndexes() {
  const rawClients = TickerClients.rawCollection()
  const rawWalls = TickerWalls.rawCollection()

  await rawClients.createIndex(
    { wallId: 1, orderIndex: 1 },
    { name: "ticker_clients_wall_order" },
  )
  await rawClients.createIndex(
    { wallId: 1, lastSeenAt: -1 },
    { name: "ticker_clients_wall_lastSeen_desc" },
  )
  await rawClients.createIndex(
    { shortCode: 1 },
    { name: "ticker_clients_shortcode" },
  )

  await rawWalls.createIndex(
    { layoutVersion: 1 },
    { name: "ticker_walls_layoutVersion" },
  )
}
