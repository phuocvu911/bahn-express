// Caches one row per single-order gig of every ended practice world (level >= 4):
// [worldId, pickupPlace, deliveryPlace, cars, typicalFeeShare, openFee, bookedFee|null, postedAt, level]
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { Client } from "../typescript/spread.ts"
const c = new Client()
const out = new URL("./data/gigs.jsonl", import.meta.url).pathname
const done = new Set<string>(existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)[0]) : [])
const worlds = (await c.worlds()).filter((w) => w.ended && w.kind === "practice" && w.boardRun === null && w.level >= 4 && !done.has(w.worldId))
console.log(`${done.size} cached, ${worlds.length} to fetch`)
let fetched = 0, rows = 0
const queue = [...worlds]
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let w = queue.shift(); w; w = queue.shift()) {
    try {
      const world = c.world(w.worldId)
      const [snap, rv] = await Promise.all([world.snapshot(), world.reveal()])
      const req = new Map(rv.requests.map((r) => [r.request.id, r.request]))
      const lines: string[] = []
      for (const g of snap.gigs) {
        const orders = new Set(g.stops.map((s) => s.orderId))
        if (orders.size !== 1) continue
        const r = req.get(g.stops[0]!.orderId)
        if (!r) continue
        const first = g.stops[0]!, last = g.stops.at(-1)!
        const cars = g.stops.filter((s) => s.kind === "pickup").length
        const booked = ["booked", "working", "done"].includes(g.status) ? g.feeCents : null
        lines.push(JSON.stringify([w.worldId, r.legs[first.leg]!.pickup.placeId, r.legs[last.leg]!.delivery.placeId, cars, Math.round((r.referenceFeeCents * cars) / r.legs.length), g.schedule[0]!.feeCents, booked, g.postedAt, w.level]))
      }
      lines.push(JSON.stringify([w.worldId, -1]))
      writeFileSync(out, lines.join("\n") + "\n", { flag: "a" })
      fetched++; rows += lines.length - 1
      if (fetched % 100 === 0) console.log(`${fetched}/${worlds.length} worlds, ${rows} gigs`)
    } catch (e) { console.error(w.worldId, String(e).slice(0, 120)) }
  }
}))
console.log(`done: ${fetched} worlds, ${rows} gigs`)
