import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { firefox } from "playwright";
import { createController } from "../app.mjs";
import { SimulatedClient } from "../simulated-client.mjs";

const directory = await mkdtemp(join(tmpdir(), "phone-wall-ui-"));
const key = randomBytes(32).toString("hex");
const { app } = await createController({ dataDir: directory, adminToken: key });
await app.listen({ host: "127.0.0.1", port: 0 });
const base = `http://127.0.0.1:${app.server.address().port}`;
let browser;
const phone = new SimulatedClient(
  base.replace("http", "ws") + "/phone-wall/ws",
);
phone.connect();
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("phone registration timeout")),
      10000,
    );
    phone.once("welcome", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const configResponse = await app.inject({
    url: "/phone-wall/api",
    headers: { authorization: `Bearer ${key}` },
  });
  const initial = configResponse.json().state;
  initial.layout.slots = [
    {
      deviceId: phone.identity.deviceId,
      slotIndex: 0,
      geometry: { x: 0, y: 0, width: 375, height: 667 },
    },
  ];
  await app.inject({
    method: "POST",
    url: "/phone-wall/api",
    headers: { authorization: `Bearer ${key}` },
    payload: {
      action: "configure",
      config: initial,
      expectedRevision: initial.revision,
    },
  });
  browser = await firefox.launch({
    headless: true,
    ...(process.env.PHONE_WALL_BROWSER_EXECUTABLE
      ? { executablePath: process.env.PHONE_WALL_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
      viewport: { width: 1400, height: 1000 },
    }),
    errors = [],
    external = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("Browser error:", error.message);
  });
  await page.route("**/*", (route) => {
    if (
      !route
        .request()
        .url()
        .startsWith(base + "/")
    ) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(base + "/admin/phone-wall#operatorKey=" + key);
  await page.waitForFunction(
    () => document.querySelectorAll("#wall canvas").length === 30,
  );
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.locator('#advanced-panel').isVisible(),false);
  assert.equal(await page.locator('#control-panel').isVisible(),true);
  assert.equal(await page.locator('#login').isVisible(),false);
  await page.getByRole('button',{name:'Start Pairing Mode',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#pairing-status').textContent.includes('PAIRING ACTIVE'));
  await page.getByRole('button',{name:'Stop Pairing',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#pairing-status').textContent.includes('Pairing stopped'));
  await page.locator('#test-text-speed').focus();
  await page.keyboard.press('Home');
  for(let step=0;step<10;step++)await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#test-text-speed-value').textContent(),'120 logical px/s');
  const emojiMessage='Bla bla bla 🍆 ❤️ 👍🏽 👩🏽‍🔧 🇫🇷 👨‍👩‍👧‍👦';
  await page.locator('#test-text-message').fill(emojiMessage);
  await page.getByRole('button',{name:'Send Test Text',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#test-text-status').textContent.includes('Test sent to 1 phone'));
  assert.equal(phone.activeArtwork.release.definition.artworkId,'operator-test-text');
  assert.equal(phone.activeArtwork.release.definition.parameters.speed,120);
  assert.equal(phone.activeArtwork.release.definition.parameters.text,emojiMessage);
  const preview=await browser.newPage({viewport:{width:375,height:667}});
  await preview.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort());
  await preview.addInitScript(()=>{
    window.PhoneWall={onFrame:fn=>{window.drawTestText=fn;},ready:()=>{}};
    const measure=CanvasRenderingContext2D.prototype.measureText;
    window.textMeasureCount=0;
    CanvasRenderingContext2D.prototype.measureText=function(text){window.textMeasureCount++;return measure.call(this,text);};
  });
  const previewContext={...phone.activeArtwork.release.definition,parameters:{...phone.activeArtwork.release.definition.parameters,text:'I'},viewport:{x:0,y:0,width:375,height:667},geometry:{x:0,y:0,width:375,height:667},clockOffsetMs:0,startAtServerMs:Date.now(),playing:true};
  const encoded=Buffer.from(JSON.stringify(previewContext)).toString('base64');
  await preview.goto(base+`/artwork-preview/${phone.activeArtwork.release.id}/index.html#`+encodeURIComponent(encoded));
  await preview.waitForFunction(()=>typeof window.drawTestText==='function');
  const fit=await preview.evaluate(()=>{
    window.drawTestText(3);
    const canvas=document.querySelector('canvas'),context=canvas.getContext('2d'),pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
    let top=canvas.height,bottom=0,count=0;
    for(let index=0;index<pixels.length;index+=4)if(pixels[index]>150&&pixels[index+1]<70&&pixels[index+2]<70){const y=Math.floor(index/4/canvas.width);top=Math.min(top,y);bottom=Math.max(bottom,y);count++;}
    const measured=window.textMeasureCount;
    for(let frame=0;frame<60;frame++)window.drawTestText(3+frame/60);
    return {top:top/canvas.height,bottom:bottom/canvas.height,count,measured,after:window.textMeasureCount};
  });
  assert.ok(fit.count>1000,JSON.stringify(fit));
  assert.ok(fit.top>0&&fit.top<0.05,JSON.stringify(fit));
  assert.ok(fit.bottom>0.95&&fit.bottom<1,JSON.stringify(fit));
  assert.equal(fit.after,fit.measured,'Text metrics must stay cached between frames');
  await preview.evaluate(()=>window.drawTestText(3));
  if(process.env.PHONE_WALL_SCREENSHOT_PATH)await preview.screenshot({path:process.env.PHONE_WALL_SCREENSHOT_PATH});
  await preview.close();
  await page.getByRole('tab',{name:'Advanced',exact:true}).click();
  await page.locator("#scene [name=kind]").selectOption("solid");
  await page
    .getByRole("button", { name: "Build Release from Controls" })
    .click();
  await page.waitForFunction(
    () => document.querySelector("#artwork-releases").options.length === 2,
  );
  const solidDisplayed=new Promise(resolve=>phone.once('artwork',resolve));
  await page
    .getByRole("button", { name: "Prepare + Publish Target", exact: true })
    .click();
  await solidDisplayed;
  await page.waitForFunction(() =>
    document.querySelector("#deployments").textContent.includes("displayed"),
  );
  assert.equal(phone.activeArtwork.release.definition.elements[0].type, "rect");
  const beforeExhibition=JSON.parse(await page.locator('#config').inputValue()).revision;
  await page
    .getByRole("button", { name: "Start Exhibition", exact: true })
    .click();
  await page.waitForFunction(revision=>JSON.parse(document.querySelector('#config').value).revision>revision,beforeExhibition);
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("exhibition"),
  );
  const config = JSON.parse(await page.locator("#config").inputValue());
  config.groups = { gallery: [] };
  await page.locator("#config").fill(JSON.stringify(config));
  await page.getByRole("button", { name: "Apply Atomically" }).click();
  await page.waitForFunction(() =>
    document.querySelector("#scope").textContent.includes("gallery"),
  );
  await page.getByRole("button", { name: "Night Mode", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("night"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator("#wall canvas").count(), 30);
  const uploaded = await page.request.post(base + "/phone-wall/media", {
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "text/javascript",
    },
    data: 'if(!window.PIXI)throw new Error("Missing local Pixi");document.body.textContent="LOCAL ART EXECUTED";',
  });
  assert.equal(uploaded.status(), 201);
  const asset = await uploaded.json();
  const definition = {
    sceneSchemaVersion: 1,
    artworkId: "ui-web",
    artworkVersion: "1",
    canvas: { width: 375, height: 667 },
    background: "#000000",
    transition: { type: "cut", durationMs: 0 },
    elements: [
      {
        id: "web",
        type: "web",
        frame: { x: 0, y: 0, width: 375, height: 667 },
        asset: asset.hash,
      },
    ],
  };
  const auth = { authorization: `Bearer ${key}` };
  const created = await page.request.post(base + "/phone-wall/api", {
    headers: auth,
    data: { action: "release.create", definition },
  });
  assert.equal(created.status(), 200);
  const release = (await created.json()).release;
  const staged = await page.request.post(base + "/phone-wall/api", {
    headers: auth,
    data: {
      action: "release.deploy",
      releaseId: release.id,
      deviceIds: [phone.identity.deviceId],
      delayMs: 1000,
    },
  });
  assert.equal(staged.status(), 200);
  await page.locator("#wall article").first().click();
  await page.getByRole('button',{name:'Start Exhibition',exact:true}).click();
  await page.locator("#web-previews").check();
  await page
    .frameLocator('iframe[title="Web artwork preview slot 0"]')
    .getByText("LOCAL ART EXECUTED", { exact: true })
    .waitFor();
  await page.goto(base + `/experiment/${asset.hash}`);
  await page.getByText("LOCAL ART EXECUTED", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    "PASS UI: 30 virtual screens, live publication, modes, atomic groups, mobile viewport, local Pixi execution; external requests blocked",
  );
} finally {
  phone.stop();
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
