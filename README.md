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
default. The API key goes into the URL path, not a header.

### Paying for orders

Every order and renewal needs a payment system. Take one from `balancePaymentsList()` and set it
once:

```js
const payments = await api.balancePaymentsList();   // [{ id: '69e7…', name: 'PayPal' }, …]
api.setPaymentId(payments[0].id);
```

This is the one place where an id is unavoidable: several payment systems share the same internal
code (a single `cryptomus` covers "USDT (TRC-20)", "All cryptocurrencies" and more), so the code
cannot tell them apart. Everywhere else you use human-readable codes.

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
empty, the server retries the same value as a code
(`ClientApiService.normalizeOrderReferenceCodes`).

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
the payment-system code and against `PaymentSystemTypes` names.

The explicit `*Code` fields (`countryCode`, `periodCode`, `paymentCode`, `mixCode`,
`operatorCode`, `tarifCode`) still work and are what `orderCalcMixByCode()` /
`setPaymentCode()` use. But reach for the options object only for fields the positional
signature does not cover — `uptime` on ipv4/isp — not merely to carry a code. Everything else already has a slot: `protocol` in the ipv6 helpers,
`mobileServiceType` and `rotationId` in the mobile ones.

### `rotationId` is minutes, not a code

`rotationId` is the only reference field with **no** code fallback, and it is not an id either —
it is the rotation interval in **minutes**, as an integer: `0` = *By Link*, `5`, `10`, `60`…
`rotationCode` exists in the request DTO, but the server only checks that it is an integer and
copies it into `rotationId`; nothing is looked up. A value such as `'5m'` or `'10m'` is therefore
always rejected with `Set existed [rotationCode] from reference`. Pass the number
(`5`, `10`, `0`) into `rotationId`, and skip `rotationCode` — it buys nothing.

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
| payment system | `balancePaymentsList()`: `id`, `name` | `id` — the one unavoidable id, see [Paying for orders](#paying-for-orders) |

ObjectIds are still accepted everywhere if you happen to have them; the reference simply no longer
publishes them.

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
happened. There is **no HTTP 429** — a rate-limited request is a 200 with this triple.

Local (pre-flight) validation failures are thrown as `ApiError` too — every error the SDK
raises is an `ApiError`, so a single `catch (e) { if (e instanceof ApiError) … }` covers both
sides. Two responses bypass the envelope entirely: file downloads (see below) and an invalid
`ext`, which the server rejects with a bare plain-text HTTP 400 — the SDK validates `ext`
locally to avoid it (max 250 chars, no CR, LF, `/` or `\`).

## Orders

Positional calls take an ObjectId **or** a code in the same argument (see above), so the
ordinary call is positional. The object form exists for payloads that do not fit the
positional signature.

```js
api.setPaymentId('PAYMENT_SYSTEM_OBJECT_ID'); // see “Paying for orders” above

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

`mobileServiceType` is required by the API and defaults to legacy-compatible
`dedicated`. `uptime` is available for supported IPv4/ISP combinations.
`setGenerateAuth('Y')` affects only `order/make`.

`customTargetName` — what you use the proxies for. Required for `ipv4`, `ipv6` and `isp`;
without it the server answers `Incorrect goal`, code 14. For `mix` / `mix_isp` it is only needed
when the server cannot tell which package you mean, so naming the package removes the need for it.

## Renewing proxies

Renew by the addresses themselves — the same strings `proxyList()` gives you. No ids to look up:

```js
const { items } = await api.proxyList('ipv4');
const ips = items.map(item => item.ip);          // ['1.2.3.4', '5.6.7.8']

await api.prolongCalc('ipv4', ips, '1m');        // price first
await api.prolongMake('ipv4', ips, '1m');        // deducts money
```

`prolongCalc()` shows the price; `prolongMake()` charges the balance. If the balance is short,
`prolongMake()` throws an `ApiError` with the server's warning — it never reports a renewal that
did not happen.

The address format follows the proxy type, exactly as `proxyList()` returns it:

| type | address |
|---|---|
| `ipv4`, `isp`, `mix` | `1.2.3.4` |
| `ipv6` | `host:port` |
| `mobile` | `ip:portHttp:portSocks` |

ObjectId strings work too, and a mixed array works — each value is routed by its shape. The period
takes a code positionally (`'1m'`), same fallback as `order/*`, and the fourth argument is a coupon:

```js
await api.prolongMake('ipv4', ips, '1m', 'SALE10');
```

<details>
<summary>Renewing part of a MIX order</summary>

A MIX order can be split into parts that renew independently. Those parts are addressed by id,
and the object form of the call is how you pass them:

```js
await api.prolongMake('mix', {
  orderSeparatorIds: ['SEPARATOR_ID'],
  periodId: '1m', coupon: 'SALE10'
});
```

The object form also exposes the complete v2 payload: `ips`, `ids`, `orderSeparatorId`,
`orderSeparatorIds`, `periodId`/`periodCode`, `paymentId`/`paymentCode`, `coupon`.

</details>

## Balance

```js
await api.balance();               // number
await api.balancePaymentsList();   // payment systems available for a top-up
await api.balanceAdd(25, 'PAYMENT_SYSTEM_OBJECT_ID');
```

`balance/add` accepts **only `paymentId`** — an ObjectId taken from
`balancePaymentsList()`. It does not resolve stable payment codes: the request DTO knows just
`summ` and `paymentId`, and the code-resolution step used by `order/*` and `prolong/*` is not
invoked there. `setPaymentCode()` therefore has no effect on `balanceAdd()`, and the SDK
throws a local `ApiError` explaining this instead of sending `paymentId: null`.

`balance` cannot be topped up with `balance` — that payment system is excluded from the list
and rejected by the endpoint.

### Auto top-up

```js
const state = await api.balanceAutoTopupGet();
// { configured, enabled, state, threshold, amount, subscriptionId,
//   paymentMethod: { id, status, paymentMethod, brand, last4, exp } | null,
//   dailyCountCap, monthlyAmountCap, failCount, lastAttemptAt,
//   lastEvent: { status, amount, at, reason } | null }

// Turn it on:
await api.balanceAutoTopupSet({ enabled: true, threshold: 10, amount: 25 });

// Partial update — only the threshold changes, everything else stays as saved:
await api.balanceAutoTopupSet({ threshold: 20 });
```

`state` is one of `NO_PAYMENT_METHOD`, `DISABLED`, `ACTIVE`, `PAYMENT_INVALID`,
`PAUSED_FAILURES`. `lastEvent.status` is one of `TRIGGERED`, `SUCCEEDED`, `FAILED`,
`SKIPPED_CAP`, `SETTINGS_SAVED`, `PAUSED`. `dailyCountCap` / `monthlyAmountCap` in the
response are the **effective** limits — either the values you set or the server defaults
(5 charges per day, 500 per 30 days).

`balance/autotopup/set` is a **partial update**: any field you omit keeps its stored value,
and the server validates the *merged* result. The SDK sends only the fields you actually
passed — `undefined` and `null` are dropped rather than sent as `null` — and rejects a call
with no recognised field at all. Accepted fields: `enabled`, `threshold`, `amount`,
`subscriptionId`, `dailyCountCap`, `monthlyAmountCap`. On success the response is the state
**after** saving, so no follow-up `balanceAutoTopupGet()` is needed.

Pause and the failed-charge counter are reset only on an explicit `enabled: true` — editing a
threshold on a paused configuration does not silently resume it.

Validation boundaries: `threshold >= 1`, `amount >= 5` and `amount >= threshold`,
`dailyCountCap >= 1`, `monthlyAmountCap >= amount`. Error codes:

| code | meaning |
|---|---|
| 49 | auto top-up is not available on this environment |
| 50 | threshold below the minimum (`customData.minThreshold`) |
| 51 | amount below the minimum (`customData.minAmount`) |
| 52 | amount below the threshold — it would trigger again immediately |
| 53 | no saved payment method |
| 54 | daily count cap below the minimum (`customData.minDailyCountCap`) |
| 55 | monthly amount cap below a single top-up amount |
| 56 | the saved card has expired |

## Proxies

```js
await api.proxyList('ipv4', { orderId: 'ORDER_OBJECT_ID', latest: 'Y' });
await api.proxyCommentSet(['IP_ID_1', 'IP_ID_2'], 'my comment');
```

`orderId` is an ObjectId string. Filters: `latest`, `orderId`, `country`, `ends`, and
`page` / `per_page` for the typed route.

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
`/proxy/download/resident` route is served by the resident controller, which knows only
`listId` / `id` / `ext` / `maxLine` and silently ignores `package_key` — you would get the
parent package's export back. The SDK throws locally on that combination instead.

## Resident and subuser lists

`residentListAdd()` accepts the legacy positional form or the full object with
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

## Development

```sh
npm test   # offline self-check of the local gates (no network calls)
```
