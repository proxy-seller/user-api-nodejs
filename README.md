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
  // Optional root before the API key (useful for local/dev environments):
  baseUrl: 'https://proxy-seller.com/personal/api/v2/',
  timeout: 30_000,
  headers: { 'X-Request-Source': 'my-app' }
});

try {
  console.log(await api.balance());
} catch (error) {
  if (error instanceof ApiError) {
    console.error(error.code, error.message, error.errors, error.customData);
  }
}
```

The API key goes into the URL path, not a header. The constructor also accepts Axios
options. Method-level options are merged safely; the SDK keeps its own URL, method, base URL
and headers authoritative.

## IDs in v2 are strings

Every id in v2 is a MongoDB ObjectId **string** (`"665f1c…"`), not a number. Never parse an
id into `Number`/`parseInt` — that silently produces `NaN` or a truncated value. This applies
to `orderId`, order/prolong ids, payment system ids, auth ids, IP address ids, country, period,
mix, operator, rotation and tariff ids. Numeric v1 ids do not resolve in v2 at all.

The one exception: **resident list ids are numeric** (`Long`) — `residentList()`,
`residentListRename()`, `residentListRotation()`, `residentListDelete()`, the `listId` /
`id` parameter of the resident export. They are not ObjectIds.

Where an id has a stable counterpart, the SDK accepts a code instead (`countryCode`,
`periodCode`, `paymentCode`, `mixCode`, `operatorCode`, `rotationCode`, `tarifCode`) —
see `referenceList()`. Codes are resolved server side for `order/*` and `prolong/*` only.

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

Legacy positional ID calls remain supported. New code-first calls use one options
object. Stable codes come from `referenceList()`.

```js
api.setPaymentCode('balance'); // or setPaymentId('...')

await api.orderCalcIpv4({
  countryCode: 'USA', periodCode: '1m', quantity: 2, uptime: true
});

await api.orderMakeMobile({
  countryCode: 'USA', periodCode: '1m', quantity: 1,
  mobileServiceType: 'dedicated', operatorCode: 'operator-code',
  rotationCode: '10m'
});

// MIX uses a package identifier, not countryId:
await api.orderCalcMix('MIX_ID', 'PERIOD_ID', 1);
await api.orderCalcMixByCode('mix-us-eu', '1m', 1);
```

`mobileServiceType` is required by the API and defaults to legacy-compatible
`dedicated`. `uptime` is available for supported IPv4/ISP combinations.
`setGenerateAuth('Y')` affects only `order/make`.

`customTargetName` is required for `ipv4`, `ipv6` and `isp` (the server answers
`Incorrect goal`, code 14). For `mix` / `mix_isp` it is required only when the MIX package
cannot be resolved: passing `mixId`, `mixCode`, `countryId: "packageId:quantity"`, or
`countryId` together with `quantity > 0` is enough. The SDK checks this locally, mirroring
`ClientApiService.parseMixSelection`.

## Prolongation

The object form exposes the complete v2 payload: `ids`, `orderSeparatorId`,
`orderSeparatorIds`, `periodId`/`periodCode`, `paymentId`/`paymentCode`, and `coupon`.

```js
await api.prolongMake('mix', {
  orderSeparatorIds: ['SEPARATOR_ID'],
  periodCode: '1m', paymentCode: 'balance', coupon: 'SALE10'
});
```

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

- IDs in v2 are strings; old numeric v1 IDs do not resolve. Resident list ids stay numeric.
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
