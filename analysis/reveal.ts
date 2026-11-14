// Summarises an ended practice world: quote win rates by price/list, decline counts, driver fees vs typical fee.
import { Client } from "../typescript/spread.ts"
const c = new Client()
const id = process.argv[2]!
const w = c.world(id)
const [rv, events] = await Promise.all([w.reveal(), w.events()])
const bins = new Map<string, [number, number]>()
let declined = 0, unquoted = 0
const optionTaken = new Map<string, number>()
for (const r of rv.requests) {
  if (!r.quote) { unquoted++; continue }
  const entries = Object.entries(r.quote) as [string, number][]
  const first = r.request.options.find((o) => o.kind === entries[0]![0])!
  const ratio = entries[0]![1] / first.listPriceCents
  if (ratio > 3) { declined++; continue }
  const key = ratio.toFixed(2)
  const b = bins.get(key) ?? [0, 0]; b[0]++; if (r.outcome === "won") b[1]++; bins.set(key, b)
  if (r.option) optionTaken.set(r.option, (optionTaken.get(r.option) ?? 0) + 1)
}
console.log(`requests ${rv.requests.length}  unquoted ${unquoted}  declined ${declined}`)
console.log("price/list -> quoted, won, win%")
for (const [k, [n, won]] of [...bins].sort()) if (n >= 5) console.log(`  ${k}  ${n}  ${won}  ${(100 * won / n).toFixed(0)}%`)
console.log("options won", JSON.stringify(Object.fromEntries(optionTaken)))
// Fees: booked fee vs the request's typical fee per car
const reqs = new Map(rv.requests.map((r) => [r.request.id, r.request]))
const ratios: number[] = []
const gigOrder = new Map<string, string>()
const snap = await w.snapshot()
for (const g of snap.gigs) gigOrder.set(g.id, g.stops[0]!.orderId)
const gigCars = new Map(snap.gigs.map((g) => [g.id, g.stops.filter((s) => s.kind === "pickup").length]))
for (const e of events) if (e.kind === "gig_booked") {
  const r = reqs.get(gigOrder.get(e.gigId)!)
  if (r) ratios.push(e.feeCents / (r.referenceFeeCents * gigCars.get(e.gigId)! / r.legs.length))
}
ratios.sort((a, b) => a - b)
const q = (p: number) => ratios[Math.floor(p * (ratios.length - 1))]?.toFixed(2)
console.log(`bookings ${ratios.length}  fee/typical p10 ${q(0.1)} p50 ${q(0.5)} p90 ${q(0.9)}`)
const kinds = new Map<string, number>()
for (const e of events) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1)
console.log(JSON.stringify(Object.fromEntries([...kinds].filter(([k]) => !["gig_viewed", "ledger", "price_request"].includes(k)))))
const money = new Map<string, number>()
for (const e of events) if (e.kind === "ledger") money.set(e.line.kind, (money.get(e.line.kind) ?? 0) + e.line.cents / 100)
console.log("ledger €", JSON.stringify(Object.fromEntries([...money].map(([k, v]) => [k, Math.round(v)]))))
