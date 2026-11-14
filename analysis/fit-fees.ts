// Fits ln(booked fee / typical fee) = w[world] + p[pickup] + d[delivery] + h[hour posted] + b*ln(open/typical)
// by backfitting, holdout 20% of worlds, and the booking rate by lane. Writes typescript/fees.json:
// each place's fee effect in log units (positive = drivers need more there than the typical fee says).
import { readFileSync, writeFileSync } from "node:fs"
const raw = readFileSync(new URL("./data/gigs.jsonl", import.meta.url).pathname, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r[1] !== -1 && r[4] > 0)
const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)
const hourOf = (t: number) => Math.floor((t % 1440) / 180) // 3-hour buckets
type Row = { w: string; p: string; d: string; h: number; open: number; y: number | null; test: boolean }
const rows: Row[] = raw.map((r) => ({ w: r[0], p: r[1], d: r[2], h: hourOf(r[7]), open: Math.log(r[5] / r[4]), y: r[6] === null ? null : Math.log(r[6] / r[4]), test: hash(r[0]) % 5 === 0 }))
const booked = rows.filter((r) => r.y !== null)
function fit(data: Row[], places: boolean, frozen?: { p: Map<string, number>; d: Map<string, number>; h: Map<number, number>; b: number }) {
  const w = new Map<string, number>(), p = new Map(frozen?.p ?? []), d = new Map(frozen?.d ?? []), h = new Map(frozen?.h ?? [])
  let b = frozen?.b ?? 0
  const pred = (r: Row) => (w.get(r.w) ?? 0) + (places ? (p.get(r.p) ?? 0) + (d.get(r.d) ?? 0) : 0) + (h.get(r.h) ?? 0) + b * r.open
  const update = <K,>(m: Map<K, number>, key: (r: Row) => K, prior: number) => {
    const s = new Map<K, number>(), n = new Map<K, number>()
    for (const r of data) { const k = key(r); s.set(k, (s.get(k) ?? 0) + (r.y! - pred(r) + (m.get(k) ?? 0))); n.set(k, (n.get(k) ?? 0) + 1) }
    for (const [k, v] of s) m.set(k, v / (n.get(k)! + prior))
  }
  for (let it = 0; it < 25; it++) {
    update(w, (r) => r.w, 1)
    if (frozen) continue
    if (places) { update(p, (r) => r.p, 30); update(d, (r) => r.d, 30) }
    update(h, (r) => r.h, 30)
    let sxy = 0, sxx = 0
    for (const r of data) { const e = r.y! - pred(r) + b * r.open; sxy += r.open * e; sxx += r.open * r.open }
    b = sxy / sxx
  }
  const sse = data.reduce((s, r) => s + (r.y! - pred(r)) ** 2, 0)
  return { p, d, h, b, sse }
}
const train = booked.filter((r) => !r.test), test = booked.filter((r) => r.test)
for (const places of [false, true]) {
  const m = fit(train, places)
  const t = fit(test, places, m)
  console.log(`places ${places}: open coef ${m.b.toFixed(2)}  test RMSE ${Math.sqrt(t.sse / test.length).toFixed(4)}`)
}
const full = fit(booked, true)
// Booking rate by place, for context.
const rate = (key: (r: Row) => string) => { const m = new Map<string, [number, number]>(); for (const r of rows) { const k = key(r); const v = m.get(k) ?? [0, 0]; v[0]++; if (r.y !== null) v[1]++; m.set(k, v) } return m }
const rp = rate((r) => r.p), rd = rate((r) => r.d)
const names = new Map((await (await fetch("https://spread.bahnexpress.com/v1/map")).json()).places.map((x: { id: string; name: string }) => [x.id, x.name]))
const out = { pickup: Object.fromEntries([...full.p].map(([k, v]) => [k, +v.toFixed(4)])), delivery: Object.fromEntries([...full.d].map(([k, v]) => [k, +v.toFixed(4)])) }
writeFileSync(new URL("../typescript/fees.json", import.meta.url).pathname, JSON.stringify(out, null, 1))
console.log(`gigs ${rows.length}, booked ${booked.length}, hour effects ${[...full.h].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k * 3}h ${(100 * (Math.exp(v) - 1)).toFixed(0)}%`).join(" ")}`)
const show = (title: string, m: Map<string, number>, r: Map<string, [number, number]>) => console.log(title, [...m].sort((a, b) => b[1] - a[1]).map(([id, v]) => `${names.get(id)} ${(100 * (Math.exp(v) - 1)).toFixed(0)}% (${((100 * r.get(id)![1]) / r.get(id)![0]).toFixed(0)}% booked)`).join(", "))
show("pickup  fee vs typical:", full.p, rp)
show("delivery fee vs typical:", full.d, rd)
