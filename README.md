# proxy-seller Node.js API

Client library for Proxy-Seller Client API v2.

```sh
npm i proxy-seller-user-api
```

## Quick start

```js
import ProxySellerUserApi, { ApiError } from 'proxy-seller-user-api';

const api = new ProxySellerUserApi({
  key: 'YOUR_API_KEY',
  timeout: 30_000
});

try {
  console.log(await api.balance());
} catch (error) {
  if (error instanceof ApiError) {
    console.error(error.code, error.message, error.errors, error.customData);
  }
}
```

Nothing else is required — the client talks to `https://proxy-seller.com/personal/api/v2/` by
default. The API key goes into the URL path, not a header. Requests are paced to stay under the
API's limits — see [Rate limits and the request queue](#rate-limits-and-the-request-queue).

### Paying for orders

Every order and renewal is charged to a payment system, and an API client has exactly two to
choose from — both addressed by a stable code. Set it once:

```js
api.setPaymentCode('balance');                // the account balance
// or charge the card saved on the account:
api.setPaymentCode('paddle_subscription');
```

`order/*`, `prolong/*` and `autoprolong/*` accept nothing else: a one-off checkout (PayPal,
crypto, a new card) ends on a hosted payment page a headless client cannot complete, so the
server rejects it. A single call can pass `{ paymentCode: 'balance' }` in its options instead.

`balancePaymentsList()` is **not** where these come from. It lists the systems you can **top up**
the balance with, for `balanceAdd()`, and the balance itself is never in it. Top-ups are the one
place where an id is unavoidable: several payment systems share the same internal code (a single
`cryptomus` covers "USDT (TRC-20)", "All cryptocurrencies" and more), so `balanceAdd()` takes the
ObjectId from that list — see [Balance](#balance). Everywhere else you use human-readable codes.

<details>
<summary>Pointing the client at another host, and Axios options</summary>

```js
const api = new ProxySellerUserApi({
  key: 'YOUR_API_KEY',
  baseUrl: 'http://localhost:7995/personal/api/v2/',
  headers: { 'X-Request-Source': 'my-app' }
});
```

The constructor also accepts Axios options. Method-level options are merged safely; the SDK keeps
its own URL, method, base URL and headers authoritative.

</details>

### Sending a fingerprint

`order/make` can carry an `X-Fingerprint` header — an identifier of your installation, used for
anti-fraud and affiliate attribution. It is **optional**: orders placed with an API key are
created without it, residential and scraper orders included. The SDK sends the header whenever
you provide a value and simply leaves it out when you do not — it never fails a call over it.

```js
const api = new ProxySellerUserApi({ key: 'YOUR_API_KEY', fingerprint: 'your-installation-id' });
// or later:
api.setFingerprint('your-installation-id');
// or for a single call:
await api.orderMakeResident('tarif-code', null, { fingerprint: 'your-installation-id' });
```

Any opaque string is accepted — the server does not validate its shape — but if you send one,
make it a **stable identifier of your installation**. The SDK deliberately does not generate
one: a value randomized per process would break the attribution the header exists for. An empty
or whitespace-only value counts as not set, and `order/calc` never sends the header.

## IDs in v2 are strings

Every id in v2 is a MongoDB ObjectId **string** (`"665f1c…"`), not a number. Never parse an
id into `Number`/`parseInt` — that silently produces `NaN` or a truncated value. This applies
to `orderId`, order/prolong ids, payment system ids, auth ids, IP address ids, country, period,
mix, operator and tariff ids. Numeric v1 ids do not resolve in v2 at all.

Two things are **not** ObjectIds:

- **resident list ids are numeric** (`Long`) — `residentList()`, `residentListRename()`,
  `residentListRotation()`, `residentListDelete()`, the `listId` / `id` parameter of the
  resident export;
- **`rotationId` is an interval in minutes**, not an id at all — see below.

## Codes go into the `*Id` argument

Codes are resolved server side for `order/*` and `prolong/*` only, and they are resolved
**inside the `*Id` field itself**: if the value in `countryId`, `periodId`, `paymentId`,
`operatorId`, `mixId` or `tarifId` is not a valid ObjectId *and* the matching `*Code` field is
empty, the server retries the same value as a code.

So a code goes straight into the positional argument — there is no need for a chain of `null`s
followed by an options object:

```js
// A code in the id slot. Positional, no options object.
await api.orderCalcIpv4('USA', '1m', 2, null, null, 'scraping');

// Mobile: country code, period code, operator id/tag, rotation in minutes.
await api.orderCalcMobile('USA', '1m', 1, null, null, 'OPERATOR_ID', 5);
```

Case handling of the fallback: `countryId` is upper-cased (so it matches the alpha-3 code), `periodId`
is lower-cased, `operatorId` is matched against the operator tag as given, `mixId` must match a
MIX `tag` exactly, `tarifId` must match a tariff `code` exactly. `paymentId` is matched against
the payment-system code and then against the payment-system type name (`BALANCE`,
`PADDLE_SUBSCRIPTION`, … in any letter case).

The explicit `*Code` fields (`countryCode`, `periodCode`, `paymentCode`, `mixCode`,
`operatorCode`, `tarifCode`) still work and are what `orderCalcMixByCode()` /
`setPaymentCode()` use. But reach for the options object only for fields the positional
signature does not cover — `uptime` on ipv4/isp — not merely to carry a code. Everything else already has a slot: `protocol` in the ipv6 helpers,
`mobileServiceType` and `rotationId` in the mobile ones.

### `rotationId` is minutes, not a code

`rotationId` is the only reference field with **no** code fallback, and it is not an id either —
it is the rotation interval in **minutes**, as an integer: `0` = *By Link*, `5`, `10`, `60`…
`rotationCode` is accepted in the request body, but the server only checks that it is an
integer and copies it into `rotationId`; nothing is looked up. A value such as `'5m'` or
`'10m'` is therefore always rejected with `Set existed [rotationCode] from reference`. Pass the
number (`5`, `10`, `0`) into `rotationId`, and skip `rotationCode` — it buys nothing.

### What `referenceList()` actually returns

Every field comes back as `id`, and its value is a readable code — not an ObjectId. Read `id`,
put it in the matching `*Id` argument. That is the whole rule:

| you need | `referenceList()` gives | pass |
|---|---|---|
| country | `country[]`: `id`, `name` | `id` (`"USA"`) as `countryId` — upper-cased server-side |
| period | `period[]`: `id`, `name` | `id` (`"1m"`) as `periodId` — lower-cased server-side |
| mobile operator | `mobile.country[].operators.{dedicated,shared}[]`: `id`, `name`, `rotations[]` | `id` as `operatorId` — exact match, case-sensitive |
| rotation | `operators[].rotations[]`: `id` = minutes, `name` = `"5 minutes"` / `"By Link"` | that `id`, as a number, in `rotationId` — the one `id` that is a number, not a code |
| MIX package | `mix.quantities[]`: `id`, `name`, `quantities[]` | `quantities[].id` as `mixId` — the first argument of `orderCalcMix()` |
| resident tariff | `resident.tarifs[]`: `id`, `name`, `personal` | `id` (`"1-gb"`) as `tarifId` — exact match |
| payment system | nothing — `balancePaymentsList()` lists top-up systems only, and the balance is not among them | `'balance'` or `'paddle_subscription'` as `paymentCode`, see [Paying for orders](#paying-for-orders) |

ObjectIds are still accepted everywhere if you happen to have them; the reference simply no longer
publishes them.

**The typed call is shaped differently.** `referenceList()` without a type returns `data` keyed by
type (`data.mix.quantities`, `data.resident.tarifs`, …), exactly as the table above shows. Passing
a type wraps the single entry in `items` instead:

```js
const all = await api.referenceList();          // all.mix.quantities
const mix = await api.referenceList('mix');     // mix.items.quantities  ← note the wrapper
```

`items` here is an **object**, not an array — for `resident` and `scraper` it is `{ tarifs: [...] }`,
for `mix` and `mix_isp` it is `{ country, period, quantities }`, and `{ country, period }` for the
rest.

## Error handling

Almost everything answers **HTTP 200**, with the outcome inside the envelope
`{status, data, errors}`. The SDK unwraps it: on `status: "success"` it returns `data`, and
otherwise it throws an `ApiError` built from `errors[0]`.

`ApiError` fields:

| field | meaning |
|---|---|
| `message` | `errors[0].message` |
| `code` | `errors[0].code` (business code, see below) |
| `customData` | `errors[0].customData` — e.g. the allowed boundary for auto top-up validation |
| `errors` | the **whole** `errors` array |
| `body` | the whole envelope as received |
| `httpStatus` | HTTP status (200 in almost every failure) |

**Always look at `error.errors`, not only at `error.message`.** Access failures — invalid or
unknown API key, caller IP not in the key's allowlist, and rate limit exceeded (1000 req/min
per key) — all come back as HTTP 200 with the same fixed triple:

```js
[
  { message: 'Error api key',           code: 503 },
  { message: 'IP not allowed 1.2.3.4',  code: 503 },
  { message: 'Request limit reached',    code: 503 }
]
```

so `errors[0].message` is always `"Error api key"` regardless of which of the three actually
happened. The API itself never answers HTTP 429 — a request over its limit is a 200 with this
triple. A 429 comes only from the network edge in front of the API, for a request that never
reached it, and the SDK retries it for you — see
[Rate limits and the request queue](#rate-limits-and-the-request-queue).

Local (pre-flight) validation failures are thrown as `ApiError` too — every error the SDK
raises is an `ApiError`, so a single `catch (e) { if (e instanceof ApiError) … }` covers both
sides. Two responses bypass the envelope entirely: file downloads (see below) and an invalid
`ext`, which the server rejects with a bare plain-text HTTP 400 — the SDK validates `ext`
locally to avoid it (max 250 chars, no CR, LF, `/` or `\`).

## Rate limits and the request queue

The client paces its own requests so that one API key stays under the API's limits without any
code on your side. This is on by default.

Every request falls into one of three categories by its endpoint path — not by its HTTP method:
the `*/calc` endpoints are `POST`, but they change nothing.

| category | endpoints |
|---|---|
| money | `order/make`, `prolong/make/{type}`, `balance/add` |
| write | `autoprolong/enable/{type}`, `autoprolong/disable/{type}`, `auth/add`, `auth/add/ip`, `auth/change`, `auth/delete`, `proxy/replace`, `proxy/comment/set`, `balance/autotopup/set`, `resident/list` (the `POST` form of `resident/list/add`), `resident/list/{add,delete,rename,rotation,tools}`, `residentsubuser/{create,update,delete}`, `residentsubuser/list/{add,delete,rename,rotation,tools}` |
| read | everything else: every `*/list`, `*/get` and `*/calc` (`order/calc`, `prolong/calc/{type}` and `autoprolong/calc/{type}` included), `reference/*`, `proxy/download/*`, `resident/package`, `resident/lists`, `resident/geo*`, `resident/consumption`, `resident/traffic/details`, `residentsubuser/packages`, `residentsubuser/lists`, `balance/payments/list`, `balance/autotopup/get`, … |

What the queue does:

1. **At most 1000 request starts in any 60 seconds** (`requestsPerMinute`), across all three
   categories and counting every retry. It is a sliding window, not a token bucket: once 1000
   requests have started within the last 60 seconds, the next one waits until the oldest of them
   is 60 seconds old, so a burst never goes over the limit.
2. **Write and money requests go one at a time.** The next one starts only after the previous one
   has finished, no earlier than 1000 ms (`writeIntervalMs`) after the previous write or money
   request started, and — for a money request — no earlier than 2000 ms (`moneyIntervalMs`)
   after the previous money request started. Reads never wait for this lane, only for the
   60-second window, so they keep running in parallel while a renewal is in flight.
3. **HTTP 429 is retried.** The network edge in front of the API answers it for a request that
   never reached the API, so repeating the request is safe even for money. The SDK waits
   `Retry-After` (seconds or an HTTP date; 2 s when the header is missing or unreadable; never
   longer than 60 s) and sends the request again, up to 3 times (`maxRetries`); after that it
   throws the usual `ApiError` with `httpStatus: 429`. A retried write or money request keeps its
   place in the lane — nothing queued behind it jumps ahead.
4. **Nothing else is retried**, and two answers in particular reach you exactly as before:
   - code 57, `Prolong for this order is already in progress` — a blind retry could renew the
     same order twice;
   - the access-denied triple (code 503, see [Error handling](#error-handling)) — its
     `Request limit reached` cannot be told apart from a wrong key or an IP outside the allowlist.

Waiting only delays the promise a call returns; nothing blocks the event loop. A call that the
SDK's local checks reject never enters the queue.

To change the pace or turn it off, pass `rateLimit` to the constructor:

```js
const api = new ProxySellerUserApi({
  key: 'YOUR_API_KEY',
  rateLimit: {
    requestsPerMinute: 600, // default 1000
    writeIntervalMs: 1500,  // default 1000
    moneyIntervalMs: 3000,  // default 2000
    maxRetries: 5           // default 3; 0 never retries a 429
  }
});

// Off: every request goes out at once and nothing is retried — the behaviour before the queue.
const unpaced = new ProxySellerUserApi({ key: 'YOUR_API_KEY', rateLimit: { enabled: false } });
```

An option you leave out keeps its default, and `rateLimit: false` is short for
`{ enabled: false }`. An unknown option or an invalid value throws an `ApiError` from the
constructor. For tests with fake time, `rateLimit.now` (a millisecond clock) and
`rateLimit.sleep` (`ms => Promise`) replace the clock and the timer.

**The queue belongs to one client instance.** Two instances with the same key, or several
processes sharing it — cluster workers, serverless invocations, cron jobs — each pace only
themselves: they do not coordinate and together can go over the limits. Create one client per
key and share it across your code. When several processes do share a key, the server can still
answer code 57 or the access-denied triple; handle them as you would without the queue.

Keep a request `timeout` (30 s by default): the lane waits for the previous write to finish, so a
request that never gets an answer would hold up every write behind it.

## Orders

Positional calls take an ObjectId **or** a code in the same argument (see above), so the
ordinary call is positional. The object form exists for payloads that do not fit the
positional signature.

```js
api.setPaymentCode('balance'); // or 'paddle_subscription' — see “Paying for orders” above

// countryId='USA' and periodId='1m' are country[].id / period[].id from the reference:
await api.orderCalcIpv4('USA', '1m', 2, null, null, 'scraping');

// uptime has no positional slot — this is what the options object is for:
await api.orderCalcIpv4('USA', '1m', 2, null, null, 'scraping', { uptime: true });

// Mobile: (countryId, periodId, quantity, authorization, coupon, operatorId, rotationId,
// mobileServiceType). rotationId is MINUTES — 10, not '10m'. mobileServiceType defaults
// to 'dedicated', pass 'shared' explicitly when you need it.
await api.orderMakeMobile('USA', '1m', 1, null, null, 'OPERATOR_ID', 10);
await api.orderMakeMobile('USA', '1m', 1, null, null, 'OPERATOR_ID', 0, 'shared');

// MIX takes a package code (reference/list/mix -> quantities[].id), not a countryId:
await api.orderCalcMix('europe-2-mix_IPv4', '1m', 1);

// Resident: tarifId accepts the tariff ObjectId or its code.
await api.orderCalcResident('TARIF_ID');
```

The remaining `null`s above are the genuinely optional `authorization` and `coupon`
arguments — not placeholders for codes.

`mobileServiceType` is required by the API; the SDK defaults it to `dedicated`.
`uptime` is available for supported IPv4/ISP combinations.
`setGenerateAuth('Y')` affects only `order/make`.

`customTargetName` — what you use the proxies for. Required for `ipv4`, `ipv6` and `isp`;
without it the server answers `Incorrect goal`, code 14. For `mix` / `mix_isp` it is only needed
when the server cannot tell which package you mean, so naming the package removes the need for it.

### Listing orders

```js
await api.orderList({
    status: 'PAYED',       // PAYED | NOT_PAYED | RETURN — the status_type of the response
    sort_by: 'date_insert', // date_insert | summ | status
    order: 'desc',
    page: 1,
    limit: 20
});

await api.orderList(); // the same call with no filters at all
```

Every filter is optional: `order_id`, `start_date`, `end_date`, `status`, `is_extend`,
`auto_order`, `page`, `limit`, `sort_by`, `order`. Query filters and response fields of
`order/list` use snake_case names such as `start_date` and `is_extend` — pass them exactly as
listed.

The result is not a flat list but a `metadata` + `items` pair, and `metadata` is always there:
without `limit` it reports `total_pages: 1`, `current_limit: 0` and the whole list in `items`.
`summ` and `items[].price` are **strings with the currency already in them** (`'$25.00'`),
`auto_order` and `is_extend` are `'Y'`/`'N'` rather than booleans, and the dates are ISO 8601
strings with offset (`2026-09-01T14:15:26+00:00`). `id` is a numeric order ID sent as a string;
the ObjectId is `order_id` — the same value `proxyList()` returns as `order_id`, and the one
`prolong/*` and `autoprolong/*` take in `orderIds`.

## Renewing proxies

What you pass depends on the proxy type: `ipv4`, `isp` and `mobile` are renewed per proxy,
`ipv6`, `mix` and `mix_isp` only as whole orders. Every value below is a field `proxyList()`
really returns:

| type | what you pass | sent as |
|---|---|---|
| `ipv4`, `isp` | the address — the `ip` field, e.g. `1.2.3.4` — or the proxy `id` | `ips` / `ids` |
| `mobile` | the address — `ip` + `:` + `port_http` + `:` + `port_socks` — or the proxy `id` | `ips` / `ids` |
| `ipv6`, `mix`, `mix_isp` | the `order_id` of the order (also in `orderList()`) | `orderIds` |

```js
const { items } = await api.proxyList('ipv4');
const ips = items.map(item => item.ip);          // ['1.2.3.4', '5.6.7.8']

await api.prolongCalc('ipv4', ips, '1m');        // price first
await api.prolongMake('ipv4', ips, '1m');        // deducts money
```

The SDK routes every value by its shape: a value with a `.` or `:` is an address and goes to
`ips`; anything else is an id and goes to `ids` — or to `orderIds` for `ipv6`, `mix` and
`mix_isp`. An array, a comma-separated string and a `Set` all work.

For `ipv4`, `isp` and `mobile` pass **either ids or addresses in one call, not both**. The server
renews by `ids` and ignores `ips` when both are present, so the addresses would silently drop
out of a paid renewal; the SDK throws an `ApiError` (`Mixing proxy ids and addresses in one call
is not supported…`) instead of sending such a request — whether the mix comes from one list, from
the list plus `options`, or from the object form.

`prolongCalc()` shows the price; `prolongMake()` charges the balance. If the balance is short,
`prolongMake()` throws an `ApiError` with the server's warning — it never reports a renewal that
did not happen. The period takes a code positionally (`'1m'`), same fallback as `order/*`, and
the fourth argument is a coupon:

```js
await api.prolongMake('ipv4', ips, '1m', 'SALE10');
```

On success `prolongMake()` returns every renewed order — one request can renew several:

```js
{
  orderId: '6a248de4717805635cf6057d',                  // the first of orderIds
  orderIds: ['6a248de4717805635cf6057d', '6a248de4717805635cf6058a'],
  total: 25.00,
  listBaseOrderNumbers: ['NS_1790059585687-no', 'NS_1790059601234-kq'],
  balance: 100.50
}
```

`listBaseOrderNumbers` holds one base order number per renewed order (per package for `mix` /
`mix_isp`), matching `base_order_number` in `orderList()`.

### ipv6, mix and mix_isp are renewed as whole orders

`ipv6`, `mix` and `mix_isp` are sold and renewed only as whole orders, by `orderIds`. Every
active proxy of that type in those orders is renewed — for `mix` / `mix_isp`, the mix packages
of those orders — and the quote covers all of them:

```js
const { items } = await api.proxyList('ipv6');
const orderIds = new Set(items.map(item => item.order_id));

await api.prolongCalc('ipv6', orderIds, '1m');
await api.prolongMake('ipv6', orderIds, '1m');
```

A proxy `id` and an `order_id` look alike (both are ObjectIds), so pass the `order_id`: a proxy
`id` sent for these types lands in `orderIds`, and the whole request fails with
`Incorrect orderIds` (code 29) — the same answer you get when any of the orders is not yours, has
no active proxy of that type, or nothing was selected at all. `ipv6` is no longer renewed by
`host:port`: an address sent for these types goes to `ips`, and the server answers
`[ips] is not applicable for ipv6: prolong by [orderIds]` with code 0. (Here a list with both
order ids and addresses is not rejected locally — nothing is lost silently, the server rejects
the addresses and names the field.)

<details>
<summary>The object form</summary>

Pass an object instead of the selection to write the body yourself: `ids`, `ips`, `orderIds`,
`periodId`/`periodCode`, `paymentId`/`paymentCode`, `coupon`. The fields go out as given (empty
lists are dropped), and the server checks the selection against the type: a field of the wrong
kind is rejected with code 0 and an error that names the right one — `ids` for `ipv6`, for
example, with `[ids] is not applicable for ipv6: prolong by [orderIds]`, and `orderIds` for
`ipv4` with `[orderIds] is not applicable for ipv4: prolong by [ids]`.
`ids` together with `ips` for `ipv4` / `isp` / `mobile` throws locally, as described above:

```js
await api.prolongMake('mix', { orderIds: ['ORDER_ID'], periodId: '1m', coupon: 'SALE10' });
```

The same fields are accepted in the `options` argument of the positional call.

</details>

### Removed request fields

`orderSeparatorIds` and `orderSeparatorId` are **no longer part of the contract** — the server
does not read them. Rather than dropping them and sending a renewal without the selection you
meant, the SDK throws an `ApiError` that names the replacement, whether the field comes in
`options` or in the object form:

| removed field | message | use instead |
|---|---|---|
| `orderSeparatorIds`, `orderSeparatorId` | `` `orderSeparatorIds`/`orderSeparatorId` were removed: use `orderIds` `` | `orderIds` |

The key alone triggers it, even with an empty value.

## Automatic renewal

`prolongMake()` charges you now. `autoprolong/*` only arms a charge that happens later, without
you present — a separate branch of the API, not a flag on prolong. The selection works exactly as
in [Renewing proxies](#renewing-proxies): addresses or proxy ids for `ipv4`, `isp` and `mobile`,
`order_id` values for `ipv6`, `mix` and `mix_isp`.

```js
await api.autoProlongCalc('ipv4', ['1.2.3.4'], '1m', { paymentId: 'balance' });
await api.autoProlongEnable('ipv4', ['1.2.3.4'], '1m', { paymentId: 'balance' });
await api.autoProlongDisable('ipv4', ['1.2.3.4']);

// ipv6 / mix / mix_isp: the whole order
await api.autoProlongEnable('ipv6', ['ORDER_ID'], '1m', { paymentId: 'balance' });
```

The same local checks apply as in `prolong/*`: ids and addresses are not mixed for `ipv4` /
`isp` / `mobile`, and `orderSeparatorIds` / `orderSeparatorId` throw with their replacement (see
[Removed request fields](#removed-request-fields)).

`paymentId` is **mandatory** for `calc` and `enable` — the charge happens while you are away, so
the payment system cannot be guessed. Only `balance` and `paddle_subscription` are accepted: a
one-off Paddle checkout needs a browser redirect a headless client cannot complete. With
`paddle_subscription` also pass `subscriptionId`.

Residential packages renew as a package, not as addresses — send no selection:

```js
await api.autoProlongCalc('resident', null, null, { paymentId: 'balance' });
await api.autoProlongEnable('resident', null, null, { paymentId: 'balance', tarifId: 'trial' });
await api.autoProlongDisable('resident');
```

`resident` has no selection fields at all — the server rejects any of `ids` / `ips` / `orderIds`
with `[ids] is not applicable for resident: auto-prolong applies to the whole package`. The SDK
does not send them: any selection for `resident` — a non-empty list argument, or `ids` / `ips` /
`orderIds` in `options` or in the object form — throws an `ApiError` locally (`resident
auto-prolong applies to the whole package: do not pass proxy or order ids`). It is never stripped
silently: a `disable` meant for a few addresses would switch auto-renewal off for the whole
package.

Three things about the answers before you parse them:

* **`ids` and `orderIds` are not an echo.** `enable` and `disable` return the proxies actually
  affected in `ids` and their orders in `orderIds`; `quantity` counts the proxies. For `ipv6`,
  `mix` and `mix_isp` that is every active proxy of the orders you sent. For `resident` both lists
  are empty and `quantity` is 1 — the package.
* **Not enough money is not an error throw.** `calc` answers `status: "error"` with a *filled*
  `data` and an empty `errors[]` — the same shape `prolong/calc` uses. Read `data.warning`.
  `enable` still switches renewal on in that case and fills `data.warning` too: the money is
  needed at `chargeDate`, not now.
* **Residential fills different fields.** `chargeDate` is null there (a package renews on expiry
  *or* on traffic exhaustion, so no single date describes it); `tarifId`, `days` (the tariff's own
  period) and `dateEnd` carry the meaning instead.

`scraper` has no auto-renewal: it is extended by buying traffic through `order/make`.

> Replaces `resident/autorenew/{enable,disable,calculate}`, **removed** from the server.

## Balance

```js
await api.balance();               // number
await api.balancePaymentsList();   // payment systems available for a top-up
await api.balanceAdd(25, 'PAYMENT_SYSTEM_OBJECT_ID');
```

`balance/add` accepts **only `paymentId`** — an ObjectId taken from
`balancePaymentsList()`. It does not resolve stable payment codes: the endpoint reads just
`summ` and `paymentId`, and the code resolution that `order/*` and `prolong/*` perform does not
happen there. `setPaymentCode()` therefore has no effect on `balanceAdd()`, and the SDK
throws a local `ApiError` explaining this instead of sending `paymentId: null`.

`balance` cannot be topped up with `balance` — that payment system is excluded from the list
and rejected by the endpoint.

### Auto top-up

```js
const state = await api.balanceAutoTopupGet();
// { configured, enabled, state, threshold, amount, subscriptionId,
//   paymentMethod: { id, status, paymentMethod, brand, last4, exp } | null,
//   failCount, lastAttemptAt,
//   lastEvent: { status, amount, at, reason } | null }

// Turn it on:
await api.balanceAutoTopupSet({ enabled: true, threshold: 10, amount: 25 });

// Partial update — only the threshold changes, everything else stays as saved:
await api.balanceAutoTopupSet({ threshold: 20 });
```

`state` is one of `NO_PAYMENT_METHOD`, `DISABLED`, `ACTIVE`, `PAYMENT_INVALID`,
`PAUSED_FAILURES`. `lastEvent.status` is one of `TRIGGERED`, `SUCCEEDED`, `FAILED`,
`SKIPPED_CAP`, `SETTINGS_SAVED`, `PAUSED`.

> **`dailyCountCap` and `monthlyAmountCap` are gone.** They were removed from the contract on
> 2026-08-18: the server silently ignores them, and they are absent from the response. The SDK
> now rejects them instead of letting the call look successful while changing nothing.

`balance/autotopup/set` is a **partial update**: any field you omit keeps its stored value,
and the server validates the *merged* result. The SDK sends only the fields you actually
passed — `undefined` and `null` are dropped rather than sent as `null` — and rejects a call
with no recognised field at all. Accepted fields: `enabled`, `threshold`, `amount`,
`subscriptionId`. On success the response is the state
**after** saving, so no follow-up `balanceAutoTopupGet()` is needed.

Pause and the failed-charge counter are reset only on an explicit `enabled: true` — editing a
threshold on a paused configuration does not silently resume it.

Validation boundaries: `threshold >= 1`, `amount >= 5` and `amount >= threshold`. Error codes:

| code | meaning |
|---|---|
| 49 | auto top-up is not available on this environment |
| 50 | threshold below the minimum (`customData.minThreshold`) |
| 51 | amount below the minimum (`customData.minAmount`) |
| 52 | amount below the threshold — it would trigger again immediately |
| 53 | no saved payment method |
| 56 | the saved card has expired |

Codes 54 and 55 were removed together with the caps and are not reused. `customData` now
carries only `minAmount` and `minThreshold`.

## Proxies

```js
await api.proxyList('ipv4', { orderId: 'ORDER_OBJECT_ID', latest: 'Y' });
await api.proxyCommentSet(['IP_ID_1', 'IP_ID_2'], 'my comment');
```

Filters: `latest`, `orderId`, `country`, `ends`, and `page` / `per_page` for the typed route.

- `latest: 'Y'` returns only the proxies of the latest order among those the request returns:
  with a type, the latest order of that type (`mix` / `mix_isp` — the latest MIX order); without
  a type, one latest order for the whole response, so the other sections come back empty. The
  latest order is the last one bought — a renewal does not count. It is ignored when `orderId`
  is set and has no effect on `resident` and `scraper`.
- `orderId` takes any order identifier the API returns: `order_id` (from `proxyList()` or
  `orderList()`), the numeric `id` of an `orderList()` row (a renewal row selects the order it
  renews), or the order number — the current `order_number`, `base_order_number`, or an earlier
  number of a renewed order with an older `_e_<hash>` suffix. An unknown order or one of another
  account returns empty lists.

### Replacing IPs

```js
await api.proxyReplace(['IP_ID'], 'NOT_WORK');
await api.proxyReplace(['IP_ID'], 'CUSTOM', 'the target site blocks this subnet');
```

The `type` parameter of `proxy/replace` is the **replacement reason**, not a proxy type:
`NOT_WORK`, `INCORRECT_LOCATION`, `CANT_CHANGE_NETWORK`, `LOW_SPEED`, `CUSTOM`. Passing a
proxy type such as `ipv4` there is rejected by the server (`Set coorect type: …`, code 0);
the SDK checks the enum locally and also enforces the server rule that `CUSTOM` requires a
non-empty `comment` (otherwise: `Set comment`, code 503). The enum is exported as
`PROXY_REPLACE_TYPES`. The server turns the reason into the ticket text
(`Does not work`, `Incorrect location`, `I want to change the network`, `Low speed`, or your
own text for `CUSTOM`).

### Exports are files, not JSON

`proxy/download/*`, `resident/geo` and `resident/geo/isp` answer with a file attachment
instead of the `{status, data, errors}` envelope. Use `responseType: 'arraybuffer'` (already
set for the geo helpers) and treat the result as bytes; text exports come back as strings.

```js
await api.proxyDownload('ipv4', 'txt', 'https');
await api.proxyDownload('subresident', 'txt', null, null, { package_key: 'PACKAGE_KEY' });
```

`package_key` works **only** on `proxy/download/subresident`. The literal
`/proxy/download/resident` route knows only `listId` / `id` / `ext` / `maxLine` and silently
ignores `package_key` — you would get the parent package's export back. The SDK throws locally
on that combination instead.

## Resident and subuser lists

`residentListAdd()` accepts the positional form or the full object with
`title`, `whitelist`, `geo`, `export`, and `rotation`.

```js
await api.residentSubUserCreate({ traffic_limit: '1073741824', rotation: 60 });
await api.residentSubUserUpdate({
  package_key: 'PACKAGE_KEY', traffic_limit: '2147483648',
  expired_at: '2026-12-31', is_active: true
});
await api.residentSubUserListAdd('PACKAGE_KEY', {
  title: 'US list', whitelist: '127.0.0.1',
  geo: { country: 'US', region: 'Washington' },
  export: { ports: 1000, ext: 'txt' }, rotation: 60
});
```

`traffic_limit` (bytes, `> 0`) is required when creating a subpackage, and `package_key` is
required for a subuser list. `geo` is **optional** for both `resident/list/add` and
`residentsubuser/list/add` — geo validation is skipped entirely when no geo field is set. Its
parts are hierarchical though: `region` needs `country`, `city` needs `region`, `isp` needs
`city`.

`resident/lists` returns `data` as a **flat array** of lists (there is no `items` wrapper),
and their ids are numeric.

The `rotation` of a resident list is a **different unit** from the mobile `rotationId`: here it
is **seconds** (`-1` sticky, `0` per request, `1`–`3600`), while the mobile order argument is
minutes.

`residentTrafficDetails()` expects the package key as **`packageKey`** (alias `key`) — not
`package_key`; without it the server answers `key is required`. Other filters: `login`,
`date_start`, `date_end`. `residentConsumption()` takes `login`, `date_start`, `date_end`
and resolves the package itself.

Subpackage responses (`residentSubUserCreate`, `residentSubUserUpdate`,
`residentSubUserPackages`) return `expired_at` as a **PHP date object**
`{ date, timezone_type, timezone }`, not a string.

`residentGeo()` returns the geo tree (countries → regions → cities → ISPs) as the JSON file
`geo.json`; `residentGeoIsp()` returns `isp.json`. Both are plain JSON attachments — **not**
zip archives. Parse the bytes yourself:

```js
const geo = JSON.parse(Buffer.from(await api.residentGeo()).toString('utf8'));
```

## v1 migration notes

- IDs in v2 are strings; old numeric v1 IDs do not resolve. Resident list ids stay numeric,
  and the mobile `rotationId` stays a number of minutes.
- `authActive(id, "Y")` became `authChange(id, true)`.
- `ping()` and `proxyCheck()` have no v2 equivalent.
- `residentListDelete()` sends the ID in the request body.
- Delete endpoints return their payload as a string (`"delete"`, or JSON such as
  `{"status":"not-found"}` inside a successful envelope). The SDK normalises it to an object,
  so check the `status` field — a failed delete is not otherwise distinguishable from a
  successful one.
- `balanceAdd()` uses its explicit `paymentId`, then falls back to `setPaymentId()`;
  `paymentCode` is not resolved here.

## Keeping up with the server

Changes made after the 2.0 release, in the order the server shipped them:

- **Behaviour change: requests are now paced by default** (see
  [Rate limits and the request queue](#rate-limits-and-the-request-queue)). A client keeps its key
  under 1000 request starts per 60 seconds, sends write and money requests one at a time — 1 s
  apart, money requests 2 s apart — and retries an HTTP 429 up to 3 times after `Retry-After`, so
  a call can resolve later than its round trip alone would take. Nothing else is retried: code 57
  and the access-denied triple reach you as before. `rateLimit: { enabled: false }` restores the
  previous behaviour exactly.
- **`X-Fingerprint` is optional for API-key orders** — the server no longer requires it for
  residential and scraper orders placed with an API key, so the SDK dropped its local check: a
  missing value is simply not sent instead of failing the call. The header still goes out
  whenever you provide a value (constructor, `setFingerprint()`, per call) — see
  [Sending a fingerprint](#sending-a-fingerprint).
- **Renewal selection depends on the type, and two request fields are gone** (breaking) — see
  [Renewing proxies](#renewing-proxies). `prolong/*` and `autoprolong/*` take `ids` (proxy `id`
  values) or `ips` (addresses) for `ipv4`, `isp` and `mobile`, as before, and `orderIds`
  (`order_id` values) instead of `ids` / `ips` for `ipv6`, `mix` and `mix_isp`, which are renewed
  only as whole orders. A field of the wrong kind is rejected with code 0 and an error naming the
  right one, e.g. `[ids] is not applicable for ipv6: prolong by [orderIds]` or
  `[orderIds] is not applicable for ipv4: prolong by [ids]`, and `resident` takes no selection
  at all. `orderSeparatorIds` and `orderSeparatorId` were removed: the server no longer reads
  them, and the SDK throws an `ApiError` naming the replacement (`orderIds`) if you still pass
  them. `ipv6` is no longer renewed by `host:port` — pass its `order_id`. The SDK routes the
  positional selection by type for you and throws locally, before any request, on two more cases:
  proxy ids mixed with addresses for `ipv4` / `isp` / `mobile` (the server would renew by `ids`
  and drop the addresses), and any selection for `resident` (it applies to the whole package).
  The helpers `prepareProlong()` and `prepareAutoProlong()` now take the type as their first
  argument. In the responses, `prolong/make` adds `orderIds` (every renewed order; `orderId`
  stays and is `orderIds[0]`, `listBaseOrderNumbers` has one number per renewed order or mix
  package), and `autoprolong/enable|disable` adds `orderIds` — the orders of the proxies listed
  in `ids`.
- **`order/list` is new** — `orderList()`, see [Listing orders](#listing-orders). Its query
  filters and response fields use snake_case names such as `start_date` and `is_extend`, and its
  `data` is a `metadata` + `items` pair rather than a flat list.
- **`resident/autorenew/{enable,disable,calculate}` were removed** and replaced by
  `autoprolong/{calc,enable,disable}/{type}` — see [Automatic renewal](#automatic-renewal).
  `type: 'resident'` is the residential branch of the same three endpoints.
- **`order/make` gained `X-Fingerprint`**, and the SDK can send it. At the time the server
  required it for residential and scraper orders and the SDK mirrored that with a local check;
  both requirements are gone now (see the first entry).
- **`dailyCountCap` / `monthlyAmountCap` were removed** from `balance/autotopup/set` (2026-08-18).
  The server ignores them, so the SDK now rejects them rather than letting the call look
  successful while changing nothing. Error codes 54 and 55 are gone with them.
- **`*Code` no longer overrides a paired `*Id`** for `mixId`, `operatorId`, `rotationId` and
  `tarifId`. The server gives the *id* priority on those four, and the SDK was inverting it —
  a caller who filled both halves silently got the wrong package, operator, rotation or tariff.
  An empty-string `*Code` no longer wipes a valid `*Id` either.

## Development

```sh
npm test   # offline self-check of the local gates and the request queue (no network calls, fake time)
```
