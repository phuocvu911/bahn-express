// Which won orders were late: by option, by drive minutes, by hour won, by drivers near pickup.
import { Client } from "../typescript/spread.ts"
const c = new Client()
const ids = process.argv.slice(2)
const map = await c.map()
const minutes = new Map(map.roads.map((r) => [`${r.from}>${r.to}`, r.minutes]))
const group = new Map<string, [number, number]>()
const add = (k: string, late: boolean) => { const g = group.get(k) ?? [0, 0]; g[0]++; if (late) g[1]++; group.set(k, g) }
for (const id of ids) {
  const w = c.world(id)
  const [events, roster] = await Promise.all([w.events(), w.roster()])
  const homes = new Map<string, number>()
  for (const d of roster) homes.set(d.homePlaceId, (homes.get(d.homePlaceId) ?? 0) + 1)
  const late = new Set<string>()
  for (const e of events) if (e.kind === "ledger" && e.line.orderId && ["late_refund", "undelivered_penalty"].includes(e.line.kind)) late.add(e.line.orderId)
  const cancelled = new Set(events.flatMap((e) => (e.kind === "order_cancelled" ? [e.orderId] : [])))
  for (const e of events) {
    if (e.kind !== "order_won" || cancelled.has(e.order.id)) continue
    const o = e.order, l = o.legs[0]!, isLate = late.has(o.id)
    const drive = minutes.get(`${l.pickup.placeId}>${l.delivery.placeId}`) ?? 0
    const slack = o.lastPickupAt - e.at
    add(`option ${o.option}`, isLate)
    add(`drive ${drive < 90 ? "<1.5h" : drive < 180 ? "1.5-3h" : drive < 300 ? "3-5h" : ">5h"}`, isLate)
    add(`slack ${slack < 180 ? "<3h" : slack < 360 ? "3-6h" : slack < 720 ? "6-12h" : ">12h"}`, isLate)
    const h = homes.get(l.pickup.placeId) ?? 0
    add(`homeDrivers@pickup ${h === 0 ? "0" : h < 3 ? "1-2" : h < 8 ? "3-7" : "8+"}`, isLate)
    add(`legs ${o.legs.length}`, isLate)
    add(`private ${l.pickup.privateAddress || l.delivery.privateAddress}`, isLate)
    add(`day ${Math.floor(e.at / 1440)}`, isLate)
  }
}
for (const [k, [n, l]] of [...group].sort()) console.log(k.padEnd(26), String(n).padStart(4), String(l).padStart(4), `${((100 * l) / n).toFixed(1)}% late`)
