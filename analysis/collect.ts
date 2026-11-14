// Downloads the reveal of every ended practice world (level >= 4) once and caches compact quote rows:
// [worldId, day, pickupPlace, deliveryPlace, option, price/list, won(1/0), level, dealerId]
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { Client } from "../typescript/spread.ts"
const c = new Client()
const out = new URL("./data/quotes.jsonl", import.meta.url).pathname
const done = new Set<string>(existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)[0]) : [])
const worlds = (await c.worlds()).filter((w) => w.ended && w.kind === "practice" && w.boardRun === null && w.level >= 4 && !done.has(w.worldId))
console.log(`${done.size} cached, ${worlds.length} to fetch`)
let fetched = 0, rows = 0
const queue = [...worlds]
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let w = queue.shift(); w; w = queue.shift()) {
    try {
      const rv = await c.world(w.worldId).reveal()
      const lines: string[] = []
      for (const r of rv.requests) {
        if (!r.quote) continue
        const leg = r.request.legs[0]!
        for (const [kind, price] of Object.entries(r.quote) as [string, number][]) {
          const opt = r.request.options.find((o) => o.kind === kind)
          if (!opt) continue
          const ratio = price / opt.listPriceCents
          if (ratio > 3) continue // a declining quote
          if (r.outcome === "won" && r.option !== kind) continue // dealer took another option: ambiguous
          lines.push(JSON.stringify([w.worldId, Math.floor(r.request.arrivedAt / 1440), leg.pickup.placeId, leg.delivery.placeId, kind, +ratio.toFixed(4), r.outcome === "won" ? 1 : 0, w.level, r.request.dealerId]))
        }
      }
      // a marker row so the world counts as cached even with no quotes
      lines.push(JSON.stringify([w.worldId, -1]))
      writeFileSync(out, lines.join("\n") + "\n", { flag: "a" })
      fetched++; rows += lines.length - 1
      if (fetched % 50 === 0) console.log(`${fetched}/${worlds.length} worlds, ${rows} rows`)
    } catch (e) { console.error(w.worldId, String(e).slice(0, 120)) }
  }
}))
console.log(`done: ${fetched} worlds, ${rows} rows`)
