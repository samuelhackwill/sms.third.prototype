import { WebApp } from "meteor/webapp"
import { execFile } from "node:child_process"
import { networkInterfaces } from "node:os"

const TENDA_ROUTER_IP = "10.73.73.5"

function detectLanIp() {
  const interfaces = networkInterfaces()
  const candidates = []

  Object.values(interfaces).forEach((entries) => {
    ;(entries ?? []).forEach((entry) => {
      if (!entry || entry.family !== "IPv4" || entry.internal) {
        return
      }

      candidates.push(entry.address)
    })
  })

  const preferred =
    candidates.find((address) => address.startsWith("10.73.73.")) ||
    candidates.find((address) => address.startsWith("192.168.")) ||
    candidates.find((address) => address.startsWith("10.")) ||
    candidates.find((address) => address.startsWith("172.")) ||
    candidates[0] ||
    null

  return preferred
}

function pingRouter() {
  return new Promise((resolve) => {
    execFile(
      "ping",
      ["-c", "1", "-W", "1000", TENDA_ROUTER_IP],
      { timeout: 2500 },
      (error, stdout, stderr) => {
        const combinedOutput = `${stdout ?? ""}\n${stderr ?? ""}`
        const latencyMatch = combinedOutput.match(/time[=<]([0-9.]+)/i)

        resolve({
          ok: !error,
          target: TENDA_ROUTER_IP,
          latencyMs: latencyMatch ? Number.parseFloat(latencyMatch[1]) : null,
          error: error ? error.message : null,
        })
      }
    )
  })
}

WebApp.connectHandlers.use("/api/sanity/router", async (req, res) => {
  if (req.method !== "GET") {
    res.writeHead(405, {
      Allow: "GET",
      "Content-Type": "application/json",
    })
    res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }))
    return
  }

  try {
    const result = await pingRouter()
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    })
    res.end(JSON.stringify(result))
  } catch (error) {
    res.writeHead(500, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    })
    res.end(
      JSON.stringify({
        ok: false,
        target: TENDA_ROUTER_IP,
        error: error instanceof Error ? error.message : "Unknown error",
      })
    )
  }
})

WebApp.connectHandlers.use("/api/sanity/host", (req, res) => {
  if (req.method !== "GET") {
    res.writeHead(405, {
      Allow: "GET",
      "Content-Type": "application/json",
    })
    res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }))
    return
  }

  const lanIp = detectLanIp()

  res.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  })
  res.end(
    JSON.stringify({
      ok: Boolean(lanIp),
      lanIp,
      tickerUrl: lanIp ? `http://${lanIp}:3000/ticker` : null,
    })
  )
})
