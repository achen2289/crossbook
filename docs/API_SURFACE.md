# Polymarket US — API Surface Investigation

**Date of investigation:** 2026-08-15
**Sources:** live probing of all three hosts (public endpoints unauthenticated; account endpoints with a personal retail key, read-only) + official docs at `docs.polymarket.us` + the published OpenAPI specs (downloaded and enumerated in full).
**Audience:** an engineer deciding what to build on this API.

Facts below are marked **verified** (observed live during probing) or **inferred/documented** (from docs/schemas, not independently exercised). Everything not explicitly qualified comes from the official OpenAPI specs.

---

## 1. Executive summary

Polymarket US exposes its exchange through **three HTTP hosts** plus streaming protocols:

| Host | Audience | Auth | What it serves |
|---|---|---|---|
| `gateway.polymarket.us` | Everyone | **None required** (verified: bare requests return 200; signed requests also accepted) | Market discovery & market data: events, markets, order books, BBO, search, series, tags, sports, incentive programs, partner ID mapping |
| `api.polymarket.us` | Retail account holders | Ed25519 request signing (API key) | Trading & account: orders (create/cancel/modify/preview/close), portfolio positions & activities, balances, combos, RFQs |
| `api.prod.polymarketexchange.com` | Institutional participants | Ed25519 request signing — **separate institutional onboarding; retail keys get 401 Unauthorized (verified live)** | Full exchange API: order book by symbol, reference data, trading, positions/ledgers, funding, reports (incl. bar/candlestick trade stats), accounts, RFQs, combos, health |

Key takeaways for a builder:

- **All market data is free and unauthenticated.** A read-only analytics app needs zero credentials for prices, books, and metadata.
- **The retail REST API has no historical price/candle endpoint.** If you need time series, you must sample it yourself or consume the WebSocket streams. (Candlestick-style data exists only behind the institutional wall, via `POST /v1/report/trades/stats` with `bars`.)
- Scale observed live on 2026-08-15: **~2,750 active events / ~20,000 markets**, heavily sports-dominated (359 of the first 500 active events were sports).
- Streaming: **WebSocket** (public markets channel + private channel, same Ed25519 auth), **gRPC** streaming and **FIX** for institutional. Official SDKs: Python (3.10+) and TypeScript (Node 18+).

---

## 2. Authentication

Verified live against `api.polymarket.us`. Three headers per request:

| Header | Value |
|---|---|
| `X-PM-Access-Key` | API key ID (a UUID) |
| `X-PM-Timestamp` | Unix time in **milliseconds**; must be within **30 seconds** of server time (verified: stale timestamps are rejected) |
| `X-PM-Signature` | `base64( Ed25519_sign( timestamp + METHOD + path ) )` |

### The message string

Concatenate, with no separators: the millisecond timestamp, the uppercase HTTP method, and the request path.

```
message = "1755298800000" + "GET" + "/v1/portfolio/positions"
        = "1755298800000GET/v1/portfolio/positions"
signature = base64(ed25519_sign(secret_seed, utf8(message)))
```

### Critical verified quirk: sign the path WITHOUT the query string

The signed path must **exclude** the query string, even though the request URL includes it:

- Signing `"/v1/portfolio/positions?limit=5"` → **401 "Invalid API key signature"** (verified)
- Signing `"/v1/portfolio/positions"` while requesting `...?limit=5` → **200** (verified)

Any generic HMAC-style middleware that signs the full request target will fail here. Strip everything from `?` onward before signing.

### Secret key format: 64 bytes, libsodium layout

The secret key base64-decodes to **64 bytes** in libsodium format: `32-byte seed || 32-byte public key` (verified by decoding). Most Ed25519 libraries want either the 32-byte seed or the full 64-byte expanded key:

- If your library takes a seed (e.g. Node `crypto`, PyNaCl `SigningKey`): use **the first 32 bytes**.
- If it takes the 64-byte libsodium secret key (e.g. `libsodium`/`tweetnacl` `sign.detached`): pass all 64 bytes.

Sharp edge: the official docs' Python example assumes a seed-only secret; a naive port that feeds all 64 bytes to a seed-taking API will produce garbage signatures. See §7.

### Where auth applies

- `gateway.polymarket.us`: no auth needed; **signed requests are also accepted** (verified). Exception: `GET /v1/incentives/earnings` returns *your* earnings and is user-scoped, so it requires auth (inferred from semantics; the program listing `GET /v1/incentives` is public).
- `api.polymarket.us`: every endpoint requires the signature headers.
- `api.prod.polymarketexchange.com`: same signing scheme, but keys come from **institutional onboarding**. **Verified:** a valid retail key gets `401 Unauthorized` on this host.

---

## 3. Endpoint catalog

Enumerated from the published OpenAPI specs (proto-generated for the gateway; hand-written for the trading APIs), cross-checked against live probes. "Auth" column: `—` = none, `E` = Ed25519 signature required.

### 3.1 `gateway.polymarket.us` — public market data

#### Events

| Method | Path | Params | Auth | Notes |
|---|---|---|---|---|
| GET | `/v1/events` | `limit` (≤500 verified), `offset`, `orderBy[]`, `orderDirection`, `id[]`, `slug[]`, `archived`, `active`, `closed`, `liquidityMin/Max`, `volumeMin/Max`, `startDateMin/Max`, `endDateMin/Max`, `startTimeMin/Max`, `finishedTimestampMin/Max`, `tagSlug`, `tagIds[]`, `excludeTagId[]`, `relatedTags`, `seriesId[]`, `excludeSeriesId[]`, `excludeEventId[]`, `categories[]`, `marketTypes[]`, `sportsMarketTypes[]`, `live`, `ended`, `eventDate`, `recurrence`, `gameId`, `rescheduledFromGameId`, `sportradarGameId`, `period`, `resolution`, `featured`, `featuredOrder`, `includeTemplate`, `includeHidden`, `userId` | — | Primary discovery endpoint. Offset pagination. Rich filter set (45 query params). |
| GET | `/v1/events/slug/{slug}` | `groups` (bool) | — | Single event; `groups=true` includes marketGroups. |
| GET | `/v1/events/{id}` | `groups` (bool) | — | Single event by numeric ID. |
| GET | `/v1/partners/{partnerKey}/events/{externalId}` | path only | — | Partner integration: maps an external event ID to a Polymarket event + `mappedMarketSides[]` (external market type / selection / line ↔ marketId/marketSideId). |

#### Markets & market data

| Method | Path | Params | Auth | Notes |
|---|---|---|---|---|
| GET | `/v1/markets` | `limit`, `offset`, `orderBy[]`, `orderDirection`, `id[]`, `slug[]`, `archived`, `active`, `closed`, `volumeNumMin/Max`, `startDateMin/Max`, `endDateMin/Max`, `relatedTags`, `gameId`, `sportsMarketTypes[]`, `includeTag`, `categories[]`, `marketTypes[]`, `includeHidden`, `tagIds[]` | — | Market listing with offset pagination. |
| GET | `/v1/market/id/{id}` | — | — | Note the singular `/v1/market/` prefix for by-id/by-slug. |
| GET | `/v1/market/slug/{slug}` | — | — | |
| GET | `/v1/markets/{slug}/bbo` | — | — | Returns `marketData` (lite): `currentPx`, `lastTradePx`, `settlementPx`, `sharesTraded`, `openInterest`, `bestAsk`, `bestBid`, `askDepth`, `bidDepth` (depth = level counts), `lastPriceSample` (verified live). |
| GET | `/v1/markets/{slug}/book` | — | — | Returns `marketData`: `bids[]`/`asks[]` (spec name: `offers[]`) of `{px: {value, currency}, qty}`, best-first (verified live), plus `state`, `stats`, `transactTime`. |
| GET | `/v1/markets/{slug}/settlement` | `fromEp3` (bool) | — | `{slug, settlement}` — settlement price for resolved markets. |

#### Search, series, tags

| Method | Path | Params | Auth | Notes |
|---|---|---|---|---|
| GET | `/v1/search` | `query`, `limit`, `page`, `seriesIds[]`, `marketType[]`, `startTimeMin/Max`, `closedTimeMin/Max`, `status`, `comboEnabledOnly` | — | Returns `{events[]}` only — no separate market/tag hit types. Page-based (not offset). |
| GET | `/v1/series` | `limit`, `offset`, `orderBy[]`, `orderDirection`, `slug[]`, `active`, `recurrence` (plus duplicated proto-leaked `params.*` variants, see §7) | — | Series = recurring templates (e.g. FOMC meetings). `{id, slug, title, subtitle, recurrence, active, image}`. |
| GET | `/v1/series/id/{id}` | — | — | |
| GET | `/v2/tags` | `limit`, `offset`, `orderBy[]`, `orderDirection`, `slug[]`, `ids[]`, `parentId`, `parentSlug`, `query` | — | Tag: `{id, slug, label, parentId, subtags, tradable, league, sport, image}` — hierarchical. |
| GET | `/v2/tags/slug/{slug}` | — | — | |
| GET | `/v2/tags/{id}` | — | — | |
| GET | `/v2/tags/{slug}/events` | `limit`, `offset`, `orderBy[]`, `orderDirection`, `active`, `closed` | — | Events under a tag — handy alternative to `/v1/events?tagSlug=`. |

#### Sports (v2 current, v1 legacy)

| Method | Path | Params | Auth | Notes |
|---|---|---|---|---|
| GET | `/v2/sports` | — | — | All sports: `{id, slug, name, tagId, image, defaultJerseyImage, leagues[]}`. |
| GET | `/v2/sports/{slug}` | — | — | |
| GET | `/v2/sports/{slug}/events` | `limit`, `offset`, `excludeEventId[]`, `type`, `section` | — | Sectioned event feeds (e.g. live/upcoming). |
| GET | `/v2/leagues` | `limit`, `offset` | — | League: `{id, slug, name, abbreviation, sportId, tagId, activeSeriesId, isOperational, ordering, resolution}`. |
| GET | `/v2/leagues/{slug}` | — | — | |
| GET | `/v2/leagues/{slug}/events` | `limit`, `offset`, `excludeEventId[]`, `type`, `section` | — | |
| GET | `/v1/sports` | — | — | Legacy listing; prefer v2. |
| GET | `/v1/sports/teams` | `limit`, `offset`, `orderBy[]`, `orderDirection`, `filters.league[]`, `filters.name[]`, `filters.abbreviation[]`, `filters.id[]` | — | Team metadata. |
| GET | `/v1/sports/teams/provider` | `teamIds[]`, `provider`, `league` | — | Map team IDs to an external data provider's IDs. |
| GET | `/v1/sports/{seriesId}/events` | `limit`, `offset`, `excludeEventId[]`, `type`, `section` | — | Legacy per-series feed. |

#### Incentives

| Method | Path | Params | Auth | Notes |
|---|---|---|---|---|
| GET | `/v1/incentives` | `page_size`, `page_token`, `symbols[]`, `order_by`, `order_direction`, `statuses[]`, `program_type`, `query`, `instrument_states[]`, `category`, `subcategory` | — | Liquidity/maker incentive programs per market: `{marketSlug, category, timePeriods[{rewardPool, targetSize, minTakerNotional, discountFactor, start, end, status}]}`. Token-based pagination (differs from the rest of the gateway). |
| GET | `/v1/incentives/earnings` | `start_date`, `end_date`, `market_slug`, `program_type` | E (inferred — user-scoped "your earnings") | Your rewards: `{rewards[{date, marketSlug, programType, reward, status}]}`. |

### 3.2 `api.polymarket.us` — retail authenticated

All endpoints require Ed25519 signing (§2). **Read endpoints verified live; order-placement endpoints enumerated from the spec only — deliberately not exercised.**

#### Orders

| Method | Path | Params / body | Auth | Notes |
|---|---|---|---|---|
| POST | `/v1/orders` | body: `CreateOrderRequest` — `marketSlug` (req), `type` (`ORDER_TYPE_LIMIT`\|`MARKET`), `price` `{value, currency}` (req for limit), `quantity` (double, fractional OK), `cashOrderQty` (market orders by dollar amount), `tif` (`DAY`, `GOOD_TILL_CANCEL`, `GOOD_TILL_DATE`+`goodTillTime`, `IMMEDIATE_OR_CANCEL`, `FILL_OR_KILL`), `intent` (`BUY_LONG`/`SELL_LONG`/`BUY_SHORT`/`SELL_SHORT`) **or** `outcomeSide` (`YES`/`NO`) + `action` (`BUY`/`SELL`), `participateDontInitiate` (post-only), `synchronousExecution` + `maxBlockTime`, `slippageTolerance` `{currentPrice, bips, ticks}`, `manualOrderIndicator` | E | Two equivalent ways to express direction; `outcomeSide`+`action` wins if both set. |
| GET | `/v1/orders/open` | `slugs[]` | E | Open orders, optionally per market. |
| POST | `/v1/orders/open/cancel` | body: `CancelOpenOrdersRequest` | E | Cancel-all. |
| POST | `/v1/orders/batched` | body: list of create requests | E | Batch create. |
| POST | `/v1/orders/batched/cancel` | body: list | E | Batch cancel. |
| POST | `/v1/orders/batched/modify` | body: list | E | Batch modify. |
| GET | `/v1/order/{orderId}` | — | E | Full order state: `{id, marketSlug, side, intent, outcomeSide, action, type, tif, price, quantity, cumQuantity, leavesQuantity, avgPx, state, commissionsBasisPoints, makerCommissionsBasisPoints, commissionNotionalTotalCollected, createTime, insertTime, marketMetadata}`. |
| POST | `/v1/order/{orderId}/cancel` | — | E | |
| POST | `/v1/order/{orderId}/modify` | body: `ModifyOrderRequest` | E | |
| POST | `/v1/order/preview` | body: wraps a `CreateOrderRequest` | E | Dry-run: returns the would-be `order` incl. fees — the safe way to inspect fee math without trading. |
| POST | `/v1/order/close-position` | body: `{marketSlug, slippageTolerance, synchronousExecution, maxBlockTime, manualOrderIndicator}` | E | Flatten a position in one call. |

#### Portfolio & account

| Method | Path | Params | Auth | Notes |
|---|---|---|---|---|
| GET | `/v1/portfolio/positions` | `market`, `limit`, `cursor` | E | **Cursor** pagination (`nextCursor`, `eof`). Position: `{netPosition(+Decimal), bodPosition(+Decimal), qtyAvailable/Bought/Sold(+Decimal)`, `cost`, `cashValue`, `realized`, `expired`, `marketMetadata`, `updateTime}`. Signed position: negative = short (verified). |
| GET | `/v1/portfolio/activities` | `limit`, `cursor`, `marketSlug`, `types[]`, `sortOrder` | E | Unified ledger. `ActivityType`: `TRADE`, `POSITION_RESOLUTION`, `ACCOUNT_DEPOSIT`, `ACCOUNT_ADVANCED_DEPOSIT`, `ACCOUNT_WITHDRAWAL`, `REFERRAL_BONUS`, `TRANSFER`, `TAKER_FEE_REBATE`, `LIQUIDITY_PROGRAM`. Trade rows: `{price, qty(+Decimal), isAggressor, costBasis, realizedPnl, state}`. |
| GET | `/v1/account/balances` | — | E | `UserBalance`: `{currency, currentBalance, buyingPower, assetAvailable, assetNotional, marginRequirement, balanceReservation, openOrders, pendingCredit, pendingWithdrawals, unsettledFunds, lastUpdated}`. |

#### Combos & RFQs (retail)

Verified as part of the retail surface per docs; note the OpenAPI `servers` field for these two specs points at the institutional host — see §7.

| Method | Path | Params / body | Auth | Notes |
|---|---|---|---|---|
| GET | `/v1/combos` | `symbol` (req) | E | Combo instruments: `{id, legs[{symbol, side}], state, tickSize, createdTime}` — multi-leg synthetic instruments. |
| POST | `/v1/combos` | body: `{legs[]}` | E | Create a combo instrument. |
| GET | `/v1/rfqs` | `limit`, `cursor`, `rfqId`, `symbol`, `status`, `userFilter` | E | List RFQs (request-for-quote for size). |
| POST | `/v1/rfqs` | body: `{symbol, qtyDecimal` or `cashOrderQty, account, restRemainder}` | E | Create an RFQ. |
| GET | `/v1/rfqs/quotes` | `limit`, `cursor`, `quoteId`, `rfqId`, `status`, `userFilter`, `rfqUserFilter` | E | |
| POST | `/v1/rfqs/quotes` | body: `{rfqId, buyPrice, sellPrice, account, postOnly, restRemainder}` | E | Respond to an RFQ (two-sided quoting supported). |
| GET | `/v1/rfqs/user-id` | — | E | Your anonymized RFQ participant ID. |
| DELETE | `/v1/rfqs/{rfqId}` | — | E | Withdraw RFQ. |
| DELETE | `/v1/rfqs/{rfqId}/quotes/{quoteId}` | — | E | Withdraw quote. |
| PUT | `/v1/rfqs/{rfqId}/quotes/{quoteId}/accept` | body | E | Requester accepts a quote. |
| PUT | `/v1/rfqs/{rfqId}/quotes/{quoteId}/confirm` | body | E | Quoter confirms → trade. |

### 3.3 `api.prod.polymarketexchange.com` — institutional

**Requires institutional onboarding; retail keys get 401 — verified live.** Enumerated from specs; none of these were exercised beyond the 401 check. Symbols here are exchange symbols (see refdata), not gateway slugs.

| Method | Path | Params / body | Notes |
|---|---|---|---|
| GET | `/v1/health` | — | Liveness check. |
| GET | `/v1/whoami` | — | Identity of the calling key. |
| GET | `/v1/accounts` | `user` | Accounts visible to the participant (multi-account model). |
| GET | `/v1/users` | — | Users under the participant. |
| GET | `/v1/orderbook/{symbol}` | `depth` | Book: `{bids[], offers[], state, stats, transactTime}`; `stats` = `InstrumentStats` (`openPx/highPx/lowPx/closePx`, `lastTradePx/Qty`, `notionalTraded`, `sharesTraded`, `openInterest`, `settlementPx` + method/preliminary flag). |
| GET | `/v1/orderbook/{symbol}/bbo` | — | `{bestBid, bestOffer, midPrice, spread, state, transactTime}`. |
| POST | `/v1/refdata/instruments` | body: `{symbols[], states[], productId, clearingSym, eventCategory, eventSeries, startTimeGte/Lte, endTimeGte/Lte, tradableFilter, filter, pageSize, pageToken}` | Instrument master: `{symbol, description, tickSize, priceScale, fractionalQtyScale, minimumTradeQty, orderSizeLimit, priceLimit, expiration/termination dates, tradingSchedule, eventAttributes, state}`. |
| POST | `/v1/refdata/metadata` | body: `{}` variants | Instrument metadata. |
| POST | `/v1/refdata/symbols` | body: `{}` | All symbols. |
| POST | `/v1/trading/orders` | `InsertOrderRequest` | Insert order. |
| POST | `/v1/trading/orders/list` | `InsertOrderListRequest` | Batch insert. |
| POST | `/v1/trading/orders/cross` | `InsertOrderCrossRequest` | Pre-negotiated cross entry. |
| POST | `/v1/trading/orders/cancel` (+`/list`) | body | Cancel one / many. |
| POST | `/v1/trading/orders/replace` (+`/list`) | body | Cancel-replace one / many. |
| GET | `/v1/trading/orders/open` | `symbols[]`, `accounts[]` | Open orders. |
| POST | `/v1/trading/orders/preview` | body | Dry-run. |
| GET | `/v1/positions` | `name`, `symbol`, `as_of_time`, `as_of_date.*` | Point-in-time positions. |
| POST | `/v1/positions/balance` (+`/balances`) | body | Account balance(s). |
| GET | `/v1/positions/ledger` (+`/download`) | `account` (req), `symbol`, `start_time`, `end_time`, `newest_first`, `page_size`, `page_token` | Position ledger, JSON or CSV. |
| GET | `/v1/funding/balance-ledger` (+`/download`) | `account` (req), `currency`, `entry_types[]`, `symbol`, `description`, time range, pagination | Cash ledger. Entry types: `DEPOSIT`, `WITHDRAWAL`, `ORDER_EXECUTION`, `CORRECTION`, `RESOLUTION`, `MANUAL_ADJUSTMENT`, `ACCOUNT_PROPERTY_ADJUSTMENT`, `COMMISSION`, `WITHDRAWAL_REJECTION`, `MANUAL_TRANSFER`, `PENDING_WITHDRAWAL_CREATION`. |
| POST | `/v1/report/orders/search` (+`/csv`) | rich filter body (`accounts`, `symbol`, `orderStateFilter`, `clordId`, time/tradeDate ranges, pagination) | Historical order search. Order states incl. `PENDING_RISK`. |
| POST | `/v1/report/executions/search` (+`/csv`) | similar | Execution history. |
| POST | `/v1/report/trades/search` (+`/csv`) | similar (`tradeId`, `execId`, `states`) | Trade history. Trade states incl. `CLEARED`, `BUSTED`. |
| POST | `/v1/report/trades/stats` | body: `{symbol, startTime/endTime` or trade dates, `bars: int}` | **OHLC-style aggregates**: response `{stats, bars[]: TradeStats{first, high, low, last, volume, notional, totalTradeCount, cleared*}, barStartTime[], barEndTime[]}`. The only candlestick source in the whole REST surface — institutional-only. |
| GET/POST | `/v1/combos`, `/v1/rfqs` suites | same shapes as §3.2 | Shared spec with retail. |

### 3.4 Streaming & other protocols

| Channel | Audience | Notes |
|---|---|---|
| WebSocket — markets channel | Public | Live market data (prices/books). Same host family; documented in official docs. |
| WebSocket — private channel | Retail | Order/position updates; same Ed25519 auth scheme. |
| gRPC streaming | Institutional | Market data streaming; the institutional data guide also mentions candlestick data here. |
| FIX | Institutional | Order entry / drop copy. |

(Existence and audience are from official docs; the streams were not exercised in this probe.)

---

## 4. Data model notes

### Event

`{id, slug, ticker, title, subtitle, description, category, subcategory, startDate/endDate, eventDate, startTime, live, ended, closedTime, finishedTimestamp, volume, volume24hr, volume1wk, volume1mo, volume1yr, liquidity, openInterest, markets[], marketGroups[], tags[], primaryTag(-Slug), secondaryTag(-Slug), seriesSlug, score, eventState, period, elapsed, gameId, sportradarGameId, teams[], metadata{gameState, latestGameUpdate}, featureAvailability, resolutionSource, livestreamUrl, image, sortType, hidden, archived, active, closed}`

- `category` observed values: `sports | politics | culture | finance | technology | macro | crypto | geopolitics | science` (verified from live data).
- `eventState` carries live sports state — per-sport sub-objects (`baseballState`, `footballState`, `soccerState`, `tennisState`, `cricketState`, `ufcState`), `score`, `period`, `elapsed`, `mainSpreadLine`, `mainTotalLine`.
- **`marketGroups`** group related markets within an event via `marketIds[]` (`{id, title, subtitle, line, current, order, parentId, showAllThreshold}`). Sparse in practice: only **~21 of 500** active events sampled had them (verified). Don't design a UI that depends on their presence; fall back to flat `markets[]`.
- Live example (verified 2026-08-15): event `usfed-fomc-2026-09-16` ("Fed Decision in September", category `macro`) with markets `rdc-usfed-fomc-2026-09-16-hike50`, `-hike25`, … forming a mutually exclusive partition; sports slugs look like `tec-mlb-nlchamp-2026-09-27-lad`.

### Market

`{id, slug, question, title, titleShort/subtitle, description, marketType, sportsMarketType(+V2), feeCoefficient, orderPriceMinTickSize, minimumTradeQty, bestBid, bestAsk, outcomes, outcomePrices, marketSides[], line, spreadTotalSuffix, gameStartTime, subject(-Id), tags[], color/darkColor, image, status/ep3Status, active, closed, archived, hidden, createdAt, updatedAt}`

- `description` is the **settlement rules text** — the authoritative resolution criteria.
- `orderPriceMinTickSize` = 0.01 and `minimumTradeQty` = 0.01 on observed markets → **fractional contracts** (hundredths). Institutional refdata confirms with `fractionalQtyScale`.
- **`outcomes` and `outcomePrices` are JSON-encoded strings inside the JSON**, e.g. `"[\"Yes\",\"No\"]"` — double-parse required (verified).
- `marketSides[]`: `{id, identifier, long (bool), price, marketSideType (ERC1155 | INSTRUMENT), description, team(-Id) [deprecated]}`. The **Yes side has `long: true` and carries price + quote; the No side often has no embedded quote** (verified) — derive No prices as `1 − yesPrice`.
- Schema drift (verified): the OpenAPI spec types `bestBid`/`bestAsk` as plain numbers, but live responses also include `bestBidQuote`/`bestAskQuote` as `{value, currency}` objects not present in the spec. Observed `feeCoefficient`: 0.06. Observed status: `MARKET_STATUS_OPEN`; full state machine (from spec): `OPEN, PREOPEN, SUSPENDED, EXPIRED, TERMINATED, HALTED, MATCH_AND_CLOSE_AUCTION`.

### Money & prices

- Monetary amounts are `Amount {value: string (decimal), currency: "USD"}` — **decimal strings, not floats**. Parse with a decimal type; don't do float math on fee-sensitive paths.
- Book levels: `{px: {value, currency}, qty}`, best-first (verified).
- BBO "lite" market data adds `askDepth`/`bidDepth` — these are **level counts**, not size totals (verified).
- `MarketStats` (full book response) exposes session OHLC-ish fields (`openPx/highPx/lowPx/closePx`, `lastTradePx/Qty`, `notionalTraded`, `openInterest`, settlement fields, `tradingReferencePx`) — current-session snapshots only, not history.

### Pagination — three styles, know which you're holding

| Style | Where |
|---|---|
| `limit`/`offset` | Gateway: events, markets, series, tags, sports |
| `limit`/`cursor` → `nextCursor`, `eof` | Retail: portfolio positions, activities; RFQs |
| `page_size`/`page_token` → `nextPageToken` | Incentives; institutional refdata/ledgers/reports |

---

## 5. Market microstructure & fees

### Single book, YES/NO equivalence

Each binary market has **one order book**. YES and NO are two views of the same instrument: buying NO at price `q` is economically identical to selling YES at `1 − q`. The API embraces this: orders can be expressed either as `intent` (`BUY_LONG`/`SELL_LONG`/`BUY_SHORT`/`SELL_SHORT`) or as `outcomeSide` (`YES`/`NO`) + `action` (`BUY`/`SELL`), and the engine nets everything into the single book. This is also why embedded No-side quotes are frequently absent from `marketSides` — they're derivable.

### Fee formula (schedule effective 2026-07-01)

```
fee = theta × contracts × price × (1 − price)
```

| Role | theta | Sign |
|---|---|---|
| Taker | 0.06 | fee (you pay) |
| Maker | 0.0125 | **rebate** (you receive; negative fee) |

The `price × (1 − price)` term makes fees symmetric around $0.50 and near-zero at the extremes. Worked examples for **100 contracts**:

| Price | Taker fee / contract | Taker fee (100) | Maker rebate / contract | Maker rebate (100) |
|---|---|---|---|---|
| $0.10 | 0.06 × 0.10 × 0.90 = $0.0054 | $0.54 | $0.001125 | $0.1125 |
| $0.50 | 0.06 × 0.25 = $0.0150 (max) | $1.50 | $0.003125 | $0.3125 |
| $0.90 | 0.06 × 0.90 × 0.10 = $0.0054 | $0.54 | $0.001125 | $0.1125 |

- Rounding is **banker's rounding** (round-half-to-even) per docs.
- Volume-based **taker rebates** kick in at ≥ $250k/month traded (documented; corroborated by the `ACTIVITY_TYPE_TAKER_FEE_REBATE` activity type in the portfolio schema).
- Each market carries its own `feeCoefficient` (observed 0.06 everywhere sampled) — read it per-market rather than hardcoding; order objects also report realized `commissionsBasisPoints` / `makerCommissionsBasisPoints` / `commissionNotionalTotalCollected`.
- Maker liquidity is further incentivized via the programs on `/v1/incentives` (reward pools per market/time period).

### Margin & MECR (mutually exclusive contract relief)

Shorting (selling YES you don't hold, i.e. `BUY_SHORT`/`SELL_SHORT` intents) requires collateral against worst-case loss. Per docs, **MECR** applies margin relief when you short multiple outcomes within a mutually exclusive event group (e.g. all FOMC decision buckets): since at most one outcome can resolve YES, the margin requirement is based on the worst single outcome resolving against you, not the sum across legs. *(Documented concept; not independently verified via order preview in this probe — validate with `POST /v1/order/preview` before relying on exact collateral numbers.)* The `marginRequirement` and `balanceReservation` fields in `/v1/account/balances` are where this shows up.

---

## 6. Rate limits & operational notes

| Surface | Limit | Behavior on excess |
|---|---|---|
| Authed (per API key) | 20 req/s | HTTP 429 "Too Many Requests" (verified) |
| Public (per IP) | 20 req/s | HTTP 429 (verified) |

- **No rate-limit response headers** (no `X-RateLimit-*`, no `Retry-After` documented or observed). Budget client-side: token bucket at ≤ 20 rps, plus exponential backoff on 429.
- The 30s timestamp window means clock skew > 30s breaks all authed calls. Sync NTP; on persistent 401s, check skew before suspecting the key.
- Caching advice: metadata (events, markets, tags, sports, series) changes slowly — cache 30–60s+. BBO/book are per-market calls; at 20 rps you can refresh ~1,200 markets/min max, so for broad scans prefer `/v1/events?limit=500` (bulk, includes embedded prices) and reserve `/bbo`+`/book` calls for markets you're actively watching. For real-time needs, use the WebSocket markets channel instead of polling.
- `limit` on `/v1/events` maxes out at 500 (verified); ~2,750 active events currently means about six pages cover the active universe. Dedupe by slug across pages — the listing can shift mid-pagination and repeat an event on a page boundary (observed live).
- Public endpoints tolerate signed requests, so a single signing client can talk to both hosts without branching (verified).

---

## 7. Gaps & sharp edges

1. **No historical prices in the retail REST API — the biggest gap.** No candles, no price history, and no price-change/`24hrChange` fields anywhere in the retail/gateway surface (confirmed by exhaustive schema enumeration). The only OHLC-style endpoint is institutional (`POST /v1/report/trades/stats` with `bars`), and the institutional data guide mentions candlesticks on its streams. Retail apps must sample prices themselves (what Crossbook does) or consume the WebSocket feed.
2. **List endpoints never populate their volume/liquidity/openInterest fields** (verified live). The proto schemas define `volume`, `volume24hr`, `volume1wk/1mo/1yr`, `liquidity`, and `openInterest` on Event and Market, but `/v1/events` and `/v1/markets` return none of them, and `orderBy=volume24hr` doesn't reorder results. Real open interest and cumulative shares traded ARE returned per-market by `/v1/markets/{slug}/bbo` — ranking anything by activity means sampling BBO yourself (what Polyscope's rotating sampler does).
3. **Signature excludes the query string** (§2). Verified 401 vs 200. Easily the most likely integration bug.
4. **64-byte secret vs docs' seed-only Python example.** Secrets are libsodium 64-byte (`seed || pubkey`); the docs' example assumes a 32-byte seed. Take the first 32 bytes for seed-based APIs.
5. **Institutional wall is real.** Retail keys → 401 on `api.prod.polymarketexchange.com` (verified). Order book by symbol, refdata, ledgers, reports, trade stats, FIX, gRPC all require separate onboarding.
6. **No-side quotes often absent from `marketSides`** (verified). Compute NO as `1 − YES`; don't join on the No side's embedded quote.
7. **`outcomes`/`outcomePrices` are JSON-strings inside JSON** (verified) — requires a second parse; typed clients need a custom decoder.
8. **Spec/host inconsistency for Combos & RFQs:** documented alongside the retail API, but their OpenAPI `servers` field points at `api.prod.polymarketexchange.com`. The suites appear on both hosts; treat host selection as something to verify per-deployment. (Spec observation; retail-host availability per docs.)
9. **Schema drift on live responses:** `bestBidQuote`/`bestAskQuote` (and quote objects on `marketSides`) appear in live payloads but not in the OpenAPI spec, which types `bestBid`/`bestAsk` as bare numbers (verified). Build tolerant parsers; don't `additionalProperties: false`.
10. **Proto-generated spec noise:** `/v1/series` documents both flat params (`limit`, `slug[]`…) and leaked `params.*` duplicates (`params.limit`, `params.seriesFilters.slug`…) — an artifact of gRPC-gateway generation; the flat forms work. The two market spec files (`market.json`/`markets.json` in our snapshot) are byte-similar duplicates of one spec.
11. **Three pagination styles** (offset / cursor / page-token, §4) across one product — easy to conflate.
12. **`marketGroups` sparsity** (~21/500 events, verified) — partition/arbitrage logic (e.g. mutually-exclusive bucket sums) can't rely on them; slug conventions (`rdc-…-hike25/hike50`) are an unofficial fallback.
13. **Search only returns events** (`SearchResponse{events[]}`) — no market- or tag-level hits; resolve markets client-side from the embedded `markets[]`.
14. **`askDepth`/`bidDepth` are level counts, not sizes** (verified) — don't treat them as liquidity measures; fetch `/book` and sum `qty` for that.
15. **Timestamp discipline:** auth header is unix **milliseconds**, while body/query dates are RFC3339-ish strings and incentives use `start_date`/`end_date` — three time formats in one integration.
16. **Amounts are decimal strings** — float math will disagree with the exchange's banker's rounding on fees; use a decimal library.

---

## 8. What we built on it

Crossbook consumes the **public gateway** — the full active-events universe via `/v1/events` and per-market order books via `/v1/markets/{slug}/book` — alongside Kalshi's public API, to match identical questions across the two venues and price fee-adjusted cross-venue edges from live books. The retail authenticated endpoints power only an optional status chip (`/v1/account/balances`); without keys the entire product runs on public data. No mutating endpoint is called anywhere — there is deliberately no order-placement code path.
