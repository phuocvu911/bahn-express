// Fits P(win) = sigmoid(a[world,day] + p[pickup] + d[delivery] + o[option] - k*ln(price/list)) to the cached
// quotes, and writes typescript/lanes.json with each place's effect in log-price units (effect / k):
// the lane part of the competitor's price that holds in every world. Holdout: 20% of worlds.
import { readFileSync, writeFileSync } from "node:fs"
const rows = readFileSync(new URL("./data/quotes.jsonl", import.meta.url).pathname, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r[1] >= 0)
const ids = (m: Map<string, number>, k: string) => { let v = m.get(k); if (v === undefined) { v = m.size; m.set(k, v) } return v }
const WD = new Map<string, number>(), P = new Map<string, number>(), D = new Map<string, number>(), O = new Map<string, number>()
const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)
const data = rows.map((r) => ({ wd: ids(WD, `${r[0]}:${r[2 - 1]}`), p: ids(P, r[2]), d: ids(D, r[3]), o: ids(O, r[4]), x: Math.log(r[5]), y: r[6], test: hash(r[0]) % 5 === 0 }))
function fit(usePlaces: boolean, train: (r: (typeof data)[number]) => boolean, fixedPlaces?: { p: Float64Array; d: Float64Array; o: Float64Array; k: number }) {
  const a = new Float64Array(WD.size), p = new Float64Array(P.size), d = new Float64Array(D.size), o = new Float64Array(O.size)
  let k = fixedPlaces?.k ?? 5
  if (fixedPlaces) { p.set(fixedPlaces.p); d.set(fixedPlaces.d); o.set(fixedPlaces.o) }
  const lr = 0.5
  for (let epoch = 0; epoch < 150; epoch++) {
    const ga = new Float64Array(a.length), na = new Float64Array(a.length), gp = new Float64Array(p.length), np = new Float64Array(p.length)
    const gd = new Float64Array(d.length), nd = new Float64Array(d.length), go = new Float64Array(o.length), no = new Float64Array(o.length)
    let gk = 0, n = 0
    for (const r of data) {
      if (!train(r)) continue
      const z = a[r.wd]! + (usePlaces ? p[r.p]! + d[r.d]! : 0) + o[r.o]! - k * r.x
      const e = 1 / (1 + Math.exp(-z)) - r.y
      ga[r.wd]! += e; na[r.wd]!++; gp[r.p]! += e; np[r.p]!++; gd[r.d]! += e; nd[r.d]!++; go[r.o]! += e; no[r.o]!++
      gk += -e * r.x; n++
    }
    for (let i = 0; i < a.length; i++) if (na[i]) a[i]! -= (lr * 4 * ga[i]!) / (na[i]! + 5)
    if (!fixedPlaces) {
      if (usePlaces) {
        for (let i = 0; i < p.length; i++) if (np[i]) p[i]! -= (lr * 4 * gp[i]!) / (np[i]! + 50)
        for (let i = 0; i < d.length; i++) if (nd[i]) d[i]! -= (lr * 4 * gd[i]!) / (nd[i]! + 50)
        const mp = p.reduce((s, v) => s + v, 0) / p.length, md = d.reduce((s, v) => s + v, 0) / d.length
        for (let i = 0; i < p.length; i++) p[i]! -= mp
        for (let i = 0; i < d.length; i++) d[i]! -= md
      }
      for (let i = 0; i < o.length; i++) if (no[i]) o[i]! -= (lr * 4 * go[i]!) / (no[i]! + 50)
      k -= (lr * 8 * gk) / n
    }
  }
  return { a, p, d, o, k }
}
const logloss = (m: ReturnType<typeof fit>, usePlaces: boolean, pick: (r: (typeof data)[number]) => boolean) => {
  let s = 0, n = 0
  for (const r of data) if (pick(r)) { const z = m.a[r.wd]! + (usePlaces ? m.p[r.p]! + m.d[r.d]! : 0) + m.o[r.o]! - m.k * r.x; const q = 1 / (1 + Math.exp(-z)); s -= r.y ? Math.log(q) : Math.log(1 - q); n++ }
  return s / n
}
// Holdout: learn places on train worlds; on test worlds fit only their world-day levels, then score.
const train = (r: (typeof data)[number]) => !r.test, test = (r: (typeof data)[number]) => r.test
for (const usePlaces of [false, true]) {
  const m = fit(usePlaces, train)
  const mt = fit(usePlaces, test, m) // world-day levels of the test worlds, places frozen
  console.log(`places ${usePlaces}: k ${m.k.toFixed(2)}  train logloss ${logloss(m, usePlaces, train).toFixed(4)}  test logloss ${logloss(mt, usePlaces, test).toFixed(4)}`)
}
const full = fit(true, () => true)
const names = new Map((await (await fetch("https://spread.bahnexpress.com/v1/map")).json()).places.map((p: { id: string; name: string }) => [p.id, p.name]))
const out = { k: full.k, pickup: {} as Record<string, number>, delivery: {} as Record<string, number>, option: {} as Record<string, number> }
for (const [id, i] of P) out.pickup[id] = +(full.p[i]! / full.k).toFixed(4)
for (const [id, i] of D) out.delivery[id] = +(full.d[i]! / full.k).toFixed(4)
for (const [id, i] of O) out.option[id] = +(full.o[i]! / full.k).toFixed(4)
writeFileSync(new URL("../typescript/lanes.json", import.meta.url).pathname, JSON.stringify(out, null, 1))
console.log(`rows ${data.length}, world-days ${WD.size}, k ${full.k.toFixed(2)}`)
const show = (title: string, m: Record<string, number>) => console.log(title, Object.entries(m).sort((a, b) => b[1] - a[1]).map(([id, v]) => `${names.get(id) ?? id} ${(100 * (Math.exp(v) - 1)).toFixed(0)}%`).join(", "))
show("pickup  (price room vs average):", out.pickup)
show("delivery(price room vs average):", out.delivery)
show("option:", out.option)
