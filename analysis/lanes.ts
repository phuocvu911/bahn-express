// Win rate of real quotes by drivers living near the delivery / pickup place, and by distance.
import { Client } from "../typescript/spread.ts"
const c = new Client()
const map = await c.map()
const byId = new Map(map.places.map((p) => [p.id, p]))
const minutes = new Map(map.roads.map((r) => [`${r.from}>${r.to}`, r.minutes]))
const km = (a: string, b: string) => { const p = byId.get(a)!, q = byId.get(b)!, r = Math.PI / 180; const x = Math.sin((q.lat - p.lat) * r / 2) ** 2 + Math.cos(p.lat * r) * Math.cos(q.lat * r) * Math.sin((q.lon - p.lon) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)) }
const g = new Map<string, [number, number, number]>()
const add = (k: string, won: boolean, ratio: number) => { const v = g.get(k) ?? [0, 0, 0]; v[0]++; if (won) v[1]++; v[2] += ratio; g.set(k, v) }
for (const id of process.argv.slice(2)) {
  const w = c.world(id)
  const [rv, roster] = await Promise.all([w.reveal(), w.roster()])
  const near = new Map<string, number>()
  for (const p of map.places) near.set(p.id, roster.filter((d) => km(d.homePlaceId, p.id) <= 30).length)
  for (const r of rv.requests) {
    if (!r.quote) continue
    const [kind, price] = Object.entries(r.quote)[0]! as [string, number]
    const opt = r.request.options.find((o) => o.kind === kind)!
    const ratio = price / opt.listPriceCents
    if (ratio > 3) continue
    const won = r.outcome === "won"
    const leg = r.request.legs[0]!
    const b = (n: number) => (n < 3 ? "0-2" : n < 10 ? "3-9" : n < 25 ? "10-24" : "25+")
    add(`deliv drivers ${b(near.get(leg.delivery.placeId)!)}`, won, ratio)
    add(`pick drivers ${b(near.get(leg.pickup.placeId)!)}`, won, ratio)
    const m = minutes.get(`${leg.pickup.placeId}>${leg.delivery.placeId}`)!
    add(`drive ${m < 60 ? "<1h" : m < 120 ? "1-2h" : m < 240 ? "2-4h" : "4h+"}`, won, ratio)
    add(`option ${kind}`, won, ratio)
  }
}
for (const [k, [n, w, r]] of [...g].sort()) console.log(k.padEnd(22), String(n).padStart(5), `${((100 * w) / n).toFixed(0)}% won`.padStart(9), `avg price/list ${(r / n).toFixed(2)}`)
