// When and at which schedule step gigs get booked; drops; views per gig.
import { Client } from "../typescript/spread.ts"
const c = new Client()
for (const id of process.argv.slice(2)) {
  const w = c.world(id)
  const [events, snap] = await Promise.all([w.events(), w.snapshot()])
  const gigs = new Map(snap.gigs.map((g) => [g.id, g]))
  const stepHist = new Map<number, number>(), waitHist = new Map<string, number>()
  let drops = 0, books = 0, unbooked = 0
  const views = new Map<string, number>()
  for (const e of events) {
    if (e.kind === "gig_viewed") views.set(e.gigId, (views.get(e.gigId) ?? 0) + 1)
    if (e.kind === "gig_dropped") drops++
    if (e.kind !== "gig_booked") continue
    books++
    const g = gigs.get(e.gigId)!
    const step = g.schedule.findIndex((s) => s.feeCents === e.feeCents)
    stepHist.set(step, (stepHist.get(step) ?? 0) + 1)
    const wait = e.at - g.postedAt
    const k = wait < 15 ? "<15m" : wait < 60 ? "15-60m" : wait < 180 ? "1-3h" : wait < 720 ? "3-12h" : ">12h"
    waitHist.set(k, (waitHist.get(k) ?? 0) + 1)
  }
  for (const g of snap.gigs) if (g.status === "withdrawn" && !events.some((e) => e.kind === "gig_booked" && e.gigId === g.id)) unbooked++
  const v = [...views.values()].sort((a, b) => a - b)
  console.log(id, `bookings ${books} drops ${drops} withdrawn-unbooked ${unbooked} gigs ${snap.gigs.length} views/gig p50 ${v[v.length >> 1]}`)
  console.log("  booked at step", JSON.stringify(Object.fromEntries([...stepHist].sort((a, b) => a[0] - b[0]))), " wait", JSON.stringify(Object.fromEntries(waitHist)))
}
