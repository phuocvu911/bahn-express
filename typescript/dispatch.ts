/** Dispatch v1 ("lite"): the kit's starter plus
 *  - selective, margin-aware quoting (markup over list, adapted to wins/losses, decline bad lanes),
 *  - a capacity guard that declines new work when too many near-term orders have no driver,
 *  - driver-supply awareness from the roster + map (drivers living near pickup / delivery),
 *  - shortage-level fee schedules (open higher, rise faster) capped against the order price,
 *  - direct offers to drivers who already viewed an order's gigs when its deadline warning comes,
 *  - a --seeds option to play several practice worlds in parallel for comparing settings.
 * Run: `bun dispatch.ts --level 8 --seed spread-1`. See README.md in the project root. */
import { existsSync, readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { Client, SpreadError, Unreachable, World } from "./spread.ts"
import type { Action, ActionResult, DeskEvent, DeskEventKind, DeskSnapshot, DriverProfile, FeeStep, Note, Order, PostAction, PriceRequest, Score, StopRef, TimeWindow } from "./spread.ts"

/** The knobs of the system. Each has a CLI flag so you can sweep them over seeds. */
type Tune = {
  markup: number // quote = list price x markup (start value; it adapts during the week)
  feeMult: number // expected driver fee = typical fee x feeMult (x supply factor) at levels 7-8
  staffingReserve: number // expected fee multiplier used to reject work that only pays if it books before the deadline raise
  priceWarDiscount: number // temporary price multiplier after a level-8 price-war loss cluster
  placeDayStep: number // learning step for the pickup and delivery place price signal within one day
  snowReserve: number // staffing-cost multiplier where a forecast overlaps the order's remaining window
  outagePremium: number // temporary price premium for a place with a strong weekday win cluster
  distanceDayStep: number // learning step for short / medium / long route price room within one day
  dealerStep: number // bounded dealer-specific price learning from quoted decisions
  minMargin: number // decline when (price - expected fee) / price is below this
  cap: number // decline when this many orders due for pickup within `horizon` hours have no driver
  horizon: number
  bulkCap: number // at most this many cars quoted from one bulk batch
  markupRange: number // how far above its start the markup may adapt
  open: number // opening driver fee = typical fee x open (levels 7-8); the schedule rises from it
  minSlack: number // hours from the quote to the last pickup an option must leave to find a driver
  winTarget: number // the markup adapts towards winning this share of real quotes
  pair: boolean // put two orders into one gig when the first ends near the second's pickup
  pairTransfer: number // max road minutes from the first car's delivery to the second car's pickup
  pairOpen: number // a pair gig opens at (sum of both typical fees) x open x pairOpen
  pairWait: number // hours an unbooked pair gig waits before it is split into two gigs
  laneOption: number // weight of the lane table's option part (same-day / next-day / 3-day)
  feeTable: number // weight of the fee table in expected and opening fees (0 = off)
  laneTable: number // weight of the lane table in quotes (0 = off, 1 = as fitted)
  laneStep: number // learning step of the per-category price adjustment (delivery-place drivers x option); 0 = off
  chain: number // direct-offer fee for a driver who finishes one of our gigs near the pickup, x the opening fee (0 = off)
  chainReach: number // max road minutes from where that driver finishes to the pickup
  stepMin: number // minutes between fee raises in a normal schedule (levels 7-8 and pair gigs)
  trust: number // level 8: price bonus per on-time order delivered to the dealer (0.01 = the full 1%)
  pairPrice: number // quote multiplier for a request that would pair with one of our open gigs
  tradeIns: boolean // quote trade-ins (two cars)?
  privates: boolean // quote cars to or from a private address?
}

function defaultTune(level: number): Tune {
  const shortage = level >= 7
  return {
    markup: level <= 3 ? 1 : level === 8 ? 1.35 : level === 7 ? 1.22 : 1.0,
    feeMult: shortage ? 1.25 : 1.1,
    staffingReserve: shortage ? 1.6 : 1,
    priceWarDiscount: level === 8 ? 0.82 : 1,
    placeDayStep: shortage ? 0.04 : 0,
    snowReserve: 1,
    outagePremium: shortage ? 0.1 : 0,
    distanceDayStep: 0,
    dealerStep: 0,
    minMargin: shortage ? 0.15 : 0.1,
    cap: shortage ? 22 : 40,
    horizon: 12,
    bulkCap: shortage ? 10 : 15,
    markupRange: shortage ? 0.8 : 0.4,
    open: shortage ? 0.85 : 1.2,
    minSlack: shortage ? 7 : 3,
    winTarget: 1 / 3,
    pair: level >= 3,
    pairTransfer: 30,
    pairOpen: 0.8,
    pairWait: 2,
    pairPrice: 0.92,
    // At level 8, each on-time delivery to a dealer raises the price that dealer
    // accepts by 1%, up to 25%. Desk already tracks that history as it delivers.
    trust: level === 8 ? 0.01 : 0,
    stepMin: 30,
    chain: shortage ? 0.9 : 0,
    laneStep: 0,
    laneTable: 0,
    feeTable: 0,
    laneOption: 1,
    chainReach: 45,
    tradeIns: !shortage,
    privates: !shortage,
  }
}

/** The lane table (lanes.json, from analysis/fit.ts over ~900 practice weeks): how much more or less
 * than average dealers accept on each pickup place, delivery place and option, in log-price units.
 * It is the part of the competitor's price that holds in every world. */
type LaneTable = { pickup: Record<string, number>; delivery: Record<string, number>; option: Record<string, number> }
const LANES_FILE = new URL("./lanes.json", import.meta.url).pathname
const LANES: LaneTable | null = existsSync(LANES_FILE) ? JSON.parse(readFileSync(LANES_FILE, "utf8")) : null
/** The fee table (fees.json, from analysis/fit-fees.ts over ~250k gigs): how much more or less than the
 * typical fee drivers book at, by pickup and delivery place, in log units. */
const FEES_FILE = new URL("./fees.json", import.meta.url).pathname
const FEES: { pickup: Record<string, number>; delivery: Record<string, number> } | null = existsSync(FEES_FILE) ? JSON.parse(readFileSync(FEES_FILE, "utf8")) : null

/** Where drivers live: for each place, the drivers whose home is within 30 km in a straight line
 * (the app's notification radius). */
type Market = { near: Map<string, number>; median: number; drivers: Map<string, DriverProfile>; minutes: Map<string, number> }

async function loadMarket(client: Client, world: World): Promise<Market> {
  const [map, roster] = await Promise.all([client.map(), world.roster()])
  const homes = new Map<string, number>()
  for (const driver of roster) homes.set(driver.homePlaceId, (homes.get(driver.homePlaceId) ?? 0) + 1)
  const byId = new Map(map.places.map((place) => [place.id, place]))
  const near = new Map<string, number>()
  for (const place of map.places) {
    let count = 0
    for (const [home, drivers] of homes) {
      const other = byId.get(home)
      if (other && km(place.lat, place.lon, other.lat, other.lon) <= 30) count += drivers
    }
    near.set(place.id, count)
  }
  const sorted = [...near.values()].sort((a, b) => a - b)
  const median = Math.max(1, sorted[Math.floor(sorted.length / 2)] ?? 1)
  const minutes = new Map(map.roads.map((road) => [`${road.from}>${road.to}`, road.minutes]))
  return { near, median, drivers: new Map(roster.map((driver) => [driver.id, driver])), minutes }
}

function km(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(a))
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

const HOUR = 60
const DAY = 24 * HOUR
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
/** The events that need an answer. Views and account lines arrive with the next event that needs an answer. */
const WAKE_ON: DeskEventKind[] = ["price_request", "order_won", "order_changed", "order_cancelled", "visit_failed", "gig_expired", "deadline_close"]

/** How to post a leg again after a failed visit. */
type Retry = { pickupFrom: number; manualLicence: boolean; plates: boolean }
const FIRST_TRY: Retry = { pickupFrom: 0, manualLicence: false, plates: false }

/** Requirements that are expensive to discover only after the first driver arrives. */
function initialRequirements(note: Note | null): Retry {
  const text = note?.text.toLowerCase() ?? ""
  const manualLicence = /manuaal|\bmanual\b|manuell/.test(text)
  const plates = /(?:ei|ilman|utan|without|no|saknar|saknas|missing)[^.\n]{0,24}(?:kilv|rekister|plate|skylt)|(?:kilv|plates?|skylt)[^.\n]{0,16}(?:puuttuu|missing|saknas)|siirtokilv|kilve?tön|unregistered/.test(text)
  return { pickupFrom: 0, manualLicence, plates }
}

/** What the starter remembers, and its answer to each event. The answers wait in the outbox
 * until the starter sends them, and the world applies them at the current minute. */
class Desk {
  readonly world: World
  readonly level: number
  now: number
  readonly outbox: Action[] = [] // the actions decided since the starter last sent
  readonly requests = new Map<string, PriceRequest>()
  readonly orders = new Map<string, Order>() // the orders won and not cancelled
  readonly legGigs = new Map<string, Map<number, string>>() // order id -> leg -> the gig that carries the leg
  readonly booked = new Set<string>() // the gigs that a driver holds now
  readonly posts = new Map<string, PostAction>() // gig id -> the post that made it
  readonly urgent = new Set<string>() // the orders whose deadline warning has come
  readonly market: Market
  readonly tune: Tune
  markup: number // the current quote markup over list; moves with wins and losses
  readonly quoted = new Set<string>() // requests that got a real (not declining) quote
  readonly bulk = new Map<string, number>() // batch id -> cars quoted for real
  readonly viewers = new Map<string, Set<string>>() // order id -> drivers who viewed its gigs
  readonly offers = new Map<string, number>() // "driver@day" -> direct offers sent that day
  readonly offeredAt = new Map<string, number>() // gig id -> minute of the last round of offers
  readonly late = new Set<string>() // orders with a late refund or penalty
  taken = 0 // requests quoted for real
  declined = 0 // requests declined (by margin, capacity or bulk cap)
  readonly why = { margin: 0, cap: 0, bulk: 0, risky: 0 } // decline reasons (levels 4+)
  readonly pairs = new Map<string, number>() // pair gig id -> minute posted (gigs carrying two orders)
  paired = 0 // pair gigs posted
  pairQuotes = 0 // options quoted at the pair price
  readonly finishing = new Map<string, { placeId: string; at: number }>() // driver -> where and when they end their last gig of ours
  readonly gigDriver = new Map<string, string>() // gig id -> the driver who booked it
  readonly chained = new Set<string>() // gigs that got chain offers
  chainOffers = 0
  chainAccepted = 0
  lateDriverReleases = 0
  readonly lane = new Map<string, number>() // price category -> learned multiplier
  readonly placeDay = new Map<string, number>() // day x place price multiplier, learned from won and lost quotes
  readonly outageVotes = new Map<string, { won: number; total: number }>() // day x place weekday decisions
  readonly outagePlaces = new Set<string>() // day x place where the competitor likely has an outage
  readonly distanceDay = new Map<string, number>() // day x distance bucket price multiplier
  readonly quotedLanes = new Map<string, Map<string, string>>() // request id -> option -> category
  readonly dealerTrust = new Map<string, number>() // dealer id -> our on-time count with it (level 8: max 25, halved by a late order)
  readonly dealerPrice = new Map<string, number>() // dealer-specific price room, corrected by wins and losses
  pairsBooked = 0 // pair gigs that a driver booked
  readonly decisions: { day: number; won: boolean }[] = [] // recent quoted decisions for level-8 price-war detection
  priceWarDay: number | null = null
  readonly snow: { from: number; to: number; places: Set<string> }[] = []

  constructor(world: World, level: number, now: number, market: Market, tune: Tune) {
    this.world = world
    this.level = level
    this.now = now
    this.market = market
    this.tune = tune
    this.markup = tune.markup
  }

  /** Drivers near a place, relative to a typical place: below 1 means few drivers. */
  supply(placeId: string): number {
    return (this.market.near.get(placeId) ?? 0) / this.market.median
  }

  /** What we expect to pay drivers for a request's cars. Few drivers near the pickup make it dearer;
   * drivers living near the delivery make it cheaper (their trip home is short). */
  expectedFee(request: PriceRequest): number {
    const leg = request.legs[0]!
    const s = this.supply(leg.pickup.placeId) + 0.5 * this.supply(leg.delivery.placeId)
    const factor = clamp(Math.sqrt(1.5 / Math.max(0.05, s)), 0.85, 1.8)
    return request.referenceFeeCents * this.tune.feeMult * factor * this.feeFactor(leg.pickup.placeId, leg.delivery.placeId)
  }

  recordForecast(event: Extract<DeskEvent, { kind: "forecast" }>): void {
    this.snow.push({ from: event.from, to: event.to, places: new Set(event.placeIds) })
  }

  /** Snow slows a trip and makes some drivers drop their bookings. Hold a larger staffing reserve
   * when its window overlaps the remaining work at either end of the route. */
  snowFactor(request: PriceRequest, deadline: number): number {
    if (this.tune.snowReserve <= 1) return 1
    const places = new Set(request.legs.flatMap((leg) => [leg.pickup.placeId, leg.delivery.placeId]))
    return this.snow.some((snow) => snow.to >= this.now && snow.from <= deadline && [...places].some((place) => snow.places.has(place))) ? this.tune.snowReserve : 1
  }

  /** A quote must still leave its minimum margin after a likely deadline-close raise.
   * The reserve rises from 1 at 12 hours of slack to its maximum at `minSlack`.
   * The absolute top urgent fee is intentionally uncapped against price, so using it
   * directly would reject every job. */
  worstCaseStaffingCost(request: PriceRequest, deadline: number): number {
    const span = 5 * HOUR
    const risk = clamp((((this.tune.minSlack * HOUR + span) - this.slack(request, deadline)) / span), 0, 1)
    return this.expectedFee(request) * (1 + (this.tune.staffingReserve - 1) * risk)
  }

  /** Minutes from the dealer's decision to the last pickup that still delivers every car by
   * `deadline` (the road minutes of the slowest leg). Short slack means few drivers can still book. */
  slack(request: PriceRequest, deadline: number): number {
    const drive = Math.max(...request.legs.map((leg) => this.market.minutes.get(`${leg.pickup.placeId}>${leg.delivery.placeId}`) ?? 0))
    return deadline - drive - request.respondBy
  }

  /** Orders that must be picked up soon and still have a car without a booked driver. */
  unassignedSoon(): number {
    let count = 0
    for (const order of this.orders.values()) {
      if (order.deliveredAt.every((at) => at !== null)) continue
      if (order.lastPickupAt > this.now + this.tune.horizon * HOUR) continue
      const gigs = this.gigsOf(order.id)
      if (gigs.length === 0 || gigs.some((gig) => !this.booked.has(gig))) count++
    }
    return count
  }

  /** The share of orders that are late or at risk. Above ~6% the desk takes less new work. */
  risk(): number {
    let atRisk = this.late.size
    for (const id of this.urgent) if (!this.late.has(id) && this.orders.has(id)) atRisk++
    return atRisk / Math.max(30, this.orders.size)
  }

  overloaded(): boolean {
    const cap = this.risk() > 0.06 ? Math.floor(this.tune.cap / 2) : this.tune.cap
    return this.unassignedSoon() >= cap
  }

  /** Rebuilds what it knows from the world, so a starter that stopped keeps its orders. Then answers
   * what it missed: open requests, orders without a gig, failed visits without a new gig, and the
   * deadline warnings, so the orders that had one keep their steep fees. */
  async rejoin(snapshot: DeskSnapshot, history: DeskEvent[]): Promise<void> {
    const posted = Map.groupBy(snapshot.gigs, (gig) => gig.stops[0]!.orderId) // order id -> its gigs, oldest first
    for (const gig of snapshot.gigs) if (["booked", "working", "done"].includes(gig.status)) this.booked.add(gig.id)
    for (const gig of snapshot.gigs) if (["open", "booked", "working"].includes(gig.status)) this.carry({ type: "post", stops: gig.stops, audience: gig.audience, schedule: gig.schedule }, gig.id)
    for (const event of history) if (event.kind === "price_request") this.requests.set(event.request.id, event.request)
    for (const event of history) if (event.kind === "deadline_close") this.urgent.add(event.orderId)
    for (const order of snapshot.orders) if (this.requests.has(order.id) && order.status !== "cancelled") this.orders.set(order.id, order)
    for (const order of this.orders.values()) if (order.status === "waiting" && this.gigsOf(order.id).length === 0) await this.post(order, undelivered(order))
    for (const event of history) {
      const order = "orderId" in event ? this.orders.get(event.orderId) : undefined
      if (!order) continue
      if (event.kind === "visit_failed" && order.deliveredAt[event.leg] === null) {
        const later = (posted.get(order.id) ?? []).filter((gig) => gig.postedAt >= event.at && gig.id !== event.gigId)
        if (!later.some((gig) => gig.stops.some((stop) => stop.leg === event.leg))) await this.retry(order.id, event.leg, event.reason)
      }
    }
    for (const gig of snapshot.gigs) if (gig.status === "open" && new Set(gig.stops.map((stop) => stop.orderId)).size > 1) this.pairs.set(gig.id, gig.postedAt)
    for (const event of history) if (event.kind === "gig_viewed" || event.kind === "ledger" || event.kind === "forecast") await this.handle(event)
    for (const request of snapshot.openRequests) this.quote(request)
  }

  async handle(event: DeskEvent): Promise<void> {
    if (event.kind === "price_request") this.quote(event.request)
    else if (event.kind === "order_won") await this.win(event.order)
    else if (event.kind === "order_changed") await this.change(event.order)
    else if (event.kind === "forecast") this.recordForecast(event)
    // The world has stopped a cancelled order's car and told each of its gigs what happens.
    else if (event.kind === "order_cancelled") {
      for (const books of [this.orders, this.legGigs]) books.delete(event.orderId)
      for (const gig of event.gigs) if (gig.outcome === "withdrawn" && this.pairs.has(gig.gigId)) this.unpair(gig.gigId, true)
    }
    else if (event.kind === "visit_failed") await this.retry(event.orderId, event.leg, event.reason)
    else if (event.kind === "driver_late") await this.replaceLateDriver(event.gigId, event.pickupAt)
    else if (event.kind === "gig_expired") this.repost(event.gigId)
    // It comes again when a driver drops the car after the first warning.
    else if (event.kind === "deadline_close") await this.raise(event.orderId)
    else if (event.kind === "gig_booked") {
      this.booked.add(event.gigId)
      if (this.pairs.has(event.gigId)) this.pairsBooked++
      this.gigDriver.set(event.gigId, event.driverId)
      const end = this.gigEnd(event.gigId)
      const known = this.finishing.get(event.driverId)
      if (end && (!known || known.at < end.at)) this.finishing.set(event.driverId, end)
    } else if (event.kind === "offer_answered" && event.answer === "accepted" && this.chained.has(event.gigId)) this.chainAccepted++
    // After a no-show the gig is open again, as after a drop. A late driver still comes.
    else if (event.kind === "gig_dropped" || event.kind === "no_show") this.booked.delete(event.gigId)
    else if (event.kind === "delivered") this.delivered(event.orderId, event.leg, event.at)
    else if (event.kind === "gig_viewed") {
      for (const orderId of new Set(this.posts.get(event.gigId)?.stops.map((stop) => stop.orderId)))
        this.viewers.set(orderId, (this.viewers.get(orderId) ?? new Set()).add(event.driverId))
    } else if (event.kind === "ledger" && event.line.orderId && ["late_refund", "undelivered_penalty"].includes(event.line.kind)) this.late.add(event.line.orderId)
    if (event.kind === "order_won" || event.kind === "order_lost") this.learn(event.kind === "order_won" ? event.order.id : event.requestId, event.kind === "order_won", event.kind === "order_won" ? event.order.option : null)
  }

  /** Moves the markup: a win says we could ask a little more, a loss that we asked too much.
   * Losses move it more, so the desk settles near a win rate of about one in three. */
  learn(requestId: string, won: boolean, option: string | null): void {
    if (this.level <= 3 || !this.quoted.delete(requestId)) return
    this.detectPriceWar(won)
    this.learnPlaceDay(requestId, won)
    this.detectOutage(requestId, won)
    this.learnDistanceDay(requestId, won)
    this.learnDealer(requestId, won)
    // Per category: the option won moves up; on a loss every quoted option moves down.
    const lanes = this.quotedLanes.get(requestId)
    this.quotedLanes.delete(requestId)
    const t = this.tune.winTarget
    for (const [kind, key] of lanes ?? []) {
      if (won && kind !== option) continue
      const step = won ? this.tune.laneStep * (1 - t) : -this.tune.laneStep * t
      this.lane.set(key, clamp((this.lane.get(key) ?? 1) + step, 0.8, 1.3))
    }
    const lo = Math.max(1, this.tune.markup - 0.2)
    this.markup = clamp(this.markup + (won ? 0.015 * (1 - this.tune.winTarget) : -0.015 * this.tune.winTarget), lo, this.tune.markup + this.tune.markupRange)
  }

  /** Level 8 has one weekday where the competitor cuts prices by 20%. A persistent loss
   * cluster during the day is stronger evidence than one bad lane, so cut only for that day. */
  detectPriceWar(won: boolean): void {
    if (this.level !== 8 || this.priceWarDay !== null) return
    const day = Math.floor(this.now / DAY)
    const minute = this.now % DAY
    if (day > 4 || minute < 8 * HOUR || minute >= 18 * HOUR) return
    this.decisions.push({ day, won })
    while (this.decisions.length > 20 || this.decisions[0]?.day !== day) this.decisions.shift()
    if (this.decisions.length < 12) return
    const wins = this.decisions.filter((decision) => decision.won).length
    if (wins / this.decisions.length <= 0.1) this.priceWarDay = day
  }

  /** Dealers differ in price sensitivity, and the competitor responds to our history with each one.
   * Keep a small, bounded correction per dealer so repeated wins probe upward while later losses
   * pull bids back without disturbing profitable dealers elsewhere. */
  learnDealer(requestId: string, won: boolean): void {
    if (this.tune.dealerStep <= 0) return
    const request = this.requests.get(requestId)
    if (!request) return
    const delta = (won ? 1 - this.tune.winTarget : -this.tune.winTarget) * this.tune.dealerStep
    this.dealerPrice.set(request.dealerId, clamp((this.dealerPrice.get(request.dealerId) ?? 1) + delta, 0.92, 1.08))
  }

  /** The level 8 outage makes the competitor's regional backup about 30% dearer from
   * 08:00 to 18:00. A strongly winning place is an actionable local signal; use a
   * smaller premium because a short burst can still be ordinary quote noise. */
  detectOutage(requestId: string, won: boolean): void {
    if (this.level < 6 || this.tune.outagePremium <= 0) return
    const request = this.requests.get(requestId)
    if (!request) return
    const day = Math.floor(request.arrivedAt / DAY)
    const minute = request.arrivedAt % DAY
    if (day > 4 || minute < 8 * HOUR || minute >= 18 * HOUR) return
    const leg = request.legs[0]!
    for (const place of new Set([leg.pickup.placeId, leg.delivery.placeId])) {
      const key = `${day}:${place}`
      const votes = this.outageVotes.get(key) ?? { won: 0, total: 0 }
      votes.total++
      if (won) votes.won++
      this.outageVotes.set(key, votes)
      if (votes.total >= 8 && votes.won / votes.total >= 0.75) this.outagePlaces.add(key)
    }
  }

  /** A long route's real cost depends on whether its pickup and destination have work that day.
   * Learn price room separately for both places, with a bounded adjustment because a single
   * decision is noisy. The day in the key resets the signal every morning. */
  learnPlaceDay(requestId: string, won: boolean): void {
    if (this.tune.placeDayStep <= 0) return
    const request = this.requests.get(requestId)
    if (!request) return
    const day = Math.floor(request.arrivedAt / DAY)
    const leg = request.legs[0]!
    const places = [...new Set([leg.pickup.placeId, leg.delivery.placeId])]
    const delta = (won ? 1 - this.tune.winTarget : -this.tune.winTarget) * this.tune.placeDayStep / places.length
    for (const place of places) {
      const key = `${day}:${place}`
      this.placeDay.set(key, clamp((this.placeDay.get(key) ?? 1) + delta, 0.82, 1.25))
    }
  }

  /** The competitor changes its short and long lane prices in opposite directions once a week.
   * Keep a separate bounded signal for each distance bucket, reset every day. */
  learnDistanceDay(requestId: string, won: boolean): void {
    if (this.tune.distanceDayStep <= 0) return
    const request = this.requests.get(requestId)
    if (!request) return
    const key = `${Math.floor(request.arrivedAt / DAY)}:${this.distanceBucket(request)}`
    const delta = (won ? 1 - this.tune.winTarget : -this.tune.winTarget) * this.tune.distanceDayStep
    this.distanceDay.set(key, clamp((this.distanceDay.get(key) ?? 1) + delta, 0.82, 1.25))
  }

  delivered(orderId: string, leg: number, at: number): void {
    this.legGigs.get(orderId)?.delete(leg)
    const order = this.orders.get(orderId)
    if (!order) return
    order.deliveredAt[leg] = at
    if (order.deliveredAt.some((t) => t === null)) return
    // The dealer counts the order: on time raises its trust in us, late halves it.
    const count = this.dealerTrust.get(order.dealerId) ?? 0
    const onTime = order.deliveredAt.every((t) => t! <= order.deadline) && !this.late.has(orderId)
    this.dealerTrust.set(order.dealerId, onTime ? Math.min(25, count + 1) : Math.floor(count / 2))
  }

  quote(request: PriceRequest): void {
    this.requests.set(request.id, request)
    const first = request.options[0]!
    // Up to level 3 every quote wins the first option at list price: decline by not quoting, and
    // only take cars whose list price leaves a margin over the driver fee we expect to pay.
    if (this.level <= 3) {
      const margin = first.listPriceCents - this.expectedFee(request)
      if (!this.overloaded() && margin >= this.tune.minMargin * first.listPriceCents) {
        this.taken++
        this.outbox.push({ type: "quote", requestId: request.id, prices: { [first.kind]: first.listPriceCents } })
      } else this.declined++
      return
    }
    const prices: Partial<Record<"same_day" | "next_day" | "within_3_days", number>> = {}
    const fee = this.expectedFee(request)
    const batchFull = request.batchId !== null && (this.bulk.get(request.batchId) ?? 0) >= this.tune.bulkCap
    const busy = !batchFull && this.overloaded()
    if (batchFull) this.why.bulk++
    else if (busy) this.why.cap++
    const risky = (!this.tune.tradeIns && request.legs.length > 1) || (!this.tune.privates && request.legs.some((l) => l.pickup.privateAddress || l.delivery.privateAddress))
    if (risky) this.why.risky++
    if (!batchFull && !busy && !risky) {
      for (const option of request.options) {
        // Time left to find a driver: from the decision (or the car's ready time) to the last pickup that still arrives.
        if (this.slack(request, option.deadline) < this.tune.minSlack * HOUR) continue
        // Same-day work is the hardest to staff in a shortage: only where drivers are plenty.
        if (option.kind === "same_day" && this.level >= 7 && this.supply(request.legs[0]!.pickup.placeId) < 1.2) continue
        // A small discount on the slow option steers dealers towards it: more time to find a driver.
        const slow = option.kind === "within_3_days" ? 0.97 : 1
        // A car that pairs with one of our open gigs is cheap to move: quote lower to win it, and
        // expect to pay the pair rate for it.
        const pairs = this.pairsWith(request, option)
        const trust = 1 + this.tune.trust * (this.dealerTrust.get(request.dealerId) ?? 0)
        const laneKey = this.laneOf(request, option.kind)
        const dealer = this.dealerPrice.get(request.dealerId) ?? 1
        const lane = (this.lane.get(laneKey) ?? 1) * this.laneFactor(request, option.kind) * this.placeDayFactor(request) * this.distanceDayFactor(request) * this.outageFactor(request) * dealer
        const war = this.priceWarDay === Math.floor(this.now / DAY) ? this.tune.priceWarDiscount : 1
        const price = Math.round((option.listPriceCents * this.markup * slow * trust * lane * war * (pairs ? this.tune.pairPrice : 1)) / 100) * 100
        const openingCost = pairs ? request.referenceFeeCents * this.tune.open * this.tune.pairOpen * 1.2 : fee
        // Pairing lowers the opening fee, but an unbooked pair is split at its deadline.
        // Reserve for the resulting individual gig as well.
        const cost = Math.max(openingCost, this.worstCaseStaffingCost(request, option.deadline)) * this.snowFactor(request, option.deadline)
        if (price - cost >= this.tune.minMargin * price) {
          prices[option.kind] = price
          this.quotedLanes.set(request.id, (this.quotedLanes.get(request.id) ?? new Map()).set(option.kind, laneKey))
          if (pairs) this.pairQuotes++
        }
      }
    }
    if (Object.keys(prices).length > 0) {
      this.taken++
      this.quoted.add(request.id)
      if (request.batchId) this.bulk.set(request.batchId, (this.bulk.get(request.batchId) ?? 0) + request.legs.length)
    } else {
      // Decline: a quote far above list loses at no cost; no quote at all costs goodwill.
      this.declined++
      if (!batchFull && !busy && !risky) this.why.margin++
      prices[first.kind] = first.listPriceCents * 5
    }
    this.outbox.push({ type: "quote", requestId: request.id, prices })
  }

  async win(order: Order): Promise<void> {
    if (!this.requests.has(order.id) || this.orders.has(order.id)) return // rejoin can know it already
    this.orders.set(order.id, order)
    if (await this.tryPair(order)) return
    await this.post(order, undelivered(order))
  }

  /** Return-trip pairing. A new single-car order joins an open single-car gig of another order when
   * one car's delivery is near the other's pickup and both can still be on time: one driver drives
   * both, without the trip home after the first car or the trip out to the second. */
  async tryPair(order: Order): Promise<boolean> {
    if (!this.tune.pair || this.level < 3 || !this.pairable(order)) return false
    let best: { gigId: string; stops: StopRef[]; other: Order; transfer: number } | null = null
    for (const other of this.orders.values()) {
      if (other.id === order.id || !this.pairable(other)) continue
      const gigs = this.gigsOf(other.id)
      if (gigs.length !== 1) continue
      const gigId = gigs[0]!
      if (this.booked.has(gigId) || this.pairs.has(gigId)) continue
      const plan = this.pairPlan(order, other)
      if (plan && (!best || plan.transfer < best.transfer)) best = { gigId, stops: plan.stops, other, transfer: plan.transfer }
    }
    if (!best) return false
    const { gigId, stops, other } = best
    const manualLicence = [order, other].some((o) => initialRequirements(this.requests.get(o.id)?.note ?? null).manualLicence)
    const audience = { experienced: [order, other].some((o) => o.legs[0]!.car.premium), manualLicence }
    this.legGigs.delete(other.id)
    this.outbox.push({ type: "withdraw", gigId })
    this.outbox.push({ type: "post", stops, audience, schedule: this.feesForStops(stops) })
    await this.send()
    const pairGig = this.gigsOf(order.id)[0]
    if (pairGig) {
      this.pairs.set(pairGig, this.now)
      this.paired++
      return true
    }
    // The world refused the pair gig: both orders go back to gigs of their own.
    await this.post(other, undelivered(other))
    return false
  }

  /** The fee table's factor for a car from `pickup` to `delivery`. */
  feeFactor(pickup: string, delivery: string): number {
    if (!FEES || this.tune.feeTable === 0) return 1
    return clamp(Math.exp(this.tune.feeTable * ((FEES.pickup[pickup] ?? 0) + (FEES.delivery[delivery] ?? 0))), 0.85, 1.3)
  }

  /** The lane table's price factor for an option: pickup place x delivery place x option. */
  laneFactor(request: PriceRequest, kind: string): number {
    if (!LANES || this.tune.laneTable === 0) return 1
    const leg = request.legs[0]!
    const v = (LANES.pickup[leg.pickup.placeId] ?? 0) + (LANES.delivery[leg.delivery.placeId] ?? 0) + this.tune.laneOption * (LANES.option[kind] ?? 0)
    return clamp(Math.exp(this.tune.laneTable * v), 0.75, 1.4)
  }

  placeDayFactor(request: PriceRequest): number {
    if (this.tune.placeDayStep <= 0) return 1
    const day = Math.floor(request.arrivedAt / DAY)
    const leg = request.legs[0]!
    const pickup = this.placeDay.get(`${day}:${leg.pickup.placeId}`) ?? 1
    const delivery = this.placeDay.get(`${day}:${leg.delivery.placeId}`) ?? 1
    return Math.sqrt(pickup * delivery)
  }

  outageFactor(request: PriceRequest): number {
    if (this.tune.outagePremium <= 0) return 1
    const day = Math.floor(request.arrivedAt / DAY)
    const leg = request.legs[0]!
    return this.outagePlaces.has(`${day}:${leg.pickup.placeId}`) || this.outagePlaces.has(`${day}:${leg.delivery.placeId}`) ? 1 + this.tune.outagePremium : 1
  }

  distanceBucket(request: PriceRequest): 0 | 1 | 2 {
    const minutes = Math.max(...request.legs.map((leg) => this.market.minutes.get(`${leg.pickup.placeId}>${leg.delivery.placeId}`) ?? 0))
    return minutes <= 120 ? 0 : minutes <= 240 ? 1 : 2
  }

  distanceDayFactor(request: PriceRequest): number {
    if (this.tune.distanceDayStep <= 0) return 1
    return this.distanceDay.get(`${Math.floor(request.arrivedAt / DAY)}:${this.distanceBucket(request)}`) ?? 1
  }

  /** The price category of an option: how many drivers live near the delivery (the competitor
   * charges more where few do), and the option's speed. */
  laneOf(request: PriceRequest, kind: string): string {
    const n = this.market.near.get(request.legs[0]!.delivery.placeId) ?? 0
    return `${n < 3 ? 0 : n < 10 ? 1 : n < 25 ? 2 : 3}:${kind}`
  }

  /** Would this request, won with this option, pair with one of our open single-car gigs? */
  pairsWith(request: PriceRequest, option: { kind: Order["option"]; deadline: number; listPriceCents: number }): boolean {
    if (!this.tune.pair || this.level < 3 || this.tune.pairPrice >= 1) return false
    const order: Order = { id: request.id, dealerId: request.dealerId, option: option.kind, priceCents: option.listPriceCents, deadline: option.deadline, legs: request.legs.map((leg) => ({ ...leg, pickup: { ...leg.pickup, window: { from: leg.pickup.window.from, to: option.deadline } }, delivery: { ...leg.delivery, window: { from: leg.delivery.window.from, to: option.deadline } } })), status: "waiting", deliveredAt: request.legs.map(() => null), lastPickupAt: option.deadline }
    if (!this.pairable(order)) return false
    for (const other of this.orders.values()) {
      if (!this.pairable(other)) continue
      const gigs = this.gigsOf(other.id)
      if (gigs.length !== 1 || this.booked.has(gigs[0]!) || this.pairs.has(gigs[0]!)) continue
      // The decision comes at respondBy: plan from then.
      const now = this.now
      this.now = Math.max(now, request.respondBy)
      const plan = this.pairPlan(order, other)
      this.now = now
      if (plan) return true
    }
    return false
  }

  /** A single car, not yet moving, not urgent, at dealer sites. */
  pairable(order: Order): boolean {
    const leg = order.legs[0]!
    return order.legs.length === 1 && order.deliveredAt[0] === null && !this.urgent.has(order.id) && !leg.pickup.privateAddress && !leg.delivery.privateAddress
  }

  /** The stops of a pair gig, first car then second, or null when no order of the two fits the
   * 12-hour rule, a short transfer and both deadlines with an hour or more to spare. */
  pairPlan(a: Order, b: Order): { stops: StopRef[]; transfer: number } | null {
    const minutes = (from: string, to: string) => this.market.minutes.get(`${from}>${to}`) ?? Infinity
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const lx = x.legs[0]!, ly = y.legs[0]!
      const transfer = minutes(lx.delivery.placeId, ly.pickup.placeId)
      const d1 = minutes(lx.pickup.placeId, lx.delivery.placeId)
      const d2 = minutes(ly.pickup.placeId, ly.delivery.placeId)
      if (transfer > this.tune.pairTransfer || d1 + transfer + d2 > 11 * HOUR) continue
      const sx = withoutWindows(stopsFor(x, [0], this.requests.get(x.id)!.note, initialRequirements(this.requests.get(x.id)!.note)), this.now)
      const sy = withoutWindows(stopsFor(y, [0], this.requests.get(y.id)!.note, initialRequirements(this.requests.get(y.id)!.note)), this.now)
      const pickX = sx[0]!.window ?? lx.pickup.window
      const pickY = sy[0]!.window ?? ly.pickup.window
      const t0 = Math.max(this.now + 90, pickX.from) // a driver needs time to find and reach the gig
      if (t0 > pickX.to) continue
      const atX = t0 + d1 + (sx[0]!.withCharging ? 40 : 0)
      if (atX > Math.min(x.deadline, sx[1]!.window?.to ?? x.deadline) - HOUR) continue
      const t1 = Math.max(atX + transfer, pickY.from)
      if (t1 > pickY.to || t1 - (atX + transfer) > HOUR) continue // the second car must be ready soon after
      const atY = t1 + d2 + (sy[0]!.withCharging ? 40 : 0)
      if (atY > Math.min(y.deadline, sy[1]!.window?.to ?? y.deadline) - 90) continue
      return { stops: [...sx, ...sy], transfer }
    }
    return null
  }

  /** Takes a pair gig apart: each order still in the books gets a gig of its own. `gone` when the
   * world has already taken the gig out of the app (expired, or withdrawn by a cancellation). */
  unpair(gigId: string, gone: boolean): void {
    const action = this.posts.get(gigId)
    this.pairs.delete(gigId)
    if (!action || this.booked.has(gigId)) return
    if (!gone) this.outbox.push({ type: "withdraw", gigId })
    for (const { orderId, leg } of action.stops) if (this.legGigs.get(orderId)?.get(leg) === gigId) this.legGigs.get(orderId)!.delete(leg)
    for (const orderId of new Set(action.stops.map((stop) => stop.orderId))) {
      const order = this.orders.get(orderId)
      if (order && order.deliveredAt[0] === null && this.gigsOf(orderId).length === 0) void this.post(order, [0])
    }
  }

  /** Splits pair gigs that no driver booked in `pairWait` hours, or whose order became urgent. */
  /** Where and about when the driver of a gig ends it: the last delivery's place, after the drives. */
  gigEnd(gigId: string): { placeId: string; at: number } | null {
    const action = this.posts.get(gigId)
    if (!action) return null
    const places = action.stops.map((stop) => {
      const leg = this.orders.get(stop.orderId)?.legs[stop.leg]
      return leg ? (stop.kind === "pickup" ? leg.pickup : leg.delivery).placeId : null
    })
    if (places.some((p) => p === null)) return null
    let drive = 0
    for (let i = 1; i < places.length; i++) drive += this.market.minutes.get(`${places[i - 1]}>${places[i]}`) ?? 0
    const first = action.stops[0]!
    const start = Math.max(this.now + 60, first.window?.from ?? this.orders.get(first.orderId)!.legs[first.leg]!.pickup.window.from)
    return { placeId: places.at(-1)!, at: start + drive }
  }

  /** Chain offers: a driver who ends one of our gigs near an open gig's pickup, before its window
   * closes, can do it cheaply (no trip out). Offer it to the two nearest, once, below the opening fee. */
  chainOffers_(): void {
    if (this.tune.chain <= 0 || this.level < 3) return
    const open = new Set<string>()
    for (const legs of this.legGigs.values()) for (const gigId of legs.values()) if (!this.booked.has(gigId) && !this.chained.has(gigId)) open.add(gigId)
    const day = Math.floor(this.now / DAY)
    const hour = (this.now % DAY) / HOUR
    if (hour < 7 || hour >= 22) return // nobody reads offers at night
    for (const gigId of open) {
      const action = this.posts.get(gigId)
      if (!action) continue
      const first = action.stops[0]!
      const leg = this.orders.get(first.orderId)?.legs[first.leg]
      if (!leg) continue
      const window = first.window ?? leg.pickup.window
      const candidates: [string, number][] = []
      for (const [driverId, end] of this.finishing) {
        if (end.at < this.now - 4 * HOUR || end.at > window.to - 60) continue
        const reach = this.market.minutes.get(`${end.placeId}>${leg.pickup.placeId}`) ?? Infinity
        if (reach > this.tune.chainReach) continue
        const driver = this.market.drivers.get(driverId)
        if (!driver || (action.audience.manualLicence && driver.licence !== "manual")) continue
        if (action.audience.experienced && (driver.rating < 4.8 || driver.completedGigs < 50)) continue
        if ((this.offers.get(`${driverId}@${day}`) ?? 0) >= 3) continue
        candidates.push([driverId, reach])
      }
      if (candidates.length === 0) continue
      this.chained.add(gigId)
      const fee = Math.max(1, Math.round(action.schedule[0]!.feeCents * this.tune.chain))
      for (const [driverId] of candidates.sort((a, b) => a[1] - b[1]).slice(0, 2)) {
        const key = `${driverId}@${day}`
        this.offers.set(key, (this.offers.get(key) ?? 0) + 1)
        this.outbox.push({ type: "offer", gigId, driverId, feeCents: fee })
        this.chainOffers++
      }
    }
  }

  tick(): void {
    this.chainOffers_()
    for (const [gigId, postedAt] of this.pairs) {
      if (this.booked.has(gigId)) continue
      const orderIds = new Set(this.posts.get(gigId)?.stops.map((stop) => stop.orderId))
      if (this.now - postedAt >= this.tune.pairWait * HOUR || [...orderIds].some((id) => this.urgent.has(id))) this.unpair(gigId, false)
    }
  }

  async change(order: Order): Promise<void> {
    if (!this.orders.has(order.id)) return
    this.orders.set(order.id, order)
    for (const gigId of this.gigsOf(order.id)) if (this.pairs.has(gigId) && !this.booked.has(gigId)) return this.unpair(gigId, false)
    if (await this.withdraw(order.id)) await this.post(order, undelivered(order))
  }

  /** Posts a gig again when one of its windows ended before a driver booked it. */
  repost(gigId: string): void {
    const action = this.posts.get(gigId)
    // A gig the starter has already taken off and posted again, after a change of plan, needs nothing.
    if (!action || !action.stops.some(({ orderId, leg }) => this.legGigs.get(orderId)?.get(leg) === gigId)) return
    if (this.pairs.has(gigId)) return this.unpair(gigId, true)
    for (const { orderId, leg } of action.stops) this.legGigs.get(orderId)?.delete(leg)
    const order = this.orders.get(action.stops[0]!.orderId)
    if (!order) return
    // One of its windows has ended, perhaps at a site's closing time before the window's own end: post without its own stop windows.
    this.outbox.push({ ...action, stops: withoutWindows(action.stops, Infinity), schedule: this.feesFor(order, pickups(action)) })
  }

  /** From the order's deadline warning on, its gigs that no driver holds go at the steep fees. */
  async raise(orderId: string): Promise<void> {
    const order = this.orders.get(orderId)
    if (!order) return
    this.urgent.add(orderId)
    for (const gigId of this.gigsOf(orderId)) if (this.pairs.has(gigId) && !this.booked.has(gigId)) this.unpair(gigId, false)
    if (this.outbox.some((action) => action.type === "post")) await this.send()
    await this.sendPostOf(orderId)
    for (const gigId of this.gigsOf(orderId)) {
      if (this.booked.has(gigId)) continue
      const schedule = this.feesFor(order, pickups(this.posts.get(gigId)!))
      this.outbox.push({ type: "reprice", gigId, schedule })
      this.offer(orderId, gigId, schedule.at(-1)!.feeCents)
    }
  }

  /** Direct offers, at the top steep fee, to up to three drivers who already looked at the order:
   * they use the app and are probably around. At most 3 offers a driver a day, 3 open per gig. */
  offer(orderId: string, gigId: string, feeCents: number): void {
    if (this.level < 3) return
    const last = this.offeredAt.get(gigId)
    if (last !== undefined && this.now - last < 11) return
    const audience = this.posts.get(gigId)!.audience
    const day = Math.floor(this.now / DAY)
    let sent = 0
    for (const driverId of this.viewers.get(orderId) ?? []) {
      if (sent >= 3) break
      const driver = this.market.drivers.get(driverId)
      if (!driver) continue
      if (audience.manualLicence && driver.licence !== "manual") continue
      if (audience.experienced && (driver.rating < 4.8 || driver.completedGigs < 50)) continue
      const key = `${driverId}@${day}`
      if ((this.offers.get(key) ?? 0) >= 3) continue
      this.offers.set(key, (this.offers.get(key) ?? 0) + 1)
      this.outbox.push({ type: "offer", gigId, driverId, feeCents })
      sent++
    }
    if (sent > 0) this.offeredAt.set(gigId, this.now)
  }

  /** The fees for some of the order's cars from now: rising, or steep once its deadline warning has come.
   * In a shortage the schedules open higher and rise faster. Normal schedules stop at 85% of the
   * price share; steep ones may go above the price, because a late car costs a refund, trust and rank. */
  feesFor(order: Order, cars: number): FeeStep[] {
    const share = cars / order.legs.length
    const leg0 = order.legs[0]!
    const fee = this.requests.get(order.id)!.referenceFeeCents * share * this.feeFactor(leg0.pickup.placeId, leg0.delivery.placeId)
    const price = order.priceCents * share
    if (this.level < 7) return this.urgent.has(order.id) ? steep(this.now, fee, this.level) : rising(this.now, fee, this.level)
    const urgent = this.urgent.has(order.id)
    const o = this.tune.open
    const steps = urgent ? [1.8, 2.1, 2.4, 2.7, 3.0].map((k) => Math.max(k, o + 0.6)) : [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((k) => o + k)
    const cap = urgent ? Math.max(price * 1.5, fee * 2.5) : Math.max(price * 0.85, fee)
    return steps.map((k, i) => ({ at: this.now + i * (urgent ? 30 : this.tune.stepMin), feeCents: Math.max(1, Math.round(Math.min(fee * k, cap))) }))
  }

  /** The schedule of a pair gig: the sum of both cars' typical fees, opened lower than two single
   * gigs (the driver saves a trip home and a trip out), rising as a single gig does. */
  feesForStops(stops: StopRef[]): FeeStep[] {
    let fee = 0
    let price = 0
    for (const stop of stops) {
      if (stop.kind !== "pickup") continue
      const order = this.orders.get(stop.orderId)!
      fee += this.requests.get(order.id)!.referenceFeeCents / order.legs.length
      price += order.priceCents / order.legs.length
    }
    const o = (this.level >= 7 ? this.tune.open : 1) * this.tune.pairOpen
    const steps = (this.level === 1 ? [0] : [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]).map((k) => o + k)
    return steps.map((k, i) => ({ at: this.now + i * this.tune.stepMin, feeCents: Math.max(1, Math.round(Math.min(fee * k, Math.max(price * 0.85, fee)))) }))
  }

  async retry(orderId: string, leg: number, reason: string): Promise<void> {
    const order = this.orders.get(orderId)
    if (!order) return
    this.legGigs.get(orderId)?.delete(leg) // the world has taken the car out of the failed gig
    const carNotThere = reason === "not_ready" || reason === "closed"
    const pickupFrom = carNotThere ? retryFrom(order, this.requests.get(orderId)!, leg, this.now) : 0
    await this.post(order, [leg], { pickupFrom, manualLicence: reason === "licence", plates: reason === "no_plates" })
  }

  /** A driver_late notice permits a free release. Replace the driver only when their new
   * pickup time makes one of the gig's deliveries miss its deadline; a late pickup alone
   * can still produce an on-time delivery and is worth keeping. */
  async replaceLateDriver(gigId: string, pickupAt: number): Promise<void> {
    const action = this.posts.get(gigId)
    if (!action || !this.booked.has(gigId)) return
    let at = pickupAt
    let previous: string | undefined
    let missesDeadline = false
    for (const stop of action.stops) {
      const leg = this.orders.get(stop.orderId)?.legs[stop.leg]
      if (!leg) return
      const place = stop.kind === "pickup" ? leg.pickup.placeId : leg.delivery.placeId
      if (previous) at += this.market.minutes.get(`${previous}>${place}`) ?? Infinity
      previous = place
      if (stop.kind === "delivery" && at > this.orders.get(stop.orderId)!.deadline) missesDeadline = true
    }
    if (!missesDeadline) return
    this.outbox.push({ type: "release", gigId })
    await this.send()
    this.booked.delete(gigId)
    this.posts.delete(gigId)
    for (const { orderId, leg } of action.stops) if (this.legGigs.get(orderId)?.get(leg) === gigId) this.legGigs.get(orderId)!.delete(leg)
    for (const orderId of new Set(action.stops.map((stop) => stop.orderId))) {
      const order = this.orders.get(orderId)
      if (order && order.deliveredAt.some((deliveredAt) => deliveredAt === null)) await this.post(order, undelivered(order))
    }
    this.lateDriverReleases++
  }

  async post(order: Order, legs: number[], retry = FIRST_TRY): Promise<void> {
    const requirements = initialRequirements(this.requests.get(order.id)!.note)
    const initial = {
      pickupFrom: retry.pickupFrom,
      manualLicence: retry.manualLicence || requirements.manualLicence,
      plates: retry.plates || requirements.plates,
    }
    // A premium car needs an experienced driver: the fine is €150 a car.
    const audience = { experienced: order.legs.some((leg) => leg.car.premium), manualLicence: initial.manualLicence }
    const stops = withoutWindows(stopsFor(order, legs, this.requests.get(order.id)!.note, initial), this.now)
    this.outbox.push({ type: "post", stops, audience, schedule: this.feesFor(order, legs.length) })
    if (legs.length === 1) return
    // A trade-in over the 12-hour limit for a gig with two cars goes as one gig per car.
    await this.send()
    if (this.gigsOf(order.id).length === 0) for (const leg of legs) await this.post(order, [leg], initial)
  }

  /** The gigs that carry the order's undelivered legs: one, or one for each leg of a split trade-in. */
  gigsOf(orderId: string): string[] {
    return [...new Set(this.legGigs.get(orderId)?.values())]
  }

  /** Remembers a gig that the world accepted: the post that made it, and the legs it carries. */
  carry(action: PostAction, gigId: string): void {
    for (const { orderId, leg } of action.stops) this.legGigs.set(orderId, (this.legGigs.get(orderId) ?? new Map()).set(leg, gigId))
    this.posts.set(gigId, action)
  }

  /** Takes an order's gigs out of the drivers' app. False, and nothing withdrawn, when a driver holds one of them. */
  async withdraw(orderId: string): Promise<boolean> {
    await this.sendPostOf(orderId)
    const gigs = this.gigsOf(orderId)
    if (gigs.some((gigId) => this.booked.has(gigId))) return false
    this.legGigs.delete(orderId)
    for (const gigId of gigs) this.outbox.push({ type: "withdraw", gigId })
    return true
  }

  /** A post of the order still in the outbox goes to the world now, so the starter knows its gig. Each gig carries one order. */
  async sendPostOf(orderId: string): Promise<void> {
    if (this.outbox.some((action) => action.type === "post" && action.stops[0]!.orderId === orderId)) await this.send()
  }

  /** Sends the outbox now. In practice, the outbox goes with the next advance instead. */
  async send(): Promise<void> {
    const actions = this.outbox.splice(0)
    if (actions.length > 0) this.readResults(actions, await this.world.act(actions))
  }

  readResults(actions: Action[], results: ActionResult[]): void {
    actions.forEach((action, i) => {
      if (action.type === "post" && results[i]?.ok) this.carry(action, results[i]!.id)
    })
  }
}

/** When to try a car again after a visit found it not ready or the site closed: two hours on, or,
 * when the dealer moved the deadline for a car that is late, when the car should be ready by the
 * same delay. */
function retryFrom(order: Order, request: PriceRequest, leg: number, now: number): number {
  const promised = request.options.find((option) => option.kind === order.option)?.deadline ?? order.deadline
  const delay = Math.max(0, order.deadline - promised)
  return Math.max(now + 2 * HOUR, order.legs[leg]!.pickup.window.from + delay)
}

const undelivered = (order: Order): number[] => order.legs.map((_, leg) => leg).filter((leg) => order.deliveredAt[leg] === null)

/** The cars a post carries. */
const pickups = (action: PostAction): number => action.stops.filter((stop) => stop.kind === "pickup").length

/** Leaves out the stop windows that end before `before`, so the world's window applies: once the order's
 * window has ended, it runs to the end of the world. */
const withoutWindows = (stops: StopRef[], before: number): StopRef[] =>
  stops.map((stop) => (stop.window && stop.window.to < before ? { ...stop, window: undefined } : stop))

/** The fee at once, then 10% of it more every hour: six steps, up to 1.5 times. Level 1 takes one fee only. */
const rising = (now: number, fee: number, level: number): FeeStep[] =>
  (level === 1 ? [0] : [0, 1, 2, 3, 4, 5]).map((k) => ({ at: now + k * HOUR, feeCents: Math.max(1, Math.round(fee * (1 + k / 10))) }))

/** 1.5 times the fee at once, then a quarter of it more every half hour, up to 2.5 times. Level 1 takes one fee only. */
const steep = (now: number, fee: number, level: number): FeeStep[] =>
  (level === 1 ? [0] : [0, 1, 2, 3, 4]).map((k) => ({ at: now + k * 30, feeCents: Math.max(1, Math.round(fee * (1.5 + k / 4))) }))

/** A pickup and a delivery for each leg. An electric car under 30% gets a charging stop.
 * A stop has its own window only when the note or the retry makes it narrower. Without
 * one, the world plans the pickup in the order's window and the delivery by the deadline. */
function stopsFor(order: Order, legs: number[], note: Note | null, retry: Retry): StopRef[] {
  return legs.flatMap((leg): StopRef[] => {
    const { car, pickup, delivery } = order.legs[leg]!
    const noted = windowFromNote(note, pickup.window, "pickup")
    const start = Math.max(noted.from, retry.pickupFrom)
    const pickupWindow = { from: start, to: Math.max(noted.to, start) }
    const deliveryBase = { from: delivery.window.from, to: Math.max(delivery.window.from, order.deadline) }
    const deliveryWindow = windowFromNote(note, deliveryBase, "delivery")
    const lowBattery = car.electric && car.chargePercent !== null && car.chargePercent < 30
    const first: StopRef = { orderId: order.id, leg, kind: "pickup", withPlates: retry.plates, withCharging: lowBattery }
    const second: StopRef = { orderId: order.id, leg, kind: "delivery" }
    return [narrower(first, pickupWindow, pickup.window), narrower(second, deliveryWindow, deliveryBase)]
  })
}

const narrower = (stop: StopRef, window: TimeWindow, base: TimeWindow): StopRef =>
  window.from > base.from || window.to < base.to ? { ...stop, window } : stop

/** "Not before", "at the earliest" and a ready time all mean from then on; read them before BEFORE. */
const AFTER = /jälkeen|alkaen|aikaisintaan|\bafter\b|\bfrom\b|earliest|not before|ei ennen|valmis|\bready\b|efter|tidigast|inte före|klar/
const BEFORE = /ennen|mennessä|viim|\bbefore\b|\bby\b|latest|före|senast/
const DELIVERY = /toimit|perillä|perille|vastaanot|kohde|deliver|arrive|destination|receiv|leverera|leverans|framme|mottag/
const CLOCK = /(?:klo|kl\.?)\s*(\d{1,2})(?:[.:](\d{2}))?|\b(\d{1,2})[.:](\d{2})\b/g
/** Opening hours as a range: "9-16", "klo 9.00-14.30", "kl 10-14". */
const RANGE = /\b(\d{1,2})(?:[.:](\d{2}))?\s*[-–]\s*(\d{1,2})(?:[.:](\d{2}))?\b/g

/** Narrows a stop's window by clock times in the note, found by keywords: "nouto ennen 15.30",
 * "klo 12 jälkeen", "deliver by 19:00", "efter kl. 12", "aikaisintaan klo 13.30", "not before
 * 16:00", and opening hours as a range, "arkisin 9-16". The time is on the window's own day. */
function windowFromNote(note: Note | null, window: TimeWindow, stop: "pickup" | "delivery"): TimeWindow {
  if (!note) return window
  let text = note.text.toLowerCase()
  if (DELIVERY.test(text) !== (stop === "delivery")) return window
  const minutes = (hour: number, minute: number): number | null => (hour > 24 || minute > 59 ? null : hour * HOUR + minute)
  const dayStart = (t: number) => Math.floor(t / DAY) * DAY
  let { from, to } = window
  // Opening hours hold every day: they move the window's start to the first day's opening and its end to the last day's closing.
  for (const match of text.matchAll(RANGE)) {
    const opens = minutes(Number(match[1]), Number(match[2] ?? 0))
    const closes = minutes(Number(match[3]), Number(match[4] ?? 0))
    if (opens === null || closes === null || opens >= closes) continue
    from = Math.max(from, dayStart(from) + opens)
    to = Math.min(to, dayStart(to) + closes)
  }
  text = text.replace(RANGE, " ")
  for (const match of text.matchAll(CLOCK)) {
    const m = minutes(Number(match[1] ?? match[3]), Number(match[2] ?? match[4] ?? 0))
    if (m === null) continue
    const time = dayStart(window.from) + m
    const around = text.slice(Math.max(0, match.index - 16), match.index + match[0].length + 16)
    if (AFTER.test(around)) from = Math.max(from, time)
    else if (BEFORE.test(around)) to = Math.min(to, time)
  }
  return from <= to ? { from, to } : window
}

/** Steps the world from one event that needs an answer to the next, and stops at each midnight for a report. */
async function playPractice(world: World, level: number, tune: Tune, quiet = false, resume = false): Promise<string> {
  const snapshot0 = await world.snapshot()
  const { now, endsAt } = snapshot0
  const market = await loadMarket(world.client, world)
  let desk = new Desk(world, level, now, market, tune)
  let seen = -1 // the last event seq handled: after a reconnect, the next advance can repeat events
  if (resume) {
    // A world that an earlier run left part-way: rebuild the books from it, then play on.
    const history = await world.events()
    await desk.rejoin(snapshot0, history)
    seen = history.at(-1)?.seq ?? -1
  }
  let failures = 0
  while (desk.now < endsAt) {
    const day = Math.floor(desk.now / DAY)
    const midnight = (day + 1) * DAY
    // One request a step: the advance applies the outbox, then moves the clock.
    const actions = desk.outbox.splice(0)
    try {
      const step = await world.advance({ untilEvent: WAKE_ON, max: Math.min(endsAt, midnight), actions })
      failures = 0
      desk.readResults(actions, step.results)
      desk.now = step.now
      for (const event of step.events) {
        if (event.seq <= seen) continue
        seen = event.seq
        await desk.handle(event)
      }
      desk.tick()
      if (!quiet && Math.floor(desk.now / DAY) > day) report(`${WEEKDAYS[day % 7]!}`, await world.score(), `markup ${desk.markup.toFixed(2)}  quoted ${desk.taken} declined ${desk.declined}`)
    } catch (error) {
      // The server did not answer: we cannot know which of the actions it applied. Wait, then
      // rebuild the books from the world (as the final does after a restart) and go on.
      if (!(error instanceof Unreachable) || ++failures > 20) throw error
      for (;;) {
        console.error(`spread: ${(error as Error).message}. Rebuilding from the server in 5 seconds (try ${failures}).`)
        await new Promise((done) => setTimeout(done, 5000))
        try {
          const history = await world.events()
          const snapshot = await world.snapshot()
          const rebuilt = new Desk(world, level, snapshot.now, market, tune)
          rebuilt.markup = desk.markup
          rebuilt.taken = desk.taken
          rebuilt.declined = desk.declined
          await rebuilt.rejoin(snapshot, history)
          desk = rebuilt
          seen = history.at(-1)?.seq ?? seen
          break
        } catch (again) {
          if (!(again instanceof Unreachable) || ++failures > 20) throw again
        }
      }
    }
  }
  return `${world.id} markup ${desk.markup.toFixed(2)} quoted ${desk.taken} declined ${desk.declined} ${JSON.stringify(desk.why)} pairs ${desk.paired}/${desk.pairsBooked} booked, pair quotes ${desk.pairQuotes}, price war ${desk.priceWarDay ?? "none"}, late-driver releases ${desk.lateDriverReleases}, chain ${desk.chainOffers}/${desk.chainAccepted}`
}

/** Rebuilds the books, then answers events as they come. After a second without an event,
 * it reads the clock. */
async function playFinal(world: World, tune: Tune): Promise<void> {
  const history = await world.events()
  const snapshot = await world.snapshot()
  if (snapshot.now >= snapshot.endsAt) return
  const level = (await world.client.worlds()).find((summary) => summary.worldId === world.id)?.level ?? 8
  const desk = new Desk(world, level, snapshot.now, await loadMarket(world.client, world), tune)
  await desk.rejoin(snapshot, history)
  await desk.send()
  for await (const event of world.stream({ after: history.at(-1)?.seq ?? -1, idleMs: 1000 })) {
    const day = Math.floor(desk.now / DAY)
    desk.now = event === null ? (await world.client.final()).now : Math.max(desk.now, event.at)
    if (event !== null) await desk.handle(event)
    desk.tick()
    await desk.send()
    if (Math.floor(desk.now / DAY) > day) report(WEEKDAYS[day % 7]!, await world.score())
    if (desk.now >= snapshot.endsAt) return
  }
}

function report(label: string, score: Score, extra = ""): void {
  const euros = (cents: number) => (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(11)
  const percent = (share: number, width: number) => `${(100 * share).toFixed(1)}%`.padStart(width)
  const orders = `${String(score.wonOrders).padStart(4)} orders  ${percent(score.onTimeShare, 6)} on time  ${percent(score.undeliveredShare, 5)} not delivered`
  console.log(`${label.padEnd(9)}  margin €${euros(score.marginCents)}  revenue €${euros(score.revenueCents)}  ${orders}  ${extra}`.trimEnd())
}

/** Your copy of the final that is set or runs now. Waits while none is set and while the last one has ended:
 * the organisers set a test final 15 minutes before its start, and the final 30 minutes before. */
async function nextFinal(client: Client): Promise<World> {
  for (let said = false; ; said = true) {
    const set = await client.final().catch((error: unknown) => {
      if (error instanceof SpreadError && error.status === 404) return null
      throw error
    })
    const world = set ? client.world(set.worldId) : null
    if (world) {
      const snapshot = await world.snapshot()
      if (snapshot.now < snapshot.endsAt) return world
    }
    if (!said) console.log("No final is set. Waiting for it: the organisers set a test final 15 minutes before its start, and the final 30 minutes before.")
    await new Promise((done) => setTimeout(done, 10_000))
  }
}

const USAGE =
  "Usage: bun dispatch.ts [--level 1-8] [--seed <text> | --seeds a,b,c | --world <id>] [--board] [--final] [--markup x] [--fee-mult x] [--min-margin x] [--cap n] [--bulk-cap n]. Set SPREAD_URL and SPREAD_KEY first."

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8] as const
type Level = (typeof LEVELS)[number]

/** Plays several practice worlds at once (at most 8: the practice slots) and prints one line each plus the total. */
async function sweep(client: Client, level: Level, seeds: string[], tune: Tune): Promise<void> {
  if (seeds.length > 8) throw new SpreadError(0, "--seeds takes at most 8 seeds: a team holds 8 practice worlds")
  const worlds: World[] = []
  process.once("SIGINT", () => void Promise.all(worlds.map((w) => w.delete().catch(() => {}))).then(() => exit("Stopped. Worlds deleted.")))
  const scores = await Promise.all(
    seeds.map(async (seed) => {
      // All 8 practice slots can be busy (other systems on the same key): wait for one, up to 20 minutes.
      let world: World | undefined
      for (let tries = 0; !world; tries++) {
        try {
          world = await client.create(level, { seed })
        } catch (error) {
          if (!(error instanceof SpreadError) || error.status !== 409 || tries > 240) throw error
          await new Promise((done) => setTimeout(done, 5000))
        }
      }
      let stats = ""
      worlds.push(world)
      try {
        stats = await playPractice(world, level, tune, true)
      } catch (error) {
        await world.delete().catch(() => {})
        throw error
      }
      const score = await world.score()
      report(seed, score, `${score.ranked ? "ranked" : "NOT ranked"}  ${stats}`)
      return score
    }),
  )
  const total = scores.reduce((sum, s) => sum + s.marginCents, 0)
  const ranked = scores.filter((s) => s.ranked).length
  console.log(`Total margin €${(total / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}  ranked ${ranked}/${scores.length}  tune ${JSON.stringify(tune)}`)
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      level: { type: "string", default: "8" },
      seed: { type: "string" },
      seeds: { type: "string" },
      world: { type: "string" },
      board: { type: "boolean" },
      final: { type: "boolean" },
      markup: { type: "string" },
      "fee-mult": { type: "string" },
      "staffing-reserve": { type: "string" },
      "price-war-discount": { type: "string" },
      "place-day-step": { type: "string" },
      "snow-reserve": { type: "string" },
      "outage-premium": { type: "string" },
      "distance-day-step": { type: "string" },
      "dealer-step": { type: "string" },
      "min-margin": { type: "string" },
      cap: { type: "string" },
      "bulk-cap": { type: "string" },
      "markup-range": { type: "string" },
      open: { type: "string" },
      "min-slack": { type: "string" },
      "win-target": { type: "string" },
      pair: { type: "string" },
      "pair-transfer": { type: "string" },
      "pair-open": { type: "string" },
      "pair-wait": { type: "string" },
      "pair-price": { type: "string" },
      trust: { type: "string" },
      "step-min": { type: "string" },
      chain: { type: "string" },
      "lane-step": { type: "string" },
      "lane-table": { type: "string" },
      "fee-table": { type: "string" },
      "lane-option": { type: "string" },
      "chain-reach": { type: "string" },
      "trade-ins": { type: "string" },
      privates: { type: "string" },
    },
  })
  const level = Number(args.level) as Level
  if (!LEVELS.includes(level)) throw new SpreadError(0, `--level must be 1 to 8. ${USAGE}`)
  const num = (value: string | undefined, fallback: number) => (value === undefined ? fallback : Number(value))
  const base = defaultTune(level)
  const tune: Tune = {
    ...base,
    markup: num(args.markup, base.markup),
    feeMult: num(args["fee-mult"], base.feeMult),
    staffingReserve: num(args["staffing-reserve"], base.staffingReserve),
    priceWarDiscount: num(args["price-war-discount"], base.priceWarDiscount),
    placeDayStep: num(args["place-day-step"], base.placeDayStep),
    snowReserve: num(args["snow-reserve"], base.snowReserve),
    outagePremium: num(args["outage-premium"], base.outagePremium),
    distanceDayStep: num(args["distance-day-step"], base.distanceDayStep),
    dealerStep: num(args["dealer-step"], base.dealerStep),
    minMargin: num(args["min-margin"], base.minMargin),
    cap: num(args.cap, base.cap),
    bulkCap: num(args["bulk-cap"], base.bulkCap),
    markupRange: num(args["markup-range"], base.markupRange),
    open: num(args.open, base.open),
    minSlack: num(args["min-slack"], base.minSlack),
    winTarget: num(args["win-target"], base.winTarget),
    pair: args.pair === undefined ? base.pair : args.pair === "yes",
    pairTransfer: num(args["pair-transfer"], base.pairTransfer),
    pairOpen: num(args["pair-open"], base.pairOpen),
    pairWait: num(args["pair-wait"], base.pairWait),
    pairPrice: num(args["pair-price"], base.pairPrice),
    trust: num(args.trust, base.trust),
    stepMin: num(args["step-min"], base.stepMin),
    chain: num(args.chain, base.chain),
    laneStep: num(args["lane-step"], base.laneStep),
    laneTable: num(args["lane-table"], base.laneTable),
    feeTable: num(args["fee-table"], base.feeTable),
    laneOption: num(args["lane-option"], base.laneOption),
    chainReach: num(args["chain-reach"], base.chainReach),
    tradeIns: args["trade-ins"] === undefined ? base.tradeIns : args["trade-ins"] === "yes",
    privates: args.privates === undefined ? base.privates : args.privates === "yes",
  }
  if (Object.values(tune).some((x) => typeof x === "number" && !Number.isFinite(x))) throw new SpreadError(0, `A tuning flag is not a number. ${USAGE}`)
  const client = new Client()
  if (args.world) {
    // Resume a practice world or ranking run that a crash left paused part-way.
    const run = client.world(args.world)
    const summary = (await client.worlds()).find((w) => w.worldId === run.id)
    if (!summary) throw new SpreadError(0, `No world ${run.id} in this team's list`)
    if (summary.ended) throw new SpreadError(0, `World ${run.id} has already ended`)
    console.log(`Resuming world ${run.id}, level ${summary.level}.`)
    await playPractice(run, summary.level, { ...tune, ...(args.level === "8" && summary.level !== 8 ? defaultTune(summary.level) : {}) }, false, true)
    const end = await run.score()
    report("End", end)
    return
  }
  if (args.seeds) return sweep(client, level, args.seeds.split(",").map((s) => s.trim()).filter(Boolean), tune)
  let world: World | undefined
  let score: Score | undefined
  if (args.final) {
    process.once("SIGINT", () => exit("Stopped. The final world keeps running without your system; start it again with --final."))
    // A server restart drops every connection. The desk then rebuilds its books from the server, as after its own restart.
    while (true) {
      try {
        if (!world) {
          world = await nextFinal(client)
          console.log(`Final world ${world.id}.`)
        }
        await playFinal(world, tune)
        score = await world.score()
        break
      } catch (error) {
        if (!(error instanceof Unreachable)) throw error
        console.error(`spread: ${error.message}. Trying again in 5 seconds.`)
        await new Promise((done) => setTimeout(done, 5000))
      }
    }
  } else {
    const run = await client.create(level, { seed: args.seed, board: args.board })
    world = run
    // A ranking run that a team deletes plays to its end without the team's system, and counts.
    const name = `${args.board ? "Ranking run" : "Practice world"} ${run.id}`
    const afterStop = (deleted: boolean) =>
      args.board ? `${name} plays to its end without your system, and counts.` : deleted ? `${name} is deleted.` : `${name} is not deleted: it holds one of your eight practice slots.`
    console.log(`${name}, level ${level}. ${args.board ? "Ctrl-C or an error stops your system: the run then plays to its end without it, and counts." : "Ctrl-C or an error stops the run and deletes the world."}`)
    const remove = () => run.delete().then(() => true, () => false)
    process.once("SIGINT", () => void remove().then((deleted) => exit(`Stopped. ${afterStop(deleted)}`)))
    // A world left behind holds one of the team's eight practice slots.
    await playPractice(run, level, tune).catch(async (error: unknown) => {
      console.error(`Stopped by the error below. ${afterStop(await remove())}`)
      throw error
    })
  }
  score ??= await world.score()
  report("End", score)
  console.log(score.ranked ? "Ranked." : score.wonOrders === 0 ? "Not ranked: no order won." : "Not ranked: the delivery minimum is 90% of the orders on time.")
}

function exit(message: string): never {
  console.error(message)
  process.exit(1)
}

await main().catch((error: unknown) => {
  if (error instanceof SpreadError) exit(`spread: ${error.message}`)
  if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) exit(`${error.message}. ${USAGE}`)
  throw error
})
