import { Meteor } from "meteor/meteor"
import { WebApp } from "meteor/webapp"
import { connect as http2Connect } from "node:http2"
import { readFileSync } from "node:fs"
import { createPrivateKey, sign } from "node:crypto"

import { ApnsDevices } from "/imports/api/apns/collections"

const APNS_TEAM_ID = Meteor.settings.private?.apns?.teamId ?? null
const APNS_KEY_ID = Meteor.settings.private?.apns?.keyId ?? null
const APNS_KEY_PATH = Meteor.settings.private?.apns?.keyPath ?? null
const APNS_BUNDLE_ID = Meteor.settings.private?.apns?.bundleId ?? null
const APNS_HOST = Meteor.settings.private?.apns?.host ?? "https://api.push.apple.com"

function b64url(input) {
  return Buffer.from(input).toString("base64url")
}

function apnsConfigError() {
  if (!APNS_TEAM_ID || !APNS_KEY_ID || !APNS_KEY_PATH || !APNS_BUNDLE_ID) {
    throw new Meteor.Error(
      "apns.misconfigured",
      "Missing APNs config. Expected private.apns.teamId, keyId, keyPath, bundleId.",
    )
  }
}

function makeApnsJwt() {
  apnsConfigError()

  const header = {
    alg: "ES256",
    kid: APNS_KEY_ID,
    typ: "JWT",
  }

  const claims = {
    iss: APNS_TEAM_ID,
    iat: Math.floor(Date.now() / 1000),
  }

  const signingInput =
    `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`

  const privateKey = createPrivateKey(readFileSync(APNS_KEY_PATH, "utf8"))

  const signature = sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  })

  return `${signingInput}.${signature.toString("base64url")}`
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk
    })
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on("error", reject)
  })
}

function sendApnsAlert({ token, title, body }) {
  apnsConfigError()

  return new Promise((resolve, reject) => {
    const client = http2Connect(APNS_HOST)
    let statusCode = null
    let responseBody = ""

    client.on("error", reject)

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${makeApnsJwt()}`,
      "apns-topic": APNS_BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": "10",
    })

    req.setEncoding("utf8")

    req.on("response", (headers) => {
      statusCode = headers[":status"]
    })

    req.on("data", (chunk) => {
      responseBody += chunk
    })

    req.on("end", () => {
      client.close()
      let parsed = null
      try {
        parsed = responseBody ? JSON.parse(responseBody) : null
      } catch (error) {
        parsed = responseBody || null
      }
      resolve({ statusCode, body: parsed })
    })

    req.on("error", (error) => {
      client.close()
      reject(error)
    })

    const payload = {
      aps: {
        alert: {
          title,
          body,
        },
        sound: "default",
      },
    }

    req.end(JSON.stringify(payload))
  })
}

WebApp.connectHandlers.use("/api/apns/register", async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405)
    res.end("Method Not Allowed")
    return
  }

  try {
    const { token, bundleId, deviceName } = await readJsonBody(req)

    if (typeof token !== "string" || !token.trim()) {
      res.writeHead(400)
      res.end("Missing token")
      return
    }

    await ApnsDevices.upsertAsync(
      { token: token.trim() },
      {
        $set: {
          token: token.trim(),
          bundleId: typeof bundleId === "string" ? bundleId : null,
          deviceName: typeof deviceName === "string" ? deviceName : null,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
    )

    console.info("[apns] stored token", { deviceName, token })

    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: true }))
  } catch (error) {
    console.error("[apns] register failed", error)
    res.writeHead(500)
    res.end("Server error")
  }
})

export async function sendApnsYoToToken(token) {
  if (typeof token !== "string" || !token.trim()) {
    throw new Meteor.Error("apns.invalidToken", "token is required")
  }

  return sendApnsAlert({
    token: token.trim(),
    title: "yo",
    body: "yo",
  })
}
