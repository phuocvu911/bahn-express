# bahn-express: Spread dispatcher, v1 (lite)

- `docs/`: the challenge docs (HANDBOOK, RULES, API, openapi.json), copied from the server.
- `typescript/`: the official kit (`spread.ts`, `types.ts`, `starter.ts`, `reveal-csv.ts`) and **`dispatch.ts`**, our system.

## Setup (once)

1. Get a team key at https://spread.bahnexpress.com/join
2. In your shell:
   ```sh
   export SPREAD_URL=https://spread.bahnexpress.com
   export SPREAD_KEY=<your team key>
   cd typescript
   ```

## Run

```sh
bun dispatch.ts --level 2 --seed spread-1      # make sure it works at an easy level
bun dispatch.ts --level 8 --seed spread-1      # the final's level; prints margin per day
bun starter.ts  --level 8 --seed spread-1      # the kit's baseline, for comparison (−€72,612 on this seed)

# Compare settings on the same seeds (max 8 at once = the practice slots):
bun dispatch.ts --level 8 --seeds s1,s2,s3,s4,s5,s6
bun dispatch.ts --level 8 --seeds s1,s2,s3,s4,s5,s6 --markup 1.45 --cap 10

bun dispatch.ts --level 8 --board              # a ranking run (counts on the leaderboard, can't be undone)
bun dispatch.ts --final                        # the test finals (Sat 14 Nov 14:00/20:00) and the final (Sun 15 Nov 08:00 Helsinki)

bun dispatch.ts --level 1 --world <worldId>    # resume a world a crash left paused part-way (ranking runs too)

bun reveal-csv.ts <worldId>                    # after a practice week: CSVs of quotes, cars, views, gigs
```

Node 22.18+ works too: `node dispatch.ts ...`. The run viewer is at `$SPREAD_URL/viewer/`.

## Tuning flags (defaults at levels 7–8, tuned on practice seeds 2026-11-14)

| Flag | Default | Meaning |
|---|---|---|
| `--markup` | 1.35 (L8), 1.22 (L7) | Starting quote = list price × markup. Adapts during the week towards `--win-target`. |
| `--markup-range` | 0.8 | How far above its start the markup may adapt. |
| `--win-target` | 0.33 | Share of real quotes the markup aims to win (0.25–0.45 all scored about the same). |
| `--fee-mult` | 1.25 | Expected driver fee = typical fee × this × supply factor (few drivers near pickup → dearer). |
| `--min-margin` | 0.15 | Decline when (price − expected fee) / price is below this. |
| `--open` | 0.85 | Opening driver fee = typical fee × this; it rises +0.1 every 30 min (+0.6 max). Steep after a deadline warning. |
| `--min-slack` | 7 | Hours from the dealer's decision to the last pickup an option must leave; tighter options aren't quoted. |
| `--trade-ins`, `--privates` | no | Quote trade-ins / private addresses (48% / 20% were late in practice). Pass `yes` to allow. |
| `--pair` | yes (L3+) | Return-trip pairing: a new single-car order joins an open single-car gig when one car's delivery is ≤ `--pair-transfer` road minutes (30) from the other's pickup and both deadlines still fit. |
| `--pair-open` | 0.8 | A pair gig opens at (sum of both typical fees) × `--open` × this. |
| `--pair-wait` | 2 | Hours an unbooked pair gig waits before it is split back into two gigs (also split on a deadline warning, change or cancellation). |
| `--pair-price` | 0.92 | Quote multiplier for a request that would pair with one of our open gigs (win more cheap-to-move cars). |
| `--cap` | 22 | Decline while this many orders due for pickup in 12 h have no driver. |
| `--bulk-cap` | 10 | Most cars quoted from one bulk batch. |

Analysis helpers (in `analysis/`): `bun ../analysis/reveal.ts <worldId>` (win rates by price, fees paid), `bun ../analysis/late.ts <ids…>` (which orders were late), `../analysis/ab.sh <level> <seeds> "<flags A>" "<flags B>"` (A/B test).

What to watch: **on-time share must stay ≥ 90%** or the week isn't ranked. If it falls below that, lower `--cap` or raise `--min-margin`. If you're well above 95% with low margin, raise `--cap` or `--markup`.
