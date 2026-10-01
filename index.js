import axios from 'axios';

/**
 * Единственный тип ошибки SDK: и локальные проверки, и ошибки сервера.
 *
 * Ошибки доступа (битый ключ / IP не в allowlist / превышен лимит запросов) приходят
 * с HTTP 200 и ФИКСИРОВАННОЙ тройкой в errors[] — "Error api key", "IP not allowed <ip>",
 * "Request limit reached", все с code=503. Понять, что именно произошло, по errors[0] нельзя,
 * поэтому весь массив доступен в `error.errors` (и полный конверт — в `error.body`).
 */
export class ApiError extends Error {
    constructor(message, { code = null, customData = null, httpStatus = null, body = null, errors = null } = {}) {
        super(message || 'Client API request failed');
        this.name = 'ApiError';
        this.code = code;
        this.customData = customData;
        this.httpStatus = httpStatus;
        this.body = body;
        /** Весь массив errors из конверта, а не только первый элемент. */
        this.errors = Array.isArray(errors) ? errors : [];
    }
}

/**
 * proxy/replace: причина замены (НЕ тип прокси). Ровно этот набор причин принимает сервер;
 * регистр ему не важен — значение приводится к upper case.
 */
export const PROXY_REPLACE_TYPES = Object.freeze([
    'NOT_WORK', 'INCORRECT_LOCATION', 'CANT_CHANGE_NETWORK', 'LOW_SPEED', 'CUSTOM'
]);

/** Поля тела balance/autotopup/set. Всё опционально — это partial update. */
const AUTO_TOPUP_SET_FIELDS = Object.freeze([
    'enabled', 'threshold', 'amount', 'subscriptionId'
]);

/**
 * Убраны из контракта balance/autotopup/set 18.08.2026: сервер их больше не читает,
 * коды ошибок 54/55 удалены и не переиспользуются, ключа minDailyCountCap в customData нет.
 * Раньше SDK их отправлял — вызов проходил локальный гейт, отвечал success и не делал НИЧЕГО.
 * Отбиваем локально, чтобы тихий no-op стал видимым.
 */
const AUTO_TOPUP_REMOVED_FIELDS = Object.freeze(['dailyCountCap', 'monthlyAmountCap']);

/**
 * Пары *Id / *Code с указанием СТАРШЕЙ половины — дословно так их разбирает сервер.
 * payment/country/period резолвятся от кода, а operator/rotation/mix/tarif — от
 * идентификатора: там код применяется, только когда парный id пуст.
 *
 * Раньше SDK удалял *Id ВСЯКИЙ РАЗ, когда задан *Code, и для нижних четырёх пар это
 * инвертировало контракт: клиент, заполнивший обе половины, молча получал не тот
 * пакет/оператора/ротацию/тариф, который выбрал бы сервер.
 */
const ORDER_REFERENCE_PAIRS = Object.freeze([
    ['paymentId', 'paymentCode', 'code'],
    ['countryId', 'countryCode', 'code'],
    ['periodId', 'periodCode', 'code'],
    ['operatorId', 'operatorCode', 'id'],
    ['rotationId', 'rotationCode', 'id'],
    ['mixId', 'mixCode', 'id'],
    ['tarifId', 'tarifCode', 'id']
]);

/**
 * Пары *Id / *Code тела prolong/* и autoprolong/*: других пар сервер в этих телах не разбирает,
 * и обе резолвятся от кода.
 */
const PROLONG_REFERENCE_PAIRS = Object.freeze([
    ['periodId', 'periodCode', 'code'],
    ['paymentId', 'paymentCode', 'code']
]);

/**
 * prolong/* и autoprolong/*: типы, которые продаются и продлеваются только ЦЕЛЫМИ заказами.
 * Выбор для них — orderIds (`order_id` из proxy/list или order/list). Остальные типы (ipv4,
 * isp, mobile) продлеваются по отдельным прокси: ids (`id` из proxy/list) либо ips (адреса).
 */
const ORDER_PROLONG_TYPES = Object.freeze(['ipv6', 'mix', 'mix_isp']);

/**
 * Написания резидентской ветки autoprolong/*. Выбора у неё нет: автопродление применяется ко
 * всему пакету, поэтому любой непустой выбор для неё — локальная ApiError, а не тихий пропуск:
 * disable, адресованный паре адресов, выключил бы автопродление всего пакета.
 */
const RESIDENT_PROLONG_TYPES = Object.freeze(['resident', 'residential']);

/** Поля выбора prolong/* и autoprolong/*: пустыми в тело не уходят. */
const PROLONG_SELECTION_FIELDS = Object.freeze(['ids', 'ips', 'orderIds']);

/**
 * Поля тела prolong/* (и основы тела autoprolong/*), которые SDK берёт из options или из
 * объектной формы вызова. orderSeparatorIds и orderSeparatorId убраны из контракта, и сервер
 * их больше не читает: переданные — локальная ApiError с именем замены (orderIds), см.
 * _assertNoRemovedProlongFields().
 */
const PROLONG_BODY_FIELDS = Object.freeze([
    ...PROLONG_SELECTION_FIELDS, 'coupon', 'periodId', 'periodCode', 'paymentId', 'paymentCode'
]);

/** Имя заголовка фингерпринта — единственное место, где оно записано. */
const FINGERPRINT_HEADER = 'X-Fingerprint';

/**
 * Snake-алиасы тела autoprolong/*, которые сервер принимает наравне с camelCase.
 * Приводим их к каноническому написанию: camelCase на сервере старше, и отправлять оба
 * написания сразу незачем.
 */
const AUTO_PROLONG_ALIASES = Object.freeze({
    payment_id: 'paymentId',
    subscription_id: 'subscriptionId',
    tarif_id: 'tarifId',
    tariffId: 'tarifId'
});

/////////////////////////////// API-ключ вне ошибок ///////////////////////////////

/** Чем SDK заменяет API-ключ в ошибках и в представлении клиента. */
const SECRET_MASK = '***';

/**
 * Ключ короче этого не маскируется: сервер выдаёт ключи от 12 символов, а замена одной-трёх букв
 * изуродовала бы текст любой ошибки ("Error api key" -> "Error api ***ey") и ничего бы не скрыла.
 */
const SECRET_MIN_LENGTH = 4;

/**
 * Шаблоны поиска ключа, по клиенту. Ключ стоит в ПУТИ запроса, и сервер или прокси перед ним может
 * вернуть этот путь в теле ответа — тело ошибки Spring {timestamp, status, error, path}, HTML-страница
 * 404. Шаблон хранится вне экземпляра, чтобы его не напечатали ни console.log, ни JSON.stringify.
 */
const CLIENT_SECRETS = new WeakMap();

/** util.inspect.custom без импорта node:util: символ берётся из общего реестра. */
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

/** Сколько символов тела ответа без конверта остаётся в ApiError (см. _bodySnippet()). */
const BODY_SNIPPET_LENGTH = 500;

/**
 * Шаблон, который находит ключ в тексте: сам ключ и его URL-кодированную форму (в путь он уходит
 * кодированным), без учёта регистра — фронтовый 404 стейджа отдаёт путь в нижнем регистре.
 * @param {*} key
 * @return {RegExp|null} null — ключ короче SECRET_MIN_LENGTH и не маскируется
 */
function secretPattern(key) {
    const raw = String(key);
    if (raw.length < SECRET_MIN_LENGTH) {
        return null;
    }
    const forms = [...new Set([raw, encodeURIComponent(raw)])]
        // Длинная форма первой: если одна форма — начало другой (ключ с '%'), короткая оставила бы
        // хвост длинной.
        .sort((a, b) => b.length - a.length)
        .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(forms.join('|'), 'gi');
}

/**
 * Копия значения, в которой ключ заменён на SECRET_MASK во всех строках — и в значениях, и в именах
 * полей. Простые объекты и массивы копируются вглубь; байты (ArrayBuffer, Buffer, Uint8Array)
 * маскируются, только если ключ в них есть, и тип при этом сохраняется; прочие объекты (потоки, даты,
 * экземпляры классов) возвращаются как есть.
 * @param {*} value
 * @param {RegExp|null} pattern см. secretPattern()
 * @param {Map} seen уже скопированные объекты — на случай циклов
 * @return {*}
 */
function maskSecret(value, pattern, seen = new Map()) {
    if (!pattern || value === null || value === undefined) {
        return value;
    }
    if (typeof value === 'string') {
        return value.replace(pattern, SECRET_MASK);
    }
    if (typeof value !== 'object') {
        return value;
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return maskBytes(value, pattern);
    }
    if (seen.has(value)) {
        return seen.get(value);
    }
    if (Array.isArray(value)) {
        const copy = [];
        seen.set(value, copy);
        for (const item of value) {
            copy.push(maskSecret(item, pattern, seen));
        }
        return copy;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
        return value;
    }
    const copy = {};
    seen.set(value, copy);
    for (const [name, item] of Object.entries(value)) {
        // defineProperty, а не присваивание: поле "__proto__" из JSON иначе подменило бы прототип копии.
        Object.defineProperty(copy, name.replace(pattern, SECRET_MASK), {
            value: maskSecret(item, pattern, seen), enumerable: true, writable: true, configurable: true
        });
    }
    return copy;
}

/**
 * maskSecret() для байтов: без ключа внутри — то же значение, с ключом — маскированная копия того же
 * типа (Buffer остаётся Buffer, ArrayBuffer — ArrayBuffer).
 * @param {ArrayBuffer|ArrayBufferView} value
 * @param {RegExp} pattern
 * @return {ArrayBuffer|ArrayBufferView}
 */
function maskBytes(value, pattern) {
    const text = new TextDecoder().decode(asBytes(value));
    if (text.search(pattern) === -1) {
        return value;
    }
    const masked = new TextEncoder().encode(text.replace(pattern, SECRET_MASK));
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
        return Buffer.from(masked.buffer, masked.byteOffset, masked.byteLength);
    }
    return value instanceof ArrayBuffer ? masked.buffer : masked;
}

/**
 * @param {ArrayBuffer|ArrayBufferView} value
 * @return {Uint8Array} те же байты, без копирования
 */
function asBytes(value) {
    return value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/////////////////////////////// Таймауты ///////////////////////////////

/** Общий таймаут запроса по умолчанию, мс. */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Таймаут денежных запросов (категория money: order/make, prolong/make/{type}, balance/add) по
 * умолчанию, мс. Сервер собирает заказ синхронно — большой MIX идёт дольше 30 с, — и общий таймаут
 * обрывал бы уже оплаченный заказ: клиент видел бы ошибку, а повтор купил бы то же самое второй раз.
 */
const DEFAULT_MONEY_TIMEOUT_MS = 120000;

/** Самый длинный таймаут, который выдерживают таймеры Node (2^31 - 1 мс). */
const TIMEOUT_MAX_MS = 2147483647;

/**
 * Таймаут денежных запросов из config конструктора.
 *
 * moneyTimeout не задан (undefined / null) — 120 с. Если явно задан общий timeout, денежные запросы
 * ждут не меньше его: max(timeout, moneyTimeout). 0, как у axios, — без таймаута, то есть «дольше»
 * любого числа.
 * @param {*} moneyTimeout config.moneyTimeout
 * @param {*} timeout config.timeout как передан: undefined — не задан
 * @return {number} мс; 0 — без таймаута
 * @throws ApiError при неверном moneyTimeout
 */
function resolveMoneyTimeout(moneyTimeout, timeout) {
    const money = moneyTimeout === undefined || moneyTimeout === null ? DEFAULT_MONEY_TIMEOUT_MS : moneyTimeout;
    if (typeof money !== 'number' || !Number.isFinite(money) || money < 0 || money > TIMEOUT_MAX_MS) {
        throw new ApiError(
            `moneyTimeout must be a number of milliseconds from 0 to ${TIMEOUT_MAX_MS} (0 = no timeout)`
        );
    }
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0) {
        // Общий таймаут не задан — или задан так, что его разбирает axios: денежным хватает своего.
        return money;
    }
    if (money === 0 || timeout === 0) {
        return 0;
    }
    return Math.max(money, timeout);
}

/////////////////////////////// Очередь запросов ///////////////////////////////

/**
 * Значения очереди запросов по умолчанию (см. RequestQueue). Ключи — ровно опции rateLimit
 * конструктора; смысл и значения те же, что в остальных SDK.
 */
const RATE_LIMIT_DEFAULTS = Object.freeze({
    enabled: true,
    requestsPerMinute: 1000,
    writeIntervalMs: 1000,
    moneyIntervalMs: 2000,
    maxRetries: 3
});

/**
 * Подменяемые часы и таймер очереди — для тестов с фальшивым временем:
 * now() — миллисекунды по монотонным часам, sleep(ms) — промис, который резолвится через ms.
 */
const RATE_LIMIT_HOOKS = Object.freeze(['now', 'sleep']);

/** Скользящее окно глобального лимита: не больше requestsPerMinute стартов за любые 60 с. */
const RATE_LIMIT_WINDOW_MS = 60000;

/** Пауза перед повтором 429, когда Retry-After нет или его не разобрать. */
const RETRY_AFTER_FALLBACK_MS = 2000;

/** Потолок паузы перед повтором 429, что бы ни прислал Retry-After. */
const RETRY_AFTER_CAP_MS = 60000;

/**
 * Категории запросов для очереди — по ПУТИ, не по HTTP-методу: calc-эндпоинты шлются POST, но
 * ничего не меняют. `{type}` совпадает с любым одним сегментом пути; пути, которого здесь нет, —
 * read. Это единственное место, где записана классификация: request() берёт категорию только
 * отсюда, через _requestCategory(), и по ней же выбирает таймаут (money — moneyTimeout) и
 * строгость разбора ответа (money и write — успех только по status="success").
 *   money — деньги: заказ, продление, пополнение баланса;
 *   write — меняют состояние аккаунта;
 *   read  — всё остальное: списки, get, calc, справочники, выгрузки, статистика.
 */
const REQUEST_CATEGORIES = Object.freeze({
    'order/make': 'money',
    'prolong/make/{type}': 'money',
    'balance/add': 'money',

    'autoprolong/enable/{type}': 'write',
    'autoprolong/disable/{type}': 'write',
    'auth/add': 'write',
    'auth/add/ip': 'write',
    'auth/change': 'write',
    'auth/delete': 'write',
    'proxy/replace': 'write',
    'proxy/comment/set': 'write',
    'balance/autotopup/set': 'write',
    // resident/list — POST-алиас resident/list/add. Не путать с resident/lists: это список, read.
    'resident/list': 'write',
    'resident/list/add': 'write',
    'resident/list/delete': 'write',
    'resident/list/rename': 'write',
    'resident/list/rotation': 'write',
    'resident/list/tools': 'write',
    'residentsubuser/create': 'write',
    'residentsubuser/update': 'write',
    'residentsubuser/delete': 'write',
    'residentsubuser/list/add': 'write',
    'residentsubuser/list/delete': 'write',
    'residentsubuser/list/rename': 'write',
    'residentsubuser/list/rotation': 'write',
    'residentsubuser/list/tools': 'write'
});

/** REQUEST_CATEGORIES, заранее разрезанные на сегменты, — чтобы не резать шаблоны на каждый запрос. */
const REQUEST_CATEGORY_PATTERNS = Object.freeze(Object.entries(REQUEST_CATEGORIES).map(
    ([path, category]) => Object.freeze({ segments: Object.freeze(path.split('/')), category: category })
));

const noop = () => {};

/** write и money идут через полосу записи; read — мимо неё. */
function inWriteLane(category) {
    return category === 'write' || category === 'money';
}

/**
 * Значение заголовка ответа без учёта регистра имени: у настоящего ответа axios это AxiosHeaders
 * (get() без учёта регистра), у подменённого транспорта может быть обычный объект. Из нескольких
 * значений берётся первое.
 * @param {*} headers
 * @param {string} name имя в нижнем регистре
 * @return {*}
 */
function responseHeader(headers, name) {
    if (!headers || typeof headers !== 'object') {
        return null;
    }
    let value = typeof headers.get === 'function' ? headers.get(name) : undefined;
    if (value == null) {
        const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
        value = key === undefined ? null : headers[key];
    }
    return Array.isArray(value) ? value[0] : value;
}

/**
 * Пауза перед повтором 429 по Retry-After: целые секунды либо HTTP-дата. Нет заголовка или его
 * не разобрать — 2 с; дольше 60 с не ждём. Дату сравниваем с настенными часами (Date.now()), а не
 * с часами очереди: те монотонные, и с датой их не сравнить.
 * @param {*} headers заголовки ответа 429
 * @return {number} миллисекунды
 */
function retryAfterMs(headers) {
    const raw = responseHeader(headers, 'retry-after');
    const text = raw == null ? '' : String(raw).trim();
    let wait = RETRY_AFTER_FALLBACK_MS;
    if (/^\d+$/.test(text)) {
        wait = Number(text) * 1000;
    } else if (/[a-z]/i.test(text)) {
        const at = Date.parse(text);
        if (Number.isFinite(at)) {
            wait = Math.max(0, at - Date.now());
        }
    }
    return Math.min(wait, RETRY_AFTER_CAP_MS);
}

/**
 * HTTP 429 — ответ лимита на входе, перед API: запрос до API не дошёл, поэтому повтор безопасен
 * даже для money. Сам API за превышение лимита отвечает HTTP 200 с тройкой отказа доступа (code
 * 503) — её очередь не повторяет, см. RequestQueue.
 * @param {*} response
 * @return {boolean}
 */
function isRateLimitedResponse(response) {
    return response != null && Number(response.status) === 429;
}

/**
 * Очередь запросов одного клиента: держит его под лимитами API, не требуя кода от вызывающего.
 *
 *  1. Глобальное окно. Все запросы — read, write и money — делят скользящее окно: не больше
 *     requestsPerMinute стартов за любые 60 с. Это журнал стартов (ждём, пока самому старому из
 *     последних N не исполнится 60 с), а НЕ token bucket: bucket пропускает всплески больше N за
 *     60 с. Старты раздаются строго по очереди вызовов.
 *  2. Полоса записи. write и money идут через ОДНУ полосу на клиент: в полёте не больше одного,
 *     следующий стартует только после того, как предыдущий закончился, и вдобавок не раньше
 *     writeIntervalMs после СТАРТА предыдущего write/money, а money — ещё и не раньше
 *     moneyIntervalMs после старта предыдущего money. read полосу не ждёт — только окно.
 *  3. HTTP 429. Ждём Retry-After (см. retryAfterMs) и повторяем, до maxRetries раз, затем отдаём
 *     ответ 429 обычному разбору request() — выходит обычная ApiError с httpStatus 429. Повтор
 *     write/money держит своё место в полосе (никто не влезает вперёд); каждая попытка — новый
 *     старт в окне и новая точка отсчёта интервалов полосы.
 *  4. Больше ничего не повторяется: ни ошибки в конверте — code 57 "Prolong for this order is
 *     already in progress" (повтор мог бы продлить заказ дважды) и тройка отказа доступа code 503
 *     (её не отличить от неверного ключа или IP), — ни сетевые ошибки, ни другие HTTP-статусы.
 *
 * Ждём только таймерами (sleep), без активного ожидания; вызывающему ожидание видно как более
 * поздний resolve промиса. Состояние живёт в экземпляре клиента: другой экземпляр или другой
 * процесс с тем же ключом о нём не знает и со своими запросами не согласует.
 */
class RequestQueue {
    constructor(settings) {
        const now = settings.now || (() => performance.now());
        const sleep = settings.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.requestsPerMinute = settings.requestsPerMinute;
        this.writeIntervalMs = settings.writeIntervalMs;
        this.moneyIntervalMs = settings.moneyIntervalMs;
        this.maxRetries = settings.maxRetries;
        // Вызываем как обычные функции, а не как методы очереди: переданный снаружи метод не должен
        // получить эту очередь в качестве this.
        this._now = () => now();
        this._sleep = (ms) => sleep(ms);
        /** Старты последних 60 с (по часам очереди), от старых к новым. */
        this._starts = [];
        this._windowTail = Promise.resolve();
        this._laneTail = Promise.resolve();
        this._lastWriteStart = -Infinity;
        this._lastMoneyStart = -Infinity;
    }

    /**
     * Проводит один запрос через очередь.
     * @param {string} category read | write | money — см. REQUEST_CATEGORIES
     * @param {function(): Promise<object>} send одна попытка: ответ транспорта либо его исключение
     * @return {Promise<object>} ответ последней попытки
     */
    run(category, send) {
        if (!inWriteLane(category)) {
            return this._attempts(category, send);
        }
        const turn = this._laneTail.then(() => this._laneTurn(category, send));
        // Хвост полосы никогда не отклоняется: упавший запрос освобождает полосу так же, как удачный.
        this._laneTail = turn.then(noop, noop);
        return turn;
    }

    /** Ход в полосе записи: предыдущий write/money уже закончился, ждём интервалы от его старта. */
    async _laneTurn(category, send) {
        for (;;) {
            const now = this._now();
            let notBefore = this._lastWriteStart + this.writeIntervalMs;
            if (category === 'money') {
                notBefore = Math.max(notBefore, this._lastMoneyStart + this.moneyIntervalMs);
            }
            if (now >= notBefore) {
                break;
            }
            // Таймер может сработать чуть раньше срока — тогда цикл досыпает остаток.
            await this._sleep(notBefore - now);
        }
        return this._attempts(category, send);
    }

    /** Попытки одного запроса: старт в окне, отправка, при 429 — пауза и повтор. */
    async _attempts(category, send) {
        for (let retry = 0; ; retry++) {
            const started = await this._takeWindowSlot();
            if (inWriteLane(category)) {
                this._lastWriteStart = started;
                if (category === 'money') {
                    this._lastMoneyStart = started;
                }
            }
            let response;
            try {
                response = await send();
            } catch (error) {
                // Сетевые и прочие исключения не повторяются. 429 исключением приходит, только если
                // вызывающий переопределил validateStatus в options запроса.
                if (retry >= this.maxRetries || !isRateLimitedResponse(error?.response)) {
                    throw error;
                }
                await this._sleep(retryAfterMs(error.response.headers));
                continue;
            }
            if (retry >= this.maxRetries || !isRateLimitedResponse(response)) {
                return response;
            }
            await this._sleep(retryAfterMs(response.headers));
        }
    }

    /**
     * Место в глобальном окне. Старты раздаются по одному, в порядке запросов (цепочка промисов),
     * чтобы при полном окне ожидающие не толкались за освободившееся место.
     * @return {Promise<number>} время старта по часам очереди
     */
    _takeWindowSlot() {
        const slot = this._windowTail.then(() => this._waitForWindow());
        this._windowTail = slot.then(noop, noop);
        return slot;
    }

    async _waitForWindow() {
        for (;;) {
            const now = this._now();
            while (this._starts.length > 0 && now - this._starts[0] >= RATE_LIMIT_WINDOW_MS) {
                this._starts.shift();
            }
            if (this._starts.length < this.requestsPerMinute) {
                this._starts.push(now);
                return now;
            }
            await this._sleep(this._starts[0] + RATE_LIMIT_WINDOW_MS - now);
        }
    }
}

/**
 * Разбирает config.rateLimit конструктора и собирает очередь.
 * undefined / null / true — всё по умолчанию; false — короткая запись { enabled: false }.
 * Пропущенная (или null) опция берёт значение по умолчанию; неизвестная опция и неверное значение —
 * ApiError: опечатка в имени иначе молча оставила бы значение по умолчанию.
 * @param {*} rateLimit
 * @return {RequestQueue|null} null — очередь выключена, request() шлёт как раньше
 * @throws ApiError
 */
function createRequestQueue(rateLimit) {
    if (rateLimit === false) {
        return null;
    }
    const given = rateLimit === undefined || rateLimit === null || rateLimit === true ? {} : rateLimit;
    const known = [...Object.keys(RATE_LIMIT_DEFAULTS), ...RATE_LIMIT_HOOKS];
    if (typeof given !== 'object' || Array.isArray(given)) {
        throw new ApiError(
            `rateLimit must be an object with any of ${known.join(', ')}, or false to turn the request queue off`
        );
    }
    const unknown = Object.keys(given).filter((key) => !known.includes(key));
    if (unknown.length > 0) {
        throw new ApiError(`Unknown rateLimit option(s): ${unknown.join(', ')}. Known options: ${known.join(', ')}`);
    }
    const settings = {};
    for (const key of known) {
        settings[key] = given[key] === undefined || given[key] === null ? RATE_LIMIT_DEFAULTS[key] : given[key];
    }
    const problems = [];
    if (typeof settings.enabled !== 'boolean') {
        problems.push('enabled must be true or false');
    }
    if (!Number.isInteger(settings.requestsPerMinute) || settings.requestsPerMinute < 1) {
        problems.push('requestsPerMinute must be an integer >= 1');
    }
    for (const key of ['writeIntervalMs', 'moneyIntervalMs']) {
        if (typeof settings[key] !== 'number' || !Number.isFinite(settings[key]) || settings[key] < 0) {
            problems.push(`${key} must be a number of milliseconds >= 0`);
        }
    }
    if (!Number.isInteger(settings.maxRetries) || settings.maxRetries < 0) {
        problems.push('maxRetries must be an integer >= 0');
    }
    for (const key of RATE_LIMIT_HOOKS) {
        if (settings[key] !== undefined && typeof settings[key] !== 'function') {
            problems.push(`${key} must be a function`);
        }
    }
    if (problems.length > 0) {
        throw new ApiError(`Invalid rateLimit: ${problems.join('; ')}`);
    }
    return settings.enabled ? new RequestQueue(settings) : null;
}

class ProxySellerUserApi {
    URL = 'https://proxy-seller.com/personal/api/v2/';
    paymentId = null
    paymentCode = null
    generateAuth = 'N'
    fingerprint = null
    /** Очередь запросов клиента (см. RequestQueue); null — выключена через rateLimit. */
    requestQueue = null

    /**
     * Key placed in https://proxy-seller.com/personal/api/ — уходит в ПУТЬ запроса,
     * не в заголовок.
     *
     * config.fingerprint — значение заголовка X-Fingerprint, см. setFingerprint().
     *
     * config.rateLimit — очередь запросов, включена по умолчанию (см. RequestQueue и раздел
     * README «Rate limits and the request queue»): { enabled, requestsPerMinute, writeIntervalMs,
     * moneyIntervalMs, maxRetries }, по умолчанию { true, 1000, 1000, 2000, 3 }. Пропущенная опция
     * берёт значение по умолчанию, false — то же, что { enabled: false }: запросы уходят сразу и без
     * повторов, как до появления очереди. Для тестов с фальшивым временем — now() (мс, монотонные
     * часы) и sleep(ms) → Promise. В axios rateLimit не передаётся.
     *
     * config.timeout — общий таймаут запроса, мс: 30000 по умолчанию, 0 — без таймаута.
     * config.moneyTimeout — таймаут денежных запросов (order/make, prolong/make/{type}, balance/add),
     * мс: 120000 по умолчанию, 0 — без таймаута. Если общий timeout задан явно, денежные запросы ждут
     * max(timeout, moneyTimeout). Обрыв по таймауту не отменяет запрос на сервере: заказ мог быть
     * создан и оплачен (раздел README «Timeouts and retries on payments»). В axios moneyTimeout не
     * передаётся.
     *
     * Ключ не печатается: console.log(api) и JSON.stringify(api) показывают baseURL с маской вместо
     * ключа (см. toJSON()), а в ошибках SDK ключ заменён на *** (см. _apiError()).
     * @param {*} config
     * @throws ApiError
     */
    constructor(config = {}) {
        if (!config.key) {
            // ApiError, а не Error: единый тип ошибок SDK, чтобы вызывающему хватало
            // одного catch (e instanceof ApiError).
            throw new ApiError('Need key, placed in https://proxy-seller.com/personal/api/');
        }

        const {
            key,
            baseUrl,
            baseURL,
            timeout = DEFAULT_TIMEOUT_MS,
            moneyTimeout,
            headers = {},
            fingerprint = null,
            rateLimit,
            ...axiosConfig
        } = config;
        const apiRoot = String(baseUrl || baseURL || this.URL).replace(/\/+$/, '') + '/';

        this.baseURL = apiRoot + encodeURIComponent(key) + '/';
        CLIENT_SECRETS.set(this, secretPattern(key));
        this.timeout = timeout;
        // config.timeout, а не timeout: max() берётся, только если общий таймаут задан ЯВНО.
        this.moneyTimeout = resolveMoneyTimeout(moneyTimeout, config.timeout);
        this.setFingerprint(fingerprint);
        // Состояние очереди — в экземпляре, то есть на один ключ в одном процессе.
        this.requestQueue = createRequestQueue(rateLimit);
        this.client = axios.create({
            ...axiosConfig,
            baseURL: this.baseURL,
            timeout: timeout,
            headers: { 'Content-Type': 'application/json', ...headers },
            // Business errors normally use HTTP 200, but syntax/rate-limit errors may not.
            // Always parse the body through the same ApiError implementation.
            validateStatus: () => true
        });
    }

    /**
     * Payment system id (MongoDB ObjectId).
     *
     * balance/add takes the ObjectId of a top-up system from balance/payments/list — and only
     * that. order/*, prolong/* and autoprolong/* accept just two payment systems, the account
     * balance and the saved card; the top-up systems from that list are rejected there, and the
     * balance itself is never listed. For orders and renewals prefer setPaymentCode('balance') /
     * setPaymentCode('paddle_subscription'); a code passed here works too — the server retries
     * the value as a code when it is not a valid id.
     *
     * Это значение клиента ПО УМОЛЧАНИЮ: платёжка, переданная в самом вызове (paymentId или
     * paymentCode в options либо в объектной форме), главнее — тогда пара клиента в запрос не
     * попадает вовсе, ни id, ни code (см. _paymentLevel()).
     * @param string id
     */
    setPaymentId(id) {
        this.paymentId = id
    }

    getPaymentId() {
        return this.paymentId
    }

    /**
     * Stable payment-system code for order/*, prolong/* and autoprolong/*: `balance` (the account
     * balance) or `paddle_subscription` (the card saved on the account) — the only two they
     * accept, since a one-off checkout ends on a hosted page a headless client cannot complete.
     * balance/add does not resolve codes and needs setPaymentId().
     *
     * Как и setPaymentId(), это значение по умолчанию: платёжка вызова его вытесняет целиком.
     */
    setPaymentCode(code) {
        this.paymentCode = code
    }

    getPaymentCode() {
        return this.paymentCode
    }

    /**
     * Generate new auths Y/N, default N.
     * Only applied to order/make, the order/calc endpoint ignores the field.
     * @param string yn
     */
    setGenerateAuth(yn) {
        this.generateAuth = (yn == 'Y' ? "Y" : "N");
    }

    getGenerateAuth() {
        return this.generateAuth
    }

    /**
     * X-Fingerprint — стабильный идентификатор УСТАНОВКИ клиента, уходит заголовком в order/make.
     *
     * Заголовок необязателен: заказы по API-ключу сервер создаёт и без него, в том числе
     * резидентские и скраперные. SDK шлёт его в order/make для любой секции, когда значение
     * задано, и не шлёт и не требует, когда его нет.
     *
     * Форма значения не проверяется — подойдёт любая непрозрачная непустая строка. SDK её НЕ
     * генерирует сам: заголовок введён ради анти-фрода и affiliate-атрибуции, а случайное
     * значение на процесс ломает и то и другое. Сохраните его рядом с ключом.
     *
     * Пустая строка и пробелы считаются незаданным значением.
     * @param string fingerprint
     */
    setFingerprint(fingerprint) {
        this.fingerprint = fingerprint != null && String(fingerprint).trim() !== ''
            ? String(fingerprint).trim()
            : null;
    }

    getFingerprint() {
        return this.fingerprint
    }

    /**
     * Что попадает в JSON.stringify(api): настройки клиента, baseURL — с маской на месте ключа. Ключ
     * стоит в пути baseURL, и без этого метода его печатал бы любой логгер, сериализующий объект.
     * @return {object}
     */
    toJSON() {
        const queue = this.requestQueue;
        return {
            baseURL: String(this.baseURL).replace(/[^/]+\/?$/, `${SECRET_MASK}/`),
            timeout: this.timeout,
            moneyTimeout: this.moneyTimeout,
            paymentId: this.paymentId,
            paymentCode: this.paymentCode,
            generateAuth: this.generateAuth,
            fingerprint: this.fingerprint,
            rateLimit: queue
                ? {
                    requestsPerMinute: queue.requestsPerMinute,
                    writeIntervalMs: queue.writeIntervalMs,
                    moneyIntervalMs: queue.moneyIntervalMs,
                    maxRetries: queue.maxRetries
                }
                : false
        };
    }

    /**
     * Что печатают console.log(api) и util.inspect(api): то же, что toJSON(), — без ключа и без
     * axios-инстанса, в defaults которого тоже лежит baseURL с ключом.
     */
    [INSPECT_CUSTOM](depth, options, inspect) {
        if (typeof inspect !== 'function') {
            return this.toJSON();
        }
        if (depth < 0) {
            return '[ProxySellerUserApi]';
        }
        const nested = { ...options, depth: options.depth == null ? options.depth : options.depth - 1 };
        return `ProxySellerUserApi ${inspect(this.toJSON(), nested)}`;
    }

    /**
     * Send request into server
     *
     * Единственное место, где SDK отправляет HTTP-запросы, и в него же встроена очередь запросов
     * (config.rateLimit, см. RequestQueue): категория берётся по пути (_requestCategory), запрос
     * ждёт своей очереди, HTTP 429 повторяется. Ожидание лишь откладывает resolve промиса. Без
     * очереди (rateLimit.enabled = false) запрос уходит сразу и без повторов — ровно как до неё.
     *
     * options.headers кладутся ПОВЕРХ заголовков клиента (axios мержит их с дефолтами
     * инстанса), не заменяя их: так order/make добавляет X-Fingerprint, не трогая
     * Content-Type и то, что передали в конструктор.
     *
     * По категории пути (_requestCategory) решаются ещё две вещи:
     *   - money получает свой таймаут — moneyTimeout конструктора; timeout в options главнее;
     *   - money и write считаются успешными, ТОЛЬКО если пришёл конверт со status="success".
     *     Ответ без конверта (HTML, пустое тело, 204, обрезанный JSON, не-объект) и конверт со
     *     status не "success" без errors — ApiError "Unexpected response …" (_unexpectedResponse()).
     *     read (а с ним и все calc) разбирается как раньше: status="error" с заполненным data и
     *     пустым errors[] — это нехватка средств у prolong/calc и autoprolong/calc, её data
     *     возвращается.
     * Все ApiError отсюда — без API-ключа (_apiError()).
     * @param string method
     * @param string uri
     * @param {*} options
     * @return mixed
     * @throws ApiError
     */
    async request(method, uri, options = {}) {
        const { method: ignoredMethod, url: ignoredUrl, baseURL: ignoredBaseURL, ...requestOptions } = options;
        const category = this._requestCategory(uri);
        // Функция, а не готовый промис: очередь зовёт её на каждую попытку, в том числе на повтор 429.
        const send = () => this.client.request({
            // Денежному запросу — свой таймаут, остальным — общий из axios.create().
            ...(category === 'money' ? { timeout: this.moneyTimeout } : {}),
            ...requestOptions,
            method: method,
            url: uri
        });
        let response;
        try {
            response = this.requestQueue
                ? await this.requestQueue.run(category, send)
                : await send();
        } catch (error) {
            // Сырой axios error наружу не уходит — ни сам, ни как cause: в его config лежит baseURL,
            // то есть ключ. Переносим текст, код и ответ, и всё это — без ключа.
            throw this._apiError(error?.message || 'Client API request failed', {
                code: error?.code ?? null,
                httpStatus: error?.response?.status ?? null,
                body: error?.response?.data ?? null
            });
        }
        const data = this.normalizeResponseData(
            response.data,
            response.headers?.['content-type'],
            response.headers?.['content-disposition']
        );
        // money и write: что запрос сделал, видно только по конверту, а без него не понять даже,
        // выполнился ли он. Такой ответ — не успех.
        const strict = category === 'money' || category === 'write';

        if (data && typeof data === 'object' && !this.isBinary(data)) {
            const isEnvelope = Object.prototype.hasOwnProperty.call(data, 'status') &&
                (Object.prototype.hasOwnProperty.call(data, 'data') ||
                    Object.prototype.hasOwnProperty.call(data, 'errors'));

            if (isEnvelope) {
                if (data.status === 'success') {
                    return data.data;
                }
                if (Array.isArray(data.errors) && data.errors.length > 0) {
                    // Сообщение берём из первого элемента, но весь массив прокидываем в
                    // ApiError.errors: у ошибок доступа первый элемент всегда "Error api key",
                    // и реальная причина (IP / лимит) видна только по остальным.
                    throw this.toApiError(data.errors[0], response.status, data, data.errors);
                }
                if (strict) {
                    throw this._unexpectedResponse(uri, response.status,
                        `status ${JSON.stringify(data.status)} without errors`, data);
                }
                // Calculation warnings and insufficient-funds responses intentionally use
                // status=error, errors=[], and put useful calculation details in data.
                if (response.status >= 200 && response.status < 300 &&
                    data.data !== undefined && data.data !== null) {
                    return data.data;
                }
                throw this._apiError('Client API returned an error', {
                    httpStatus: response.status,
                    body: data
                });
            }

            if (response.status < 200 || response.status >= 300) {
                throw this.toApiError(data, response.status, data);
            }
        } else if (response.status < 200 || response.status >= 300) {
            throw this._apiError(`Client API HTTP ${response.status}`, {
                httpStatus: response.status,
                body: data
            });
        }

        if (strict) {
            throw this._unexpectedResponse(uri, response.status, 'no JSON envelope', this._bodySnippet(data));
        }
        return data;
    }

    /**
     * Ошибка на ответ money/write без успешного конверта. Раньше такой ответ возвращался как успех:
     * order/make «возвращал» HTML-страницу или пустую строку, и интегратор считал заказ созданным
     * (или, наоборот, не созданным) наугад. По такому ответу не понять, выполнился ли запрос, поэтому
     * текст говорит прямо: мог выполниться, проверьте до повтора.
     * @param {string} uri путь запроса — без ключа, он в baseURL
     * @param {number} httpStatus
     * @param {string} what что не так с ответом
     * @param {*} body что положить в error.body: конверт либо начало тела (_bodySnippet())
     * @return {ApiError}
     */
    _unexpectedResponse(uri, httpStatus, what, body) {
        const path = String(uri == null ? '' : uri).split(/[?#]/, 1)[0];
        return this._apiError(
            `Unexpected response from ${path} (HTTP ${httpStatus}, ${what}); ` +
            'the request may have been executed — check before retrying',
            { httpStatus: httpStatus, body: body }
        );
    }

    /**
     * Начало тела ответа без конверта — для error.body: текстом, без ключа, не длиннее
     * BODY_SNIPPET_LENGTH символов. Ключ маскируется ДО обрезки, чтобы обрезка не оставила его часть.
     * @param {*} data тело после normalizeResponseData()
     * @return {string}
     */
    _bodySnippet(data) {
        let text;
        if (data === undefined || data === null) {
            text = '';
        } else if (typeof data === 'string') {
            text = data;
        } else if (this.isBinary(data)) {
            text = new TextDecoder().decode(asBytes(data));
        } else {
            try {
                text = JSON.stringify(data) ?? String(data);
            } catch (_) {
                text = String(data);
            }
        }
        text = this._maskSecret(text);
        return text.length > BODY_SNIPPET_LENGTH ? text.slice(0, BODY_SNIPPET_LENGTH) + '…' : text;
    }

    /**
     * Значение без API-ключа этого клиента — см. maskSecret().
     * @param {*} value
     * @return {*}
     */
    _maskSecret(value) {
        return maskSecret(value, CLIENT_SECRETS.get(this) || null);
    }

    /**
     * ApiError, в которой нет API-ключа: ни в message, ни в body / errors / customData. Ключ стоит в
     * пути запроса, а путь возвращают тела ошибок (Spring {timestamp, status, error, path}, HTML-страница
     * 404 фронта — та в нижнем регистре), так что маскируются точное написание, URL-кодированное и
     * любой регистр. Все ошибки, которые request() строит из ответа или из сбоя транспорта, идут
     * через этот метод.
     * @param {*} message
     * @param {object} fields поля ApiError: code, customData, httpStatus, body, errors
     * @return {ApiError}
     */
    _apiError(message, fields = {}) {
        const masked = {};
        for (const [name, value] of Object.entries(fields)) {
            masked[name] = this._maskSecret(value);
        }
        return new ApiError(this._maskSecret(message), masked);
    }

    /**
     * Категория запроса для очереди, таймаута и разбора ответа — money | write | read — по пути из
     * REQUEST_CATEGORIES, а не по HTTP-методу. Путь сравнивается посегментно, без query-строки, лишних слэшей и регистра;
     * `{type}` — любой один сегмент. Чего нет в таблице, то read.
     * @param {string} uri путь относительно корня API — тот, что получает request()
     * @return {string}
     */
    _requestCategory(uri) {
        const segments = String(uri == null ? '' : uri).split(/[?#]/, 1)[0]
            .trim().toLowerCase().split('/').filter(Boolean);
        const match = REQUEST_CATEGORY_PATTERNS.find((pattern) =>
            pattern.segments.length === segments.length &&
            pattern.segments.every((part, index) => part === '{type}' || part === segments[index]));
        return match ? match.category : 'read';
    }

    /**
     * ApiError из элемента errors[] конверта либо из тела ответа без конверта (например, тела ошибки
     * Spring {timestamp, status, error, path} — его path несёт ключ). Ключ маскируется (_apiError()).
     * @param {*} error элемент errors[] или тело ответа
     * @param {number} httpStatus
     * @param {*} body
     * @param {array} errors весь массив errors; по умолчанию — [error]
     * @return {ApiError}
     */
    toApiError(error, httpStatus, body, errors = null) {
        const item = error && typeof error === 'object' ? error : {};
        return this._apiError(item.message || item.error || `Client API HTTP ${httpStatus}`, {
            code: item.code ?? null,
            customData: item.customData ?? item.custom_data ?? null,
            httpStatus: httpStatus,
            body: body,
            errors: errors ?? (item && typeof item === 'object' ? [item] : [])
        });
    }

    /**
     * Кодирует сегмент пути. Значения вроде {type} подставляются в URI напрямую, и без
     * кодирования пробел/слэш/# в аргументе ломали бы маршрут или уводили запрос на другой
     * эндпоинт. apiKey кодируется отдельно в конструкторе.
     * @param {*} value
     * @return {string}
     */
    _pathSegment(value) {
        return encodeURIComponent(String(value));
    }

    isBinary(value) {
        return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
    }

    normalizeResponseData(value, contentType = '', contentDisposition = '') {
        const isJson = String(contentType).toLowerCase().includes('json');
        const isAttachment = String(contentDisposition).toLowerCase().includes('attachment');
        if (this.isBinary(value) && isAttachment) {
            return value;
        }
        if (this.isBinary(value) && isJson) {
            const bytes = value instanceof ArrayBuffer
                ? new Uint8Array(value)
                : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            try {
                return JSON.parse(new TextDecoder().decode(bytes));
            } catch (_) {
                return value;
            }
        }
        if (typeof value === 'string' && isJson) {
            try {
                return JSON.parse(value);
            } catch (_) {
                return value;
            }
        }
        return value;
    }

    /**
     * Drop undefined and null values, used for optional query filters
     * @param {*} params
     * @return {*}
     */
    filterEmpty(params) {
        return Object.fromEntries(
            Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
        );
    }

    /**
     * Пара платёжки КЛИЕНТА (setPaymentId / setPaymentCode): prepare*-хелперы кладут её в тело
     * первой, а платёжка вызова её затем вытесняет целиком — см. _paymentLevel().
     * @return {{paymentCode: *}|{paymentId: *}}
     */
    paymentOptions() {
        return this.getPaymentCode()
            ? { paymentCode: this.getPaymentCode() }
            : { paymentId: this.getPaymentId() };
    }

    /**
     * Платёжка запроса — пара paymentId / paymentCode РОВНО одного уровня. Платёжка вызова главнее
     * платёжки клиента: если в вызове (options или объектная форма) задана непустая половина пары,
     * пара клиента в запрос не попадает вовсе — ни id, ни code. Только когда в вызове нет ни той, ни
     * другой, берётся пара клиента, и пустые значения вызова ('' / null) её не стирают. Внутри уровня
     * старшинство прежнее — code старше id (ORDER_REFERENCE_PAIRS, PROLONG_REFERENCE_PAIRS).
     *
     * Раньше уровни смешивались: setPaymentCode('paddle_subscription') и { paymentId: 'balance' } в
     * вызове давали тело с обеими половинами, code был старше — и заказ, который вызов просил оплатить
     * с баланса, списывался с карты.
     * @param {object} base пара клиента — тело до мержа полей вызова (её положил paymentOptions())
     * @param {object} values поля вызова
     * @return {{paymentId: *, paymentCode: *}}
     */
    _paymentLevel(base, values) {
        const filled = (v) => v != null && String(v).trim() !== '';
        const level = filled(values.paymentId) || filled(values.paymentCode) ? values : base;
        return { paymentId: level.paymentId, paymentCode: level.paymentCode };
    }

    /**
     * Merge optional v2 order identifiers/codes without sending conflicting pairs.
     * Explicit per-call values take precedence over values configured on the client.
     *
     * countryId / periodId / paymentId / operatorId / mixId / tarifId accept an ObjectId OR the
     * corresponding stable code: the server retries the value as a code whenever it is not a
     * valid id and the paired *Code field is empty. The separate *Code fields are therefore
     * optional, not the only way to pass a code.
     *
     * rotationId is NOT an id and has NO code: it is the rotation interval in minutes
     * (0 = By Link, 5, 10, 60...). The server copies rotationCode into rotationId only when it
     * is an integer, so '5m' / '10m' are always rejected with
     * "Set existed [rotationCode] from reference".
     *
     * Когда заполнены обе половины пары, лишняя убирается по ПРИОРИТЕТУ СЕРВЕРА
     * (ORDER_REFERENCE_PAIRS): payment/country/period резолвятся от кода, а
     * operator/rotation/mix/tarif — от идентификатора.
     *
     * Платёжка не мержится по полям: пара вызова вытесняет пару клиента из payload целиком
     * (_paymentLevel()), и только потом внутри пары code старше id.
     */
    mergeOrderOptions(payload, options = {}) {
        const allowed = [
            'countryId', 'countryCode', 'periodId', 'periodCode', 'paymentId', 'paymentCode',
            'mixId', 'mixCode', 'uptime', 'protocol', 'mobileServiceType', 'operatorId',
            'operatorCode', 'rotationId', 'rotationCode', 'tarifId', 'tarifCode',
            'authorization', 'coupon', 'customTargetName', 'quantity', 'fingerprint'
        ];
        const values = options && typeof options === 'object' && !Array.isArray(options)
            ? options
            : {};
        // Выбираем до мержа: сейчас в payload лежит пара клиента.
        const payment = this._paymentLevel(payload, values);
        for (const key of allowed) {
            if (Object.prototype.hasOwnProperty.call(values, key)) {
                payload[key] = values[key];
            }
        }
        Object.assign(payload, payment);

        return this.filterEmpty(this._resolveReferencePairs(payload, ORDER_REFERENCE_PAIRS));
    }

    /**
     * Оставляет в теле ту половину пары *Id / *Code, которую выбрал бы сервер, и выбрасывает
     * вторую. Правило приоритета лежит в самой паре — см. ORDER_REFERENCE_PAIRS.
     *
     * Пустое значение ('' и пробелы) считается НЕзаданным. Раньше проверка была на `!= null`,
     * из-за чего `*Code: ''` стирал валидный парный `*Id`, и заказ уезжал без ссылки на
     * справочник — сервер сам трактует пустую строку как отсутствие значения.
     * @param {object} payload
     * @param {array} pairs
     * @return {object}
     */
    _resolveReferencePairs(payload, pairs) {
        const filled = (v) => v != null && String(v).trim() !== '';
        for (const [idKey, codeKey, senior] of pairs) {
            const primary = senior === 'code' ? codeKey : idKey;
            const secondary = senior === 'code' ? idKey : codeKey;
            if (filled(payload[primary])) {
                delete payload[secondary];
            } else {
                delete payload[primary];
                if (!filled(payload[secondary])) {
                    delete payload[secondary];
                }
            }
        }
        return payload;
    }

    /**
     * The server rejects ext with a bare plain-text HTTP 400 instead of the usual envelope,
     * so it is validated on the client side: длина <= 250, без CR, LF, '/' и '\\'.
     * @param string ext
     * @return string
     * @throws ApiError
     */
    assertExt(ext) {
        if (ext === undefined || ext === null) {
            return undefined;
        }
        if (ext.length > 250) {
            throw new ApiError('ext is too long (max 250)');
        }
        if (/[\r\n/\\]/.test(ext)) {
            throw new ApiError("ext contains forbidden characters (CR, LF, '/', '\\')");
        }
        return ext;
    }

    /////////////////////////////// Auth ///////////////////////////////

    /**
     * Get auths
     * @return array Returns list auths
     */
    async authList() {
        return this.request('get', 'auth/list');
    }

    /**
     * Create login/password authorization
     * @param string orderNumber
     * @param string generateAuth Y/N
     * @return object Created auth
     */
    async authAdd(orderNumber, generateAuth = 'N') {
        return this.request('post', 'auth/add', { data: { orderNumber: orderNumber, generateAuth: generateAuth } });
    }

    /**
     * Create IP authorization
     * @param string orderNumber
     * @param string ip
     * @return object Created auth
     */
    async authAddIp(orderNumber, ip) {
        return this.request('post', 'auth/add/ip', { data: { orderNumber: orderNumber, ip: ip } });
    }

    /**
     * Change authorization.
     * Replaces the v1 auth/active method, the active flag is a boolean now.
     * @param string id auth id
     * @param boolean active active state
     * @param string login
     * @param string password
     * @param string ip
     * @return object Current auth
     */
    async authChange(id, active, login = null, password = null, ip = null) {
        return this.request('post', 'auth/change', {
            data: { id: id, active: active, login: login, password: password, ip: ip }
        });
    }

    /**
     * Delete authorization
     * @param string id auth id
     * @return object
     */
    async authDelete(id) {
        return this.request('delete', 'auth/delete', { data: { id: id } });
    }

    /////////////////////////////// Balance ///////////////////////////////

    /**
     * Get balance statistic
     * @return float
     */
    async balance() {
        return (await this.request('get', 'balance/get')).summ;
    }

    /**
     * Replenish the balance.
     *
     * ВНИМАНИЕ: balance/add принимает ТОЛЬКО paymentId (ObjectId-строка из
     * balance/payments/list). Стабильные коды платёжных систем здесь НЕ резолвятся: тело
     * эндпоинта — лишь `summ` и `paymentId`, а резолва кодов, который работает в order/* и
     * prolong/*, здесь нет. setPaymentCode() на этот эндпоинт не влияет.
     *
     * Платёжка вызова главнее платёжки клиента (см. _paymentLevel()): непустой paymentId или
     * paymentCode вызова вытесняет setPaymentId() / setPaymentCode() целиком. Поэтому
     * { paymentCode } в вызове — локальная ApiError, даже если у клиента задан paymentId: молча
     * пополнить баланс другой системой, чем просил вызов, хуже, чем отказать.
     *
     * @param {number} summ сумма пополнения (минимум задаётся на сервере, по умолчанию > 1)
     * @param {string|{paymentId?: string, paymentCode?: string}} paymentId ObjectId платёжной системы
     * @return {Promise<string>} ссылка на страницу оплаты
     * @throws ApiError если paymentId не удалось определить
     */
    async balanceAdd(summ = 5, paymentId = null) {
        const asObject = paymentId && typeof paymentId === 'object' && !Array.isArray(paymentId)
            ? paymentId
            : null;
        const call = asObject
            ? { paymentId: asObject.paymentId, paymentCode: asObject.paymentCode }
            : { paymentId: paymentId };
        const payment = this._paymentLevel(
            { paymentId: this.getPaymentId(), paymentCode: this.getPaymentCode() }, call
        );
        const filled = (v) => v != null && String(v).trim() !== '';

        if (!filled(payment.paymentId)) {
            if (filled(payment.paymentCode)) {
                throw new ApiError(
                    `balance/add does not resolve paymentCode ("${payment.paymentCode}"): the endpoint accepts only ` +
                    'paymentId (an ObjectId from balancePaymentsList()). Pick the item you need there ' +
                    'and pass its id as paymentId / setPaymentId().'
                );
            }
            throw new ApiError(
                'balance/add requires paymentId (an ObjectId from balancePaymentsList()); ' +
                'pass it explicitly or via setPaymentId().'
            );
        }

        return (await this.request('post', 'balance/add', {
            data: { summ: summ, paymentId: payment.paymentId }
        })).url;
    }

    /**
     * List of payment systems for balance replenishing — the ids balanceAdd() takes.
     *
     * Not a list of ways to pay for orders: the account balance is never in it, and order/*,
     * prolong/* and autoprolong/* accept only `balance` and `paddle_subscription`
     * (setPaymentCode()).
     * @return array
     */
    async balancePaymentsList() {
        return (await this.request('get', 'balance/payments/list')).items;
    }

    /**
     * Текущее состояние авто-пополнения баланса.
     *
     * data: configured, enabled, state, threshold, amount,
     * subscriptionId, paymentMethod {id, status, paymentMethod, brand, last4, exp},
     * failCount, lastAttemptAt, lastEvent {status, amount, at, reason}.
     *
     * `state` — одно из NO_PAYMENT_METHOD | DISABLED | ACTIVE | PAYMENT_INVALID | PAUSED_FAILURES.
     * `lastEvent.status` — TRIGGERED | SUCCEEDED | FAILED | SKIPPED_CAP | SETTINGS_SAVED | PAUSED.
     * paymentMethod = null, если платёжный метод не привязан; lastEvent = null, если срабатываний
     * ещё не было. Лимитов dailyCountCap/monthlyAmountCap в ответе БОЛЬШЕ НЕТ — они убраны из
     * контракта 18.08.2026.
     *
     * Если фича выключена на окружении, приходит ошибка code=49 "Auto top-up is not available".
     * @return {Promise<object>}
     */
    async balanceAutoTopupGet() {
        return this.request('get', 'balance/autotopup/get');
    }

    /**
     * Включить/выключить авто-пополнение либо изменить его пороги и лимиты.
     *
     * PARTIAL UPDATE: отправляются только реально переданные поля. Пропущенное (или
     * переданное как null/undefined) поле сервер НЕ меняет — берёт текущее сохранённое
     * значение и валидирует РЕЗУЛЬТАТ мержа. Поэтому, чтобы поправить только порог,
     * достаточно `{ threshold: 20 }`.
     *
     * Поля: enabled (boolean), threshold (number), amount (number),
     * subscriptionId (string, Paddle-подписка из paymentMethod.id).
     *
     * dailyCountCap и monthlyAmountCap УБРАНЫ из контракта 18.08.2026: сервер их игнорирует,
     * а коды 54/55 удалены и не переиспользуются. Переданные — локальная ApiError, иначе вызов
     * тихо не делал бы ничего.
     *
     * Границы: threshold >= 1, amount >= 5 и amount >= threshold. Коды ошибок валидации —
     * 50 (min threshold), 51 (min amount), 52 (amount < threshold), 53 (нет привязанного
     * платёжного метода), 56 (карта истекла), 49 (фича выключена на окружении).
     * Для 50/51 сервер кладёт допустимую границу в errors[0].customData —
     * {minThreshold} / {minAmount}, доступно как error.customData.
     *
     * Сброс паузы и счётчика неудач происходит только при ЯВНОМ enabled: true.
     *
     * На успехе возвращается состояние ПОСЛЕ сохранения — та же форма, что у
     * balanceAutoTopupGet(), второй запрос не нужен.
     *
     * @param {{enabled?: boolean, threshold?: number, amount?: number, subscriptionId?: string}} settings
     * @return {Promise<object>}
     * @throws ApiError если не передано ни одного известного поля либо передано удалённое
     */
    async balanceAutoTopupSet(settings = {}) {
        return this.request('post', 'balance/autotopup/set', {
            data: this._autoTopupSetBody(settings)
        });
    }

    /**
     * Собирает тело partial update: только переданные поля. null/undefined отбрасываются —
     * на сервере null означает "не менять", так что отправлять его бессмысленно, а вот
     * случайно затереть чужое поле опечаткой не хочется.
     * @param {*} settings
     * @return {object}
     * @throws ApiError
     */
    _autoTopupSetBody(settings) {
        const values = settings && typeof settings === 'object' && !Array.isArray(settings)
            ? settings
            : {};
        const removed = AUTO_TOPUP_REMOVED_FIELDS.filter(
            (key) => Object.prototype.hasOwnProperty.call(values, key)
        );
        if (removed.length > 0) {
            throw new ApiError(
                `balance/autotopup/set no longer accepts ${removed.join(', ')}: the caps were ` +
                'removed from the contract on 2026-08-18 and the server ignores them, so sending ' +
                'them would look like success while nothing changed. Drop the field(s) — error ' +
                'codes 54/55 are gone with them.'
            );
        }
        const body = {};
        for (const key of AUTO_TOPUP_SET_FIELDS) {
            if (!Object.prototype.hasOwnProperty.call(values, key)) {
                continue;
            }
            if (values[key] === undefined || values[key] === null) {
                continue;
            }
            body[key] = values[key];
        }
        if (Object.keys(body).length === 0) {
            throw new ApiError(
                'balance/autotopup/set is a partial update and needs at least one of: ' +
                AUTO_TOPUP_SET_FIELDS.join(', ')
            );
        }
        return body;
    }

    /////////////////////////////// Order ///////////////////////////////

    /**
     * Necessary guides for creating an order.
     *
     * ФОРМА ОТВЕТА РАЗНАЯ. referenceList('ipv4') отдаёт `{items: {country: [...], period: [...]}}`
     * — обёртка items здесь ОБЪЕКТ, а не массив, — а referenceList() без типа отдаёт справочники
     * сразу по ключам типов: `{ipv4: {...}, ipv6: {...}, mix: {...}, resident: {...}}`, без items.
     * Читать типизированный ответ как нетипизированный нельзя.
     *
     * Всюду идентификатор называется id, а внутри лежит читаемый код, не ObjectId.
     * Значение id кладётся в одноимённый *Id заказа — выбирать не из чего:
     *   country[]                id, name                -> id = alpha3 страны ("USA")
     *   period[]                 id, name                -> id = код периода ("1m")
     *   mobile country[]         id, name, operators{dedicated[], shared[]}
     *   operators[]              id, name, rotations[]   -> id = тег оператора, регистр значим
     *   operators[].rotations[]  id = МИНУТЫ, name       -> "5 minutes", 0 = "By Link";
     *                                                       единственный id-число, а не код
     *   mix quantities[]         id, name, quantities[]  -> id = код пакета, рядом же доступные
     *                                                       количества — канон для mixId
     *   mix country[]            id, name                -> тот же код пакета
     *   resident tarifs[]        id, name, personal      -> id = код тарифа ("1-gb")
     * Платёжки в справочнике нет. Заказ и продление оплачиваются только кодом `balance` (баланс)
     * или `paddle_subscription` (привязанная карта) — setPaymentCode(). balancePaymentsList() —
     * это системы ПОПОЛНЕНИЯ для balanceAdd(): там id — настоящий ObjectId, и это единственное
     * исключение (на один код шлюза приходится несколько систем), а сам баланс в список не входит.
     *
     * @param string type - ipv4 | ipv6 | mobile | isp | mix | resident | null
     * @return object
     */
    async referenceList(type = null) {
        return this.request('get', type === null
            ? 'reference/list'
            : 'reference/list/' + this._pathSegment(type));
    }

    prepareRegular(sectionCode, countryId, periodId, quantity, authorization, coupon, customTargetName, options = {}) {
        if (countryId && typeof countryId === 'object' && !Array.isArray(countryId)) {
            return this.mergeOrderOptions(
                { ...this.paymentOptions(), sectionCode: sectionCode },
                { ...countryId, ...options }
            );
        }
        return this.mergeOrderOptions({
            ...this.paymentOptions(), sectionCode: sectionCode, countryId: countryId,
            periodId: periodId, quantity: quantity, authorization: authorization,
            coupon: coupon, customTargetName: customTargetName
        }, options);
    }

    prepareMix(mixId, periodId, quantity, authorization, coupon, customTargetName, options = {}) {
        if (mixId && typeof mixId === 'object' && !Array.isArray(mixId)) {
            return this.mergeOrderOptions(
                { ...this.paymentOptions(), sectionCode: 'mix' },
                { ...mixId, ...options }
            );
        }
        return this.mergeOrderOptions({
            ...this.paymentOptions(), sectionCode: 'mix', mixId: mixId, periodId: periodId,
            quantity: quantity, authorization: authorization, coupon: coupon,
            customTargetName: customTargetName
        }, options);
    }

    prepareIpv6(countryId, periodId, quantity, authorization, coupon, customTargetName, protocol, options = {}) {
        if (countryId && typeof countryId === 'object' && !Array.isArray(countryId)) {
            return this.mergeOrderOptions(
                { ...this.paymentOptions(), sectionCode: 'ipv6' },
                { ...countryId, ...options }
            );
        }
        return this.mergeOrderOptions({
            ...this.paymentOptions(), sectionCode: 'ipv6', countryId: countryId,
            periodId: periodId, quantity: quantity, authorization: authorization,
            coupon: coupon, customTargetName: customTargetName, protocol: protocol
        }, options);
    }

    /**
     * @param {string|object} countryId ObjectId or country code (alpha3, e.g. 'USA'); object = whole payload
     * @param {string} periodId ObjectId or period code (e.g. '1m')
     * @param {number} quantity
     * @param {string} authorization
     * @param {string} coupon
     * @param {string} operatorId ObjectId or operator tag
     * @param {number} rotationId rotation interval in MINUTES (0 = By Link, 5, 10, 60...), never a code
     * @param {string} mobileServiceType dedicated | shared
     * @param {object} options fields with no positional slot (paymentId/paymentCode, *Code, ...)
     */
    prepareMobile(countryId, periodId, quantity, authorization, coupon, operatorId, rotationId,
        mobileServiceType = 'dedicated', options = {}) {
        if (countryId && typeof countryId === 'object' && !Array.isArray(countryId)) {
            return this.mergeOrderOptions({
                ...this.paymentOptions(), sectionCode: 'mobile', mobileServiceType: 'dedicated'
            }, { ...countryId, ...options });
        }
        if (mobileServiceType && typeof mobileServiceType === 'object' && !Array.isArray(mobileServiceType)) {
            options = mobileServiceType;
            mobileServiceType = 'dedicated';
        }
        return this.mergeOrderOptions({
            ...this.paymentOptions(), sectionCode: 'mobile', countryId: countryId,
            periodId: periodId, quantity: quantity, authorization: authorization,
            coupon: coupon, operatorId: operatorId, rotationId: rotationId,
            mobileServiceType: mobileServiceType
        }, options);
    }

    prepareResident(tarifId, coupon, options = {}) {
        if (tarifId && typeof tarifId === 'object' && !Array.isArray(tarifId)) {
            return this.mergeOrderOptions(
                { ...this.paymentOptions(), sectionCode: 'resident' },
                { ...tarifId, ...options }
            );
        }
        return this.mergeOrderOptions({
            ...this.paymentOptions(), sectionCode: 'resident', tarifId: tarifId, coupon: coupon
        }, options);
    }

    /**
     * generateAuth is accepted by order/make only, order/calc silently drops it
     * @param {*} json
     * @return {*}
     */
    withGenerateAuth(json) {
        return { ...json, generateAuth: this.getGenerateAuth() };
    }

    /**
     * Calculate the order
     * @param {*} json Free format object to send into endpoint
     * @return object
     */
    /**
     * Повторяет серверную проверку цели: для ipv4/ipv6/isp заказ без цели не принимается.
     * В v1 цель задавалась targetId+targetSectionId либо своим текстом, в v2 — только
     * customTargetName. Для mix проверка не нужна, если передан mixId/mixCode — иначе сервер
     * резолвит тип в ipv4, и цель снова обязательна.
     *
     * Проверяем локально, чтобы не платить сетевым запросом за "Incorrect goal" (код 14).
     * @param {object} json
     */
    assertTargetName(json) {
        const section = json ? json.sectionCode : null;
        if (!['ipv4', 'ipv6', 'isp', 'mix', 'mix_isp'].includes(section)) {
            return;
        }
        if (this._isMixResolved(section, json)) {
            return;
        }
        const filled = (v) => v != null && String(v).trim() !== '';
        if (filled(json.customTargetName)) {
            return;
        }
        throw new ApiError(
            `customTargetName is required for ${section} orders (client api returns "Incorrect goal", code 14)`,
            { code: 14 }
        );
    }

    /**
     * Повторяет серверный разбор mix-выбора: сервер распознаёт mix не только по
     * mixId/mixCode, но и через countryId — строкой "packageId:quantity" либо
     * countryId=packageId вместе с quantity. Если mix распознан, цель не требуется.
     * Раньше проверялись только mixId/mixCode, из-за чего mix через countryId в
     * orderCalc(object) блокировался локально и запрос не уходил.
     * @param {string} section
     * @param {object} json
     * @return {boolean}
     */
    _isMixResolved(section, json) {
        if (section !== 'mix' && section !== 'mix_isp') {
            return false;
        }
        const filled = (v) => v != null && String(v).trim() !== '';
        if (filled(json.mixId) || filled(json.mixCode)) {
            return true;
        }
        const countryId = json.countryId != null ? String(json.countryId).trim() : '';
        if (countryId === '') {
            return false;
        }
        if (countryId.includes(':')) {
            return true;
        }
        return json.quantity != null && parseInt(json.quantity, 10) > 0;
    }

    /**
     * data delete-эндпоинтов приходит СТРОКОЙ, а не объектом: resident/list/delete → "delete",
     * residentsubuser/delete и residentsubuser/list/delete → JSON внутри строки (например
     * {"status":"not-found"} при конверте status="success"). Раньше методы возвращали сырую
     * строку, и неудавшееся удаление было неотличимо от успешного.
     * @param {*} data
     * @return {object}
     */
    _deleteResult(data) {
        if (data != null && typeof data === 'object') {
            return data;
        }
        if (data == null) {
            return {};
        }
        if (typeof data === 'string') {
            const trimmed = data.trim();
            if (trimmed.startsWith('{')) {
                try {
                    const parsed = JSON.parse(trimmed);
                    if (parsed && typeof parsed === 'object') {
                        return parsed;
                    }
                } catch (e) {
                    // не JSON — заворачиваем ниже
                }
            }
            return { status: trimmed };
        }
        return { status: data };
    }

    /**
     * Достаёт значение X-Fingerprint для конкретного вызова и убирает его из ТЕЛА: это
     * заголовок, поля `fingerprint` сервер не знает. Принимать его в теле всё же надо —
     * типизированные хелперы общие для calc и make, и других путей у options нет.
     *
     * Приоритет: явный аргумент вызова -> ключ fingerprint в теле/options -> значение клиента
     * (конструктор либо setFingerprint). Пустая строка и пробелы — незаданное значение.
     * @param {*} json
     * @param {*} override
     * @return {{body: *, fingerprint: (string|null)}}
     */
    _takeFingerprint(json, override = null) {
        const isPayload = json && typeof json === 'object' && !Array.isArray(json);
        const body = isPayload ? { ...json } : json;
        const inline = isPayload ? json.fingerprint : null;
        if (isPayload) {
            delete body.fingerprint;
        }
        const filled = (v) => v != null && String(v).trim() !== '';
        const value = [override, inline, this.getFingerprint()].find(filled);
        return { body: body, fingerprint: filled(value) ? String(value).trim() : null };
    }

    async orderCalc(json) {
        // order/calc заголовка не объявляет — fingerprint только вынимаем из тела, чтобы он
        // не уехал в payload неизвестным сервером полем.
        const { body } = this._takeFingerprint(json);
        this.assertTargetName(body);
        return this.request('post', 'order/calc', { data: body });
    }

    /**
     * Create an order
     * @param {*} json Free format object to send into endpoint
     * @param {string} fingerprint X-Fingerprint только для этого вызова; по умолчанию берётся
     *        ключ fingerprint из json, затем значение клиента (конструктор / setFingerprint).
     *        Необязателен: без значения заголовок просто не уходит
     * @return object
     */
    async orderMake(json, fingerprint = null) {
        const taken = this._takeFingerprint(json, fingerprint);
        this.assertTargetName(taken.body);
        return this.request('post', 'order/make', {
            data: taken.body,
            // Заголовок шлём, когда значение задано, для ЛЮБОЙ секции: сервер его не требует, но
            // анти-фрод и affiliate-атрибуция от него зависят. Без значения — не шлём и не падаем.
            ...(taken.fingerprint ? { headers: { [FINGERPRINT_HEADER]: taken.fingerprint } } : {})
        });
    }

    /**
     * Calculate the order IPv4.
     * @param {string|object} countryId ObjectId or country code (alpha3, e.g. 'USA'); object = whole payload
     * @param {string} periodId ObjectId or period code (e.g. '1m')
     * @param {number} quantity
     * @param {string} authorization
     * @param {string} coupon
     * @param {string} customTargetName required for ipv4 (server answers "Incorrect goal", code 14)
     * @param {object} options fields with no positional slot: uptime, paymentId/paymentCode, ...
     */
    async orderCalcIpv4(countryId, periodId = null, quantity = null, authorization = null, coupon = null, customTargetName = null, options = {}) {
        return this.orderCalc(this.prepareRegular('ipv4', countryId, periodId, quantity, authorization, coupon, customTargetName, options));
    }

    /**
     * Calculate the order ISP.
     * @param {string|object} countryId ObjectId or country code (alpha3, e.g. 'USA'); object = whole payload
     * @param {string} periodId ObjectId or period code (e.g. '1m')
     * @param {number} quantity
     * @param {string} authorization
     * @param {string} coupon
     * @param {string} customTargetName required for isp (server answers "Incorrect goal", code 14)
     * @param {object} options fields with no positional slot: uptime, paymentId/paymentCode, ...
     */
    async orderCalcIsp(countryId, periodId = null, quantity = null, authorization = null, coupon = null, customTargetName = null, options = {}) {
        return this.orderCalc(this.prepareRegular('isp', countryId, periodId, quantity, authorization, coupon, customTargetName, options));
    }

    /**
     * Calculate the order MIX. The first positional argument is a MIX package identifier,
     * not a country id.
     * @param {string|object} mixId package ObjectId or its tag (mixCode); object = whole payload
     * @param {string} periodId ObjectId or period code (e.g. '1m')
     * @param {number} quantity
     * @param {string} authorization
     * @param {string} coupon
     * @param {string} customTargetName only needed when the MIX package cannot be resolved
     * @param {object} options fields with no positional slot: paymentId/paymentCode, mixCode, ...
     */
    async orderCalcMix(mixId, periodId = null, quantity = null, authorization = null, coupon = null, customTargetName = null, options = {}) {
        return this.orderCalc(this.prepareMix(mixId, periodId, quantity, authorization, coupon, customTargetName, options));
    }

    /**
     * Same as orderCalcMix() with the identifiers sent in the explicit mixCode/periodCode fields.
     * orderCalcMix('mix-us-eu', '1m', 1) does the same job through the *Id fallback.
     */
    async orderCalcMixByCode(mixCode, periodCode, quantity, options = {}) {
        return this.orderCalcMix({ ...options, mixCode: mixCode, periodCode: periodCode, quantity: quantity });
    }

    /**
     * Calculate the order IPv6.
     * @param {string|object} countryId ObjectId or country code (alpha3, e.g. 'USA'); object = whole payload
     * @param {string} periodId ObjectId or period code (e.g. '1m')
     * @param {number} quantity
     * @param {string} authorization
     * @param {string} coupon
     * @param {string} customTargetName required for ipv6 (server answers "Incorrect goal", code 14)
     * @param {string} protocol
     * @param {object} options fields with no positional slot: paymentId/paymentCode, ...
     */
    async orderCalcIpv6(countryId, periodId = null, quantity = null, authorization = null, coupon = null, customTargetName = null, protocol = null, options = {}) {
        return this.orderCalc(this.prepareIpv6(countryId, periodId, quantity, authorization, coupon, customTargetName, protocol, options));
    }

    /**
     * Calculate the order Mobile.
     * @param {string|object} countryId ObjectId or country code (alpha3, e.g. 'USA'); object = whole payload
     * @param {string} periodId ObjectId or period code (e.g. '1m')
     * @param {number} quantity
     * @param {string} authorization
     * @param {string} coupon
     * @param {string} operatorId ObjectId or operator tag
     * @param {number} rotationId rotation interval in MINUTES (0 = By Link, 5, 10, 60...), never a code
     * @param {string} mobileServiceType dedicated | shared
     * @param {object} options fields with no positional slot: paymentId/paymentCode, ...
     */
    async orderCalcMobile(countryId, periodId = null, quantity = null, authorization = null, coupon = null,
        operatorId = null, rotationId = null, mobileServiceType = 'dedicated', options = {}) {
        return this.orderCalc(this.prepareMobile(
            countryId, periodId, quantity, authorization, coupon, operatorId, rotationId,
            mobileServiceType, options
        ));
    }

    /**
     * Calculate the order Resident.
     * @param {string|object} tarifId tariff ObjectId or its code; object = whole payload
     * @param {string} coupon
     * @param {object} options fields with no positional slot: paymentId/paymentCode, tarifCode, ...
     */
    async orderCalcResident(tarifId, coupon = null, options = {}) {
        return this.orderCalc(this.prepareResident(tarifId, coupon, options));
    }

    /**
     * Create an order IPv4. Attention! Deducts money from the balance.
     * @param {string|object} countryId ObjectId or country code (alpha3, e.g. 'USA'); object = whole payload
     * @param {string} periodId ObjectId or period code (e.g. '1m')
     * @param {number} quantity
     * @param {string} authorization
     * @param {string} coupon
     * @param {string} customTargetName required for ipv4 (server answers "Incorrect goal", code 14)
     * @param {object} options fields with no positional slot: uptime, paymentId/paymentCode, ...
     */
    async orderMakeIpv4(countryId, periodId = null, quantity = null, authorization = null, coupon = null, customTargetName = null, options = {}) {
        return this.orderMake(this.withGenerateAuth(this.prepareRegular('ipv4', countryId, periodId, quantity, authorization, coupon, customTargetName, options)));
    }

    /**
     * Create an order ISP. Attention! Deducts money from the balance.
     * @param {string|object} countryId ObjectId or country code (alpha3, e.g. 'USA'); object = whole payload
     * @param {string} periodId ObjectId or period code (e.g. '1m')
     * @param {number} quantity
     * @param {string} authorization
     * @param {string} coupon
     * @param {string} customTargetName required for isp (server answers "Incorrect goal", code 14)
     * @param {object} options fields with no positional slot: uptime, paymentId/paymentCode, ...
     */
    async orderMakeIsp(countryId, periodId = null, quantity = null, authorization = null, coupon = null, customTargetName = null, options = {}) {
        return this.orderMake(this.withGenerateAuth(this.prepareRegular('isp', countryId, periodId, quantity, authorization, coupon, customTargetName, options)));
    }

    /**
     * Create an order MIX. Attention! Deducts money from the balance.
     * @param {string|object} mixId package ObjectId or its tag (mixCode); object = whole payload
     * @param {string} periodId ObjectId or period code (e.g. '1m')
     * @param {number} quantity
     * @param {string} authorization
     * @param {string} coupon
     * @param {string} customTargetName only needed when the MIX package cannot be resolved
     * @param {object} options fields with no positional slot: paymentId/paymentCode, mixCode, ...
     */
    async orderMakeMix(mixId, periodId = null, quantity = null, authorization = null, coupon = null, customTargetName = null, options = {}) {
        return this.orderMake(this.withGenerateAuth(this.prepareMix(mixId, periodId, quantity, authorization, coupon, customTargetName, options)));
    }

    /**
     * Same as orderMakeMix() with the identifiers sent in the explicit mixCode/periodCode fields.
     * orderMakeMix('mix-us-eu', '1m', 1) does the same job through the *Id fallback.
     */
    async orderMakeMixByCode(mixCode, periodCode, quantity, options = {}) {
        return this.orderMakeMix({ ...options, mixCode: mixCode, periodCode: periodCode, quantity: quantity });
    }

    /**
     * Create an order IPv6. Attention! Deducts money from the balance.
     * @param {string|object} countryId ObjectId or country code (alpha3, e.g. 'USA'); object = whole payload
     * @param {string} periodId ObjectId or period code (e.g. '1m')
     * @param {number} quantity
     * @param {string} authorization
     * @param {string} coupon
     * @param {string} customTargetName required for ipv6 (server answers "Incorrect goal", code 14)
     * @param {string} protocol
     * @param {object} options fields with no positional slot: paymentId/paymentCode, ...
     */
    async orderMakeIpv6(countryId, periodId = null, quantity = null, authorization = null, coupon = null, customTargetName = null, protocol = null, options = {}) {
        return this.orderMake(this.withGenerateAuth(this.prepareIpv6(countryId, periodId, quantity, authorization, coupon, customTargetName, protocol, options)));
    }

    /**
     * Create an order Mobile. Attention! Deducts money from the balance.
     * @param {string|object} countryId ObjectId or country code (alpha3, e.g. 'USA'); object = whole payload
     * @param {string} periodId ObjectId or period code (e.g. '1m')
     * @param {number} quantity
     * @param {string} authorization
     * @param {string} coupon
     * @param {string} operatorId ObjectId or operator tag
     * @param {number} rotationId rotation interval in MINUTES (0 = By Link, 5, 10, 60...), never a code
     * @param {string} mobileServiceType dedicated | shared
     * @param {object} options fields with no positional slot: paymentId/paymentCode, ...
     */
    async orderMakeMobile(countryId, periodId = null, quantity = null, authorization = null, coupon = null,
        operatorId = null, rotationId = null, mobileServiceType = 'dedicated', options = {}) {
        return this.orderMake(this.withGenerateAuth(this.prepareMobile(
            countryId, periodId, quantity, authorization, coupon, operatorId, rotationId,
            mobileServiceType, options
        )));
    }

    /**
     * Create an order Resident. Attention! Deducts money from the balance.
     *
     * X-Fingerprint необязателен: уходит заголовком, если задан через конструктор /
     * setFingerprint() или положен в options как fingerprint; без значения заказ уходит без
     * заголовка.
     * @param {string|object} tarifId tariff ObjectId or its code; object = whole payload
     * @param {string} coupon
     * @param {object} options fields with no positional slot: paymentId/paymentCode, tarifCode,
     *        fingerprint, ...
     */
    async orderMakeResident(tarifId, coupon = null, options = {}) {
        return this.orderMake(this.prepareResident(tarifId, coupon, options));
    }

    /**
     * List of orders
     *
     * Возвращает не плоский список, а пару metadata + items. metadata есть всегда: без
     * limit там total_pages = 1, current_limit = 0, а весь список лежит в items.
     *
     * Фильтры запроса и поля ответа здесь в snake_case (start_date, is_extend, order_id) —
     * передавайте их ровно под этими именами.
     *
     * id, order_id, order_number, base_order_number и items[].order_part_id — СТРОКИ; id —
     * числовой номер заказа, переданный строкой, а ObjectId заказа лежит в order_id (тот же,
     * что order_id в proxyList(), и тот, что prolong/* и autoprolong/* принимают в orderIds).
     * summ и вложенные items[].price — тоже строки, уже с валютой ('$25.00'),
     * auto_order / is_extend — 'Y'/'N', даты — ISO 8601 со смещением ('2026-09-01T14:15:26+00:00').
     *
     * @param {*} filters order_id | start_date | end_date | status | is_extend | auto_order |
     *                    page | limit | sort_by | order — все опциональны.
     *                    status — PAYED | NOT_PAYED | RETURN (это status_type ответа,
     *                    а не человекочитаемый status), is_extend / auto_order — 'Y'/'N',
     *                    sort_by — date_insert | summ | status, order — asc | desc
     * @return object
     */
    async orderList(filters = {}) {
        const params = this.filterEmpty(filters);
        return this.request('get', 'order/list', { params: params });
    }

    /////////////////////////////// Prolong ///////////////////////////////

    /**
     * Приводит тип из пути к ключу, по которому сервер выбирает правила продления:
     * trim, lower case, '-' и пробел -> '_' (' Mix-ISP ' -> 'mix_isp'). В путь запроса уходит
     * исходное значение — нормализованное нужно только для выбора поля.
     * @param {*} type
     * @return {string}
     */
    _normalizeProlongType(type) {
        return String(type == null ? '' : type).trim().toLowerCase().replace(/[- ]/g, '_');
    }

    /**
     * true, если на месте выбора пришёл объект — тогда это всё тело целиком. Массив, Set и
     * прочие iterable — это сам выбор, а не тело.
     * @param {*} value
     * @return {boolean}
     */
    _isProlongPayload(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value) &&
            typeof value[Symbol.iterator] !== 'function';
    }

    /**
     * Приводит выбор к плоскому списку: массив (или другой iterable, например Set), строка через
     * запятую либо одиночное значение. Строки обрезаются, пустые элементы и null/undefined
     * пропускаются, числа приводятся к строке — идентификаторы v2 всегда строки.
     * @param {*} value
     * @return {array}
     */
    _prolongList(value) {
        let items;
        if (value === undefined || value === null) {
            return [];
        } else if (typeof value === 'string') {
            items = value.split(',');
        } else if (typeof value === 'object' && typeof value[Symbol.iterator] === 'function') {
            items = Array.from(value);
        } else {
            items = [value];
        }
        const list = [];
        for (const item of items) {
            if (item === undefined || item === null) {
                continue;
            }
            if (typeof item === 'string') {
                const trimmed = item.trim();
                if (trimmed) {
                    list.push(trimmed);
                }
            } else if (typeof item === 'number' || typeof item === 'bigint') {
                list.push(String(item));
            } else {
                list.push(item);
            }
        }
        return list;
    }

    /**
     * Раскладывает позиционный выбор prolong/* и autoprolong/* по полям тела с учётом типа.
     *
     * Значение с точкой или двоеточием — адрес, как его отдаёт proxy/list: поле `ip` у ipv4/isp,
     * ip + ':' + port_http + ':' + port_socks у mobile. Адреса уходят в `ips`. Всё остальное —
     * идентификатор, и его поле задаёт тип:
     *   ipv4, isp, mobile   — прокси продлеваются по отдельности: это `id` прокси из proxy/list,
     *                         уходит в `ids`;
     *   ipv6, mix, mix_isp  — продаются и продлеваются только целыми заказами: это `order_id`
     *                         из proxy/list или order/list, уходит в `orderIds`.
     * Id прокси и id заказа — оба ObjectId, по форме их не отличить, поэтому для ipv6/mix/mix_isp
     * передавайте именно order_id. Адрес для этих типов всё равно уходит в `ips`, и сервер
     * отвечает "[ips] is not applicable for <type>: prolong by [orderIds]" — ошибка называет
     * нужное поле, а не прячется за подменой.
     *
     * Здесь только раскладка. Что из разложенного отправлять нельзя (смесь id и адресов у
     * ipv4/isp/mobile, любой выбор у резидентки), решает _assertProlongSelection().
     *
     * Пустые списки не возвращаются — поле без значений в тело не попадает.
     * @param {string} type
     * @param {array|string} ipsOrIds
     * @return {{ids?: string[], orderIds?: string[], ips?: string[]}}
     */
    _splitProlongTargets(type, ipsOrIds) {
        const kind = this._normalizeProlongType(type);
        const ips = [];
        const ids = [];
        for (const item of this._prolongList(ipsOrIds)) {
            const isAddress = typeof item === 'string' && (item.includes('.') || item.includes(':'));
            (isAddress ? ips : ids).push(item);
        }
        const routed = {};
        if (ids.length) {
            routed[ORDER_PROLONG_TYPES.includes(kind) ? 'orderIds' : 'ids'] = ids;
        }
        if (ips.length) {
            routed.ips = ips;
        }
        return routed;
    }

    /**
     * Тело prolong/calc и prolong/make; на нём же строится тело autoprolong/*.
     *
     * Позиционный выбор раскладывается по полям с учётом типа — см. _splitProlongTargets().
     * Поля из options (либо из объекта на месте выбора — тогда это всё тело целиком) уходят как
     * переданы, поверх разложенного: ids, ips, orderIds, coupon, periodId/periodCode,
     * paymentId/paymentCode. Подходит ли поле выбора типу, проверяет сервер: поле не того вида
     * он отбивает с кодом 0, называя нужное ("[ids] is not applicable for ipv6: prolong by
     * [orderIds]", "[orderIds] is not applicable for ipv4: prolong by [ids]"). Пустые списки не
     * отправляются.
     *
     * Локально отбиваются три случая, которые сервер обработал бы молча не так, как ждёт
     * вызывающий:
     *   - orderSeparatorIds, orderSeparatorId — убраны из контракта, сервер их не читает
     *     (_assertNoRemovedProlongFields, ошибка называет замену — orderIds);
     *   - ids вместе с ips у ipv4/isp/mobile — сервер продлевает по ids и игнорирует ips,
     *     адреса выпали бы из оплаченного продления;
     *   - любой выбор у резидентки — автопродление там применяется ко всему пакету
     *     (оба — _assertProlongSelection).
     * @param {string} type тип из пути: ipv4 | isp | mobile | ipv6 | mix | mix_isp | resident
     * @param {array|string|object} ipsOrIds выбор либо объект = всё тело целиком
     * @param {string} periodId
     * @param {string} coupon
     * @param {object} options
     * @return {object}
     * @throws ApiError в трёх случаях выше
     */
    prepareProlong(type, ipsOrIds, periodId, coupon, options = {}) {
        const extra = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
        const isPayload = this._isProlongPayload(ipsOrIds);
        const values = isPayload ? { ...ipsOrIds, ...extra } : extra;
        this._assertNoRemovedProlongFields(values);
        const payload = isPayload
            ? { ...this.paymentOptions() }
            : {
                ...this.paymentOptions(),
                ...this._splitProlongTargets(type, ipsOrIds),
                periodId: periodId,
                coupon: coupon
            };
        // Платёжка вызова вытесняет пару клиента целиком — см. _paymentLevel().
        const payment = this._paymentLevel(payload, values);
        for (const key of PROLONG_BODY_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(values, key)) {
                payload[key] = values[key];
            }
        }
        Object.assign(payload, payment);
        for (const key of PROLONG_SELECTION_FIELDS) {
            const list = this._prolongList(payload[key]);
            if (list.length) {
                payload[key] = list;
            } else {
                delete payload[key];
            }
        }
        this._assertProlongSelection(type, payload);
        return this.filterEmpty(this._resolveReferencePairs(payload, PROLONG_REFERENCE_PAIRS));
    }

    /**
     * orderSeparatorIds и orderSeparatorId убраны из контракта: сервер их больше не читает.
     * Молча выбросить их нельзя — вызов ушёл бы без того выбора, который задумывал вызывающий, —
     * поэтому переданное поле (даже пустое) отбивается с именем замены (orderIds). Та же логика,
     * что у удалённых полей balance/autotopup/set.
     * @param {object} values options либо объектная форма вызова
     * @throws ApiError
     */
    _assertNoRemovedProlongFields(values) {
        const has = (key) => Object.prototype.hasOwnProperty.call(values, key);
        if (has('orderSeparatorIds') || has('orderSeparatorId')) {
            throw new ApiError('`orderSeparatorIds`/`orderSeparatorId` were removed: use `orderIds`');
        }
    }

    /**
     * Проверяет уже разложенный выбор (в payload остались только непустые ids/ips/orderIds).
     *
     * Резидентка: автопродление применяется ко всему пакету, и любой выбор — ошибка. Выбросить его
     * молча нельзя: disable, адресованный паре адресов, выключил бы автопродление всего пакета.
     *
     * ipv4/isp/mobile: ids вместе с ips не отправляем — сервер продлевает по ids и игнорирует
     * ips, так что адреса молча выпали бы из оплаченного продления. У ipv6/mix/mix_isp смесь
     * допустима: id уходят в orderIds, а адреса в ips сервер отбивает сам, называя поле.
     * @param {string} type
     * @param {object} payload
     * @throws ApiError
     */
    _assertProlongSelection(type, payload) {
        const kind = this._normalizeProlongType(type);
        if (RESIDENT_PROLONG_TYPES.includes(kind)) {
            if (PROLONG_SELECTION_FIELDS.some((key) => payload[key] !== undefined)) {
                throw new ApiError(
                    'resident auto-prolong applies to the whole package: do not pass proxy or order ids ' +
                    '(pass null as the selection and no ids / ips / orderIds in options)'
                );
            }
            return;
        }
        if (!ORDER_PROLONG_TYPES.includes(kind) && payload.ids !== undefined && payload.ips !== undefined) {
            throw new ApiError(
                'Mixing proxy ids and addresses in one call is not supported: pass either ids or ' +
                `addresses. For ${kind || 'this type'} the server renews by ids and ignores ips when ` +
                'both are sent, so the addresses would silently drop out of the renewal.'
            );
        }
    }

    /**
     * Calculate the renewal. Nothing is charged.
     *
     * What is renewed depends on the type:
     *   ipv4, isp, mobile   — individual proxies. Pass the addresses exactly as proxy/list
     *                         returns them — the 'ip' field ('1.2.3.4') for ipv4/isp,
     *                         ip + ':' + port_http + ':' + port_socks for mobile — or the proxy
     *                         'id'. Addresses are sent in ips, proxy ids in ids.
     *   ipv6, mix, mix_isp  — whole orders only. Pass the 'order_id' from proxy/list or
     *                         order/list: it is sent as orderIds, and every active proxy of that
     *                         type in those orders is renewed (for mix/mix_isp — the mix packages
     *                         of those orders). ipv6 is no longer renewed by 'host:port'.
     * Each value is routed by its shape — a '.' or ':' makes it an address. For ipv4/isp/mobile
     * pass either ids or addresses in one call, not both: the server renews by ids and ignores
     * ips when both are sent, so the SDK throws instead of letting the addresses drop out of the
     * renewal. A proxy id and an order id look alike, so for ipv6/mix/mix_isp a proxy id lands in
     * orderIds and the server answers "Incorrect orderIds" (code 29); an address lands in ips and
     * the server answers "[ips] is not applicable for <type>: prolong by [orderIds]" (code 0).
     *
     * @param string type - ipv4 | isp | mobile | ipv6 | mix | mix_isp
     * @param {array|string|object} ipsOrIds addresses / ids as described above: an array (or a
     *   Set), a comma-separated string or a single value. An object here is treated as the whole
     *   payload instead.
     * @param {string} periodId ObjectId or period code (e.g. '1m') — prolong runs the same fallback
     * @param string coupon
     * @param {object} options fields with no positional slot: ids / ips / orderIds (sent as
     *   given, on top of the routed values), periodCode, paymentId/paymentCode.
     *   orderSeparatorIds and orderSeparatorId were removed from the contract: passing them
     *   throws an ApiError that names the replacement (orderIds).
     * @return object
     * @throws ApiError locally for a removed field, or for ids together with ips on
     *   ipv4/isp/mobile
     */
    async prolongCalc(type, ipsOrIds, periodId = null, coupon = '', options = {}) {
        return this.request('post', 'prolong/calc/' + this._pathSegment(type), {
            data: this.prepareProlong(type, ipsOrIds, periodId, coupon, options)
        });
    }

    /**
     * Create a renewal order. Attention! Deducts money from the balance.
     *
     * The selection works exactly as in prolongCalc(): addresses or proxy ids for ipv4/isp/mobile,
     * order ids ('order_id') for ipv6/mix/mix_isp, which are renewed only as whole orders.
     * @param string type - ipv4 | isp | mobile | ipv6 | mix | mix_isp
     * @param {array|string|object} ipsOrIds see prolongCalc(); an object is the whole payload
     * @param {string} periodId ObjectId or period code (e.g. '1m') — prolong runs the same fallback
     * @param string coupon
     * @param {object} options fields with no positional slot: ids / ips / orderIds, periodCode,
     *   paymentId/paymentCode
     * @return object {orderId, orderIds, total, listBaseOrderNumbers, balance}: orderIds lists
     *         every renewed order (one request can renew several), orderId is orderIds[0];
     *         listBaseOrderNumbers holds one base order number per renewed order (per mix
     *         package for mix/mix_isp)
     * @throws ApiError при нехватке средств: продление НЕ состоялось, причина приходит как
     *         code 16 "Insufficient funds on balance", а расчёт с warning/balance/total
     *         остаётся доступен в error.body.data. Локально, до запроса — в тех же случаях,
     *         что у prolongCalc(): удалённое поле или ids вместе с ips у ipv4/isp/mobile
     */
    async prolongMake(type, ipsOrIds, periodId = null, coupon = '', options = {}) {
        // Отдельная пост-проверка результата не нужна: нехватку средств сервер кладёт в
        // errors[{code:16}], оставляя расчёт в data, и общий разбор конверта в request()
        // бросает ApiError сам, сохранив calc-данные в error.body. Прежняя обёртка писалась под
        // форму "status:error + ПУСТОЙ errors[]" и после правки сервера умела только одно:
        // превращать легитимный success с пустым orderId в фальшивую ошибку, теряя
        // total/balance/listBaseOrderNumbers уже ПОСЛЕ списания денег.
        return this.request('post', 'prolong/make/' + this._pathSegment(type), {
            data: this.prepareProlong(type, ipsOrIds, periodId, coupon, options)
        });
    }

    /////////////////////////////// Autoprolong ///////////////////////////////

    /**
     * Тело autoprolong/*: тот же выбор, что у prolong/* (ids / ips для ipv4, isp, mobile;
     * orderIds для ipv6, mix, mix_isp; у резидентки — никакого), те же periodId/periodCode и
     * paymentId/paymentCode, плюс subscriptionId и tarifId. Те же и локальные отказы (см.
     * prepareProlong): удалённые orderSeparatorIds / orderSeparatorId, ids вместе с ips
     * у ipv4/isp/mobile и любой выбор у резидентки.
     *
     * Купона здесь нет специально: автопродление промокоды НЕ применяет нигде, и сервер
     * сознательно не передаёт coupon в расчёт — иначе превью показывало бы цену со скидкой,
     * которой в день списания не будет.
     *
     * Snake-алиасы (payment_id, subscription_id, tarif_id, tariffId) на входе принимаются, но в
     * тело уходит каноническое camelCase-написание: на сервере camelCase старше snake_case, и
     * отправлять оба сразу незачем.
     * @param {string} type тип из пути — от него зависит, в какое поле уйдёт выбор
     * @param {array|string|object} ipsOrIds выбор, как у prolongCalc(), либо объект = всё тело
     * @param {string} periodId ObjectId or period code (e.g. '1m')
     * @param {object} options subscriptionId, tarifId, ids / ips / orderIds, paymentId/paymentCode
     * @return {object}
     * @throws ApiError в случаях, перечисленных выше
     */
    prepareAutoProlong(type, ipsOrIds, periodId, options = {}) {
        const isPayload = this._isProlongPayload(ipsOrIds);
        const extra = options && typeof options === 'object' && !Array.isArray(options)
            ? options
            : {};
        const values = this._normalizeAutoProlongAliases(isPayload ? { ...ipsOrIds, ...extra } : extra);
        // Купон явно null: у prepareProlong он позиционный, а автопродлению не нужен.
        const payload = this.prepareProlong(type, isPayload ? values : ipsOrIds, periodId, null, values);
        for (const key of ['subscriptionId', 'tarifId']) {
            if (Object.prototype.hasOwnProperty.call(values, key)) {
                payload[key] = values[key];
            }
        }
        return this.filterEmpty(payload);
    }

    /**
     * Приводит snake-алиасы к каноническому написанию. Если рядом уже лежит camelCase-ключ,
     * алиас отбрасывается — тот же приоритет, что у сервера: camelCase старше snake_case.
     * @param {object} values
     * @return {object}
     */
    _normalizeAutoProlongAliases(values) {
        const normalized = {};
        for (const [key, value] of Object.entries(values)) {
            const canonical = AUTO_PROLONG_ALIASES[key] || key;
            if (canonical !== key && Object.prototype.hasOwnProperty.call(values, canonical)) {
                continue;
            }
            normalized[canonical] = value;
        }
        return normalized;
    }

    /**
     * Скрапер автопродления не имеет: трафик к нему докупается новым заказом, и сервер отвечает
     * "Create new order to add traffic, prolong options not available" — проверка стоит ДО
     * резолва типа, так что запрос отбивается целиком. Резидентки это не касается: для неё
     * autoprolong/* поддержан (type='resident'), единица правки там — пакет.
     * @param {*} type
     * @param {string} action
     * @throws ApiError
     */
    _assertAutoProlongType(type, action) {
        if (this._normalizeProlongType(type) !== 'scraper') {
            return;
        }
        throw new ApiError(
            `autoprolong/${action}/scraper is not supported: a scraper package is extended by ` +
            'buying traffic with orderMake(), so the server answers "Create new order to add ' +
            'traffic, prolong options not available".'
        );
    }

    /**
     * Платёжка для calc/enable ОБЯЗАТЕЛЬНА — в отличие от prolong/*, где её можно не слать:
     * списание произойдёт без клиента, и «по умолчанию с баланса» было бы догадкой за него.
     * Сервер отвечает "Set [paymentId]"; проверяем локально, раз остальные обязательные поля
     * SDK уже проверяет. Принимаются только balance и paddle_subscription. subscriptionId не
     * спрашиваем: с одной привязанной картой сервер берёт её сам, а сколько карт на аккаунте,
     * видно только ему ("Set [subscriptionId]", если их несколько).
     * @param {object} payload
     * @param {string} action
     * @throws ApiError
     */
    _assertAutoProlongPayment(payload, action) {
        const filled = (v) => v != null && String(v).trim() !== '';
        if (filled(payload.paymentId) || filled(payload.paymentCode)) {
            return;
        }
        throw new ApiError(
            `autoprolong/${action} requires a payment system (the server answers "Set [paymentId]"): ` +
            'the charge happens while you are away, so it cannot be guessed. Pass paymentId / ' +
            'paymentCode or set it once with setPaymentId() / setPaymentCode(); only balance and ' +
            'paddle_subscription are accepted.'
        );
    }

    /**
     * Calculate the upcoming automatic extension charge. Ничего не меняет и не списывает.
     *
     * data: warning, balance, total, quantity, currency, discount, orders, items[], days,
     * tarifId (только резидентка), chargeDate, dateEnd, paymentId (канонический КОД платёжки),
     * autoProlong. Даты — строки 'yyyy-MM-dd HH:mm:ss'.
     *
     * chargeDate — это НЕ дата окончания: сервер держит два механизма автопродления, один
     * списывает за сутки до окончания, другой в день окончания, и значение считается по
     * действующему. У резидентки chargeDate всегда null (пакет продлевается по дате ИЛИ по
     * исчерпанию трафика — одной датой это не выразить), там смотрите dateEnd.
     *
     * Нехватка баланса — НЕ исключение: приходит status="error" с ЗАПОЛНЕННЫМ data и ПУСТЫМ
     * errors[] (та же форма, что у prolong/calc), и метод вернёт расчёт с текстом в warning.
     *
     * Выбор — как у prolongCalc(): адреса или `id` прокси для ipv4/isp/mobile, `order_id` заказов
     * для ipv6/mix/mix_isp — они автопродлеваются только целым заказом, и quantity/items
     * покрывают все активные прокси этих заказов.
     * @param string type - ipv4 | isp | mobile | ipv6 | mix | mix_isp | resident
     * @param {array|string|object} ipsOrIds выбор, как описано выше; для type='resident' — null:
     *        единица правки там ПАКЕТ, тело состоит из paymentId и необязательного tarifId, а
     *        любой непустой выбор (список, ids, ips, orderIds) — локальная ApiError
     * @param {string} periodId ObjectId or period code (e.g. '1m'); резидентке не нужен —
     *        период берётся из её тарифа
     * @param {object} options subscriptionId, tarifId, ids / ips / orderIds, paymentId/paymentCode
     * @return object
     * @throws ApiError при type='scraper', без платёжки, при выборе у резидентки, при ids вместе
     *         с ips у ipv4/isp/mobile и при удалённых orderSeparatorIds / orderSeparatorId
     */
    async autoProlongCalc(type, ipsOrIds = null, periodId = null, options = {}) {
        this._assertAutoProlongType(type, 'calc');
        const payload = this.prepareAutoProlong(type, ipsOrIds, periodId, options);
        this._assertAutoProlongPayment(payload, 'calc');
        return this.request('post', 'autoprolong/calc/' + this._pathSegment(type), { data: payload });
    }

    /**
     * Enable automatic extension for proxies. Сейчас ничего не списывается — платёжка и период
     * лишь привязываются к выбранным прокси.
     *
     * data: warning, autoProlong, quantity, ids[], orderIds[], days, paymentId, chargeDate,
     * dateEnd. quantity/ids — прокси, которые РЕАЛЬНО затронуты, а не эхо запроса: у ipv6, mix
     * и mix_isp автопродление включается целым заказом, так что в ids попадают все активные
     * прокси присланных заказов; orderIds — заказы затронутых прокси, без повторов. У резидентки
     * приходит quantity=1 и пустые ids/orderIds — единица правки там пакет.
     *
     * warning заполнен, если баланса на предстоящее списание не хватит, — та же формулировка,
     * что у autoProlongCalc(). Включение при этом состоялось: деньги нужны к chargeDate, не сейчас.
     * @param string type - ipv4 | isp | mobile | ipv6 | mix | mix_isp | resident
     * @param {array|string|object} ipsOrIds выбор, как у autoProlongCalc(); для type='resident' —
     *        null (любой непустой выбор — локальная ApiError)
     * @param {string} periodId ObjectId or period code (e.g. '1m'); резидентке не нужен
     * @param {object} options subscriptionId (при paddle_subscription, если привязанных карт
     *        несколько; единственную карту сервер берёт сам), tarifId,
     *        ids / ips / orderIds, paymentId/paymentCode
     * @return object
     * @throws ApiError при type='scraper', без платёжки и в тех же случаях выбора, что у
     *         autoProlongCalc()
     */
    async autoProlongEnable(type, ipsOrIds = null, periodId = null, options = {}) {
        this._assertAutoProlongType(type, 'enable');
        const payload = this.prepareAutoProlong(type, ipsOrIds, periodId, options);
        this._assertAutoProlongPayment(payload, 'enable');
        return this.request('post', 'autoprolong/enable/' + this._pathSegment(type), { data: payload });
    }

    /**
     * Disable automatic extension for proxies. Сбрасывает и период, и платёжку, поэтому
     * ни periodId, ни paymentId здесь не нужны — только выбор (как у autoProlongCalc()).
     * Для type='resident' тело не нужно вовсе: пакет адресуется по apiKey, и выбор здесь особенно
     * опасен — disable, адресованный паре адресов, выключил бы автопродление всего пакета, поэтому
     * он отбивается локально.
     *
     * data — та же форма, что у autoProlongEnable(): ids[] затронутых прокси и orderIds[] их
     * заказов (у ipv6, mix и mix_isp — все активные прокси присланных заказов). days/paymentId/
     * chargeDate приходят null (у резидентки days остаётся — это срок её тарифа), а dateEnd
     * остаётся — прокси не исчезает, он просто перестаёт продлеваться сам.
     * @param string type - ipv4 | isp | mobile | ipv6 | mix | mix_isp | resident
     * @param {array|string|object} ipsOrIds выбор, как у autoProlongCalc(); для type='resident' —
     *        null (любой непустой выбор — локальная ApiError)
     * @param {object} options ids / ips / orderIds и прочие поля тела
     * @return object
     * @throws ApiError при type='scraper' и в тех же случаях выбора, что у autoProlongCalc()
     */
    async autoProlongDisable(type, ipsOrIds = null, options = {}) {
        this._assertAutoProlongType(type, 'disable');
        return this.request('post', 'autoprolong/disable/' + this._pathSegment(type), {
            data: this.prepareAutoProlong(type, ipsOrIds, null, options)
        });
    }

    /////////////////////////////// Proxy ///////////////////////////////

    /**
     * List of proxies
     * @param string type - ipv4 | ipv6 | mobile | isp | mix | resident | null
     * @param {*} filters latest | orderId | country | ends | page | per_page
     *                    latest: 'Y' — только прокси последнего заказа среди тех, что вернул бы
     *                    запрос: с типом — последнего заказа этого типа (mix / mix_isp —
     *                    последнего MIX), без типа — один последний заказ на весь ответ.
     *                    «Последний» — по покупке, продление не в счёт. С orderId
     *                    игнорируется, на resident и scraper не действует.
     *                    orderId — любой идентификатор заказа из ответов API: order_id
     *                    (proxyList / orderList), числовой id строки orderList (id строки
     *                    продления — её заказ) или номер: текущий order_number,
     *                    base_order_number либо прежний номер продлённого заказа (_e_<hash>)
     * @return object
     */
    async proxyList(type = null, filters = {}) {
        const params = this.filterEmpty(filters);
        const uri = type === null ? 'proxy/list' : 'proxy/list/' + this._pathSegment(type);
        return this.request('get', uri, { params: params });
    }

    /**
     * Proxy export of certain type. Отдаётся ФАЙЛОМ (attachment), не JSON-конвертом.
     *
     * @param string type - ipv4 | ipv6 | mobile | isp | mix | resident | subresident
     * @param string ext - txt | csv либо свой шаблон строки
     * @param string proto - https | socks5
     * @param string listId - только для резидентских выгрузок; не задан — отдаются IP всех листов
     * @param {*} filters country | ends | package_key
     *        package_key работает ТОЛЬКО на type='subresident'. Литеральный маршрут
     *        /proxy/download/resident знает лишь listId|id|ext|maxLine, а package_key молча
     *        игнорирует и отдаёт выгрузку РОДИТЕЛЬСКОГО пакета. По той же причине при
     *        type='resident' молча выбрасываются proto, country и ends — для резидентки
     *        берите proxyDownloadResident(), у неё есть maxLine.
     * @return string
     * @throws ApiError при package_key вместе с type='resident'
     */
    async proxyDownload(type, ext = null, proto = null, listId = null, filters = {}) {
        const extraFilters = filters && typeof filters === 'object' && !Array.isArray(filters)
            ? filters
            : {};
        if (String(type) === 'resident' && extraFilters.package_key != null) {
            throw new ApiError(
                "package_key is ignored by /proxy/download/resident and the parent package would be " +
                "exported instead. Use proxyDownload('subresident', ...) for a subpackage."
            );
        }
        const params = this.filterEmpty({
            ext: this.assertExt(ext), proto: proto, listId: listId, ...extraFilters
        });
        return this.request('get', 'proxy/download/' + this._pathSegment(type), { params: params });
    }

    /**
     * Export the resident proxy list. Отдаётся файлом (attachment).
     * @param string id list id (числовой id резидентского листа, не ObjectId). Уходит как
     *        query-параметр `id` — сервер принимает его как алиас к `listId`
     * @param string ext - txt | csv
     * @param integer maxLine
     * @return string
     */
    async proxyDownloadResident(id = null, ext = null, maxLine = null) {
        const params = this.filterEmpty({ id: id, ext: this.assertExt(ext), maxLine: maxLine });
        return this.request('get', 'proxy/download/resident', { params: params });
    }

    /**
     * Replace proxy IPs.
     *
     * @param {string|string[]} ids один ObjectId или массив ObjectId-строк IP-адресов
     * @param {string} type ПРИЧИНА замены, не тип прокси:
     *        NOT_WORK | INCORRECT_LOCATION | CANT_CHANGE_NETWORK | LOW_SPEED | CUSTOM.
     *        Сервер конвертирует её в текст обращения ("Does not work", "Incorrect location",
     *        "I want to change the network", "Low speed", свой текст для CUSTOM).
     * @param {string} comment необязателен, КРОМЕ type=CUSTOM — там обязателен непустой
     *        (сервер отвечает "Set comment", code 503)
     * @return {Promise<object>} карта статус -> {ips: [...], msg: "..."}
     * @throws ApiError при неизвестном type или пустом comment при CUSTOM
     */
    async proxyReplace(ids, type = null, comment = null) {
        const replaceType = this._assertReplaceType(type, comment);
        return this.request('post', 'proxy/replace', {
            data: { ids: ids, type: replaceType, comment: comment }
        });
    }

    /**
     * Локально повторяет серверную валидацию proxy/replace: сначала enum причины
     * (иначе сервер отвечает "Set coorect type: ..." с code 0), затем непустой comment для
     * CUSTOM. Регистр серверу не важен (значение приводится к upper case), поэтому нормализуем
     * значение сами и отправляем канонический upper case.
     * @param {*} type
     * @param {*} comment
     * @return {string}
     * @throws ApiError
     */
    _assertReplaceType(type, comment) {
        const raw = type == null ? '' : String(type).trim();
        const normalized = raw.toUpperCase();
        if (!PROXY_REPLACE_TYPES.includes(normalized)) {
            throw new ApiError(
                `proxy/replace type is the replacement reason, one of ${PROXY_REPLACE_TYPES.join(' / ')}` +
                (raw === '' ? ' (nothing was passed)' : `, got "${raw}"`)
            );
        }
        if (normalized === 'CUSTOM' && (comment == null || String(comment).trim() === '')) {
            throw new ApiError('proxy/replace with type=CUSTOM requires a non-empty comment');
        }
        return normalized;
    }

    /**
     * Set proxy comment.
     *
     * comment — поле ОБЯЗАТЕЛЬНОЕ, и очистка комментария выражается пустой строкой, а не null:
     * по умолчанию раньше уезжал comment: null, то есть заведомо неверное для контракта тело.
     * Пропущенное и null-значение трактуем как очистку ('').
     *
     * HTML-теги сервер вырезает при записи (<b>x</b> -> x), остальное — '&', кавычки, не-ASCII —
     * хранит дословно, так что «прочитал из proxy/list и записал обратно» ничего не меняет.
     * @param array ids Any id, regardless of the type of proxy
     * @param string comment пустая строка очищает комментарий
     * @return integer Count updated proxy
     */
    async proxyCommentSet(ids, comment = '') {
        return (await this.request('post', 'proxy/comment/set', {
            data: { ids: ids, comment: comment == null ? '' : comment }
        })).updated;
    }

    /////////////////////////////// Resident ///////////////////////////////

    /**
     * Package Information. Remaining traffic, end date
     * @return object
     */
    async residentPackage() {
        return this.request('get', 'resident/package');
    }

    /**
     * Traffic consumption of the resident package. Пакет сервер находит сам по apiKey,
     * ключ передавать не нужно.
     * @param {{login?: string, date_start?: string, date_end?: string}} filter
     * @return object
     */
    async residentConsumption(filter = {}) {
        return this.request('post', 'resident/consumption', { data: filter });
    }

    /**
     * Detailed traffic statistics of the resident package.
     *
     * Ключ пакета здесь называется `packageKey` (или алиас `key`), НЕ `package_key` —
     * сервер читает именно их и без ключа отвечает "key is required".
     * Остальные фильтры: login, date_start, date_end.
     * @param {{packageKey?: string, key?: string, login?: string, date_start?: string, date_end?: string}} filter
     * @return object
     */
    async residentTrafficDetails(filter = {}) {
        return this.request('post', 'resident/traffic/details', { data: filter });
    }

    /**
     * Database geo locations: страны -> регионы -> города -> ISP.
     *
     * Отдаётся ФАЙЛОМ geo.json — attachment с Content-Type: application/json, это НЕ zip
     * (внутри — geo-структура в pretty-printed JSON). Метод возвращает
     * сырые байты (Buffer/ArrayBuffer); чтобы получить объект — JSON.parse над содержимым.
     * @return binary
     */
    async residentGeo() {
        return this.request('get', 'resident/geo', { responseType: 'arraybuffer' });
    }

    /**
     * Database of ISP codes. Отдаётся файлом isp.json (attachment, application/json).
     * @return binary
     */
    async residentGeoIsp() {
        return this.request('get', 'resident/geo/isp', { responseType: 'arraybuffer' });
    }

    /**
     * Number of available IPs by geo
     * @return array
     */
    async residentGeoCount() {
        return this.request('get', 'resident/geo/count');
    }

    /**
     * List of existing ip list in a package.
     * data приходит ПЛОСКИМ массивом листов (items-враппера здесь нет).
     * id листа — числовой (Long), это не ObjectId.
     * @return array
     */
    async residentList() {
        return this.request('get', 'resident/lists');
    }

    /**
     * Create list in package.
     *
     * geo целиком опционален: сервер пропускает проверку geo, если ни country, ни region,
     * ни city, ни isp не заданы. Но части geo связаны сверху вниз — region требует country,
     * city требует region, isp требует city.
     * @param string title
     * @param string whitelist comma separated ip list
     * @param string country
     * @param string region
     * @param string city
     * @param string isp
     * @param integer rotation -1 sticky, 0 per request, 1-3600 seconds
     * @return object Created list model
     */
    async residentListAdd(title, whitelist = null, country = null, region = null, city = null,
        isp = null, rotation = null, exportOptions = null) {
        let data;
        if (title && typeof title === 'object' && !Array.isArray(title)) {
            data = { ...title };
            if (data.geo) {
                data.geo = this.filterEmpty(data.geo);
            }
        } else {
            data = this.filterEmpty({
                title: title, whitelist: whitelist, rotation: rotation, export: exportOptions
            });
            data.geo = this.filterEmpty({ country: country, region: region, city: city, isp: isp });
        }
        return this.request('post', 'resident/list/add', { data: data });
    }

    /**
     * Rename list in user package
     * @param integer id - listId
     * @param string title
     * @return object Updated list model
     */
    async residentListRename(id, title) {
        return this.request('post', 'resident/list/rename', { data: { id: id, title: title } });
    }

    /**
     * Change the rotation interval of a list
     * @param integer id - listId
     * @param integer rotation -1 sticky, 0 per request, 1-3600 seconds
     * @return object Updated list model
     */
    async residentListRotation(id, rotation) {
        return this.request('post', 'resident/list/rotation', { data: { id: id, rotation: rotation } });
    }

    /**
     * Create the tools list for the package
     * @return object
     */
    async residentListTools() {
        return this.request('put', 'resident/list/tools');
    }

    /**
     * Remove list from user package
     * @param integer id - listId
     * @return object {status: 'delete'}
     */
    async residentListDelete(id) {
        return this._deleteResult(await this.request('delete', 'resident/list/delete', { data: { id: id } }));
    }

    /////////////////////////////// Resident subpackages ///////////////////////////////

    /**
     * Create a resident subpackage.
     *
     * traffic_limit обязателен и должен быть > 0 (байты, строкой) — иначе сервер отвечает
     * "Set [traffic_limit > 0]". Проверяем локально, чтобы не платить запросом.
     * В ответе expired_at приходит ОБЪЕКТОМ PHP-даты: {date, timezone_type, timezone},
     * а не строкой.
     * @return object
     * @throws ApiError если traffic_limit не задан
     */
    async residentSubUserCreate(isLinkDate = null, rotation = null, trafficLimit = null, expiredAt = null) {
        const data = isLinkDate && typeof isLinkDate === 'object' && !Array.isArray(isLinkDate)
            ? this.filterEmpty({ ...isLinkDate })
            : this.filterEmpty({
                is_link_date: isLinkDate, rotation: rotation,
                traffic_limit: trafficLimit, expired_at: expiredAt
            });
        // Раньше здесь летел TypeError — единственное место в SDK, где ошибка была не ApiError,
        // из-за чего catch (e instanceof ApiError) её не ловил.
        if (data.traffic_limit === undefined || data.traffic_limit === null) {
            throw new ApiError('traffic_limit is required for residentsubuser/create (bytes, must be > 0)');
        }
        return this.request('post', 'residentsubuser/create', {
            data: data
        });
    }

    /**
     * Update a resident subpackage.
     * В ответе expired_at — объект PHP-даты {date, timezone_type, timezone}.
     * @return object
     */
    async residentSubUserUpdate(packageKey, isLinkDate = null, rotation = null, trafficLimit = null,
        isActive = null, expiredAt = null) {
        const data = packageKey && typeof packageKey === 'object' && !Array.isArray(packageKey)
            ? this.filterEmpty({ ...packageKey })
            : this.filterEmpty({
                package_key: packageKey, is_link_date: isLinkDate, rotation: rotation,
                traffic_limit: trafficLimit, is_active: isActive, expired_at: expiredAt
            });
        return this.request('post', 'residentsubuser/update', {
            data: data
        });
    }

    /**
     * Delete a resident subpackage
     * @return object {status: 'delete'} либо {status: 'not-found'}
     */
    async residentSubUserDelete(packageKey) {
        return this._deleteResult(await this.request('delete', 'residentsubuser/delete', { data: { package_key: packageKey } }));
    }

    /**
     * List of resident subpackages.
     * У каждого элемента expired_at — объект PHP-даты {date, timezone_type, timezone}.
     * @return array
     */
    async residentSubUserPackages() {
        return this.request('get', 'residentsubuser/packages');
    }

    /**
     * List of existing ip lists in a subpackage
     * @return array
     */
    async residentSubUserLists(packageKey = null) {
        return this.request('get', 'residentsubuser/lists', {
            params: this.filterEmpty({ package_key: packageKey })
        });
    }

    /**
     * Create a list inside a subpackage.
     *
     * package_key обязателен (без него сервер отвечает "packageKey is empty").
     * geo — опционален, но связан сверху вниз: region требует country ("Need [countryCode]"),
     * city требует region+country, isp требует city+region+country.
     * @return object
     */
    async residentSubUserListAdd(packageKey, title = null, whitelist = null, country = null,
        region = null, city = null, isp = null, rotation = null, exportOptions = null) {
        let data;
        if (packageKey && typeof packageKey === 'object' && !Array.isArray(packageKey)) {
            data = { ...packageKey };
        } else if (title && typeof title === 'object' && !Array.isArray(title)) {
            data = { package_key: packageKey, ...title };
        } else {
            data = this.filterEmpty({
                package_key: packageKey, title: title, whitelist: whitelist,
                rotation: rotation, export: exportOptions
            });
            data.geo = this.filterEmpty({
                country: country, region: region, city: city, isp: isp
            });
        }
        data = this.filterEmpty(data);
        data.geo = this.filterEmpty(data.geo || {});
        return this.request('post', 'residentsubuser/list/add', { data: data });
    }

    /**
     * Rename a list inside a subpackage
     * @return object
     */
    async residentSubUserListRename(packageKey, id, title) {
        return this.request('post', 'residentsubuser/list/rename', {
            data: { package_key: packageKey, id: id, title: title }
        });
    }

    /**
     * Change the rotation interval of a list inside a subpackage
     * @return object
     */
    async residentSubUserListRotation(packageKey, id, rotation) {
        return this.request('post', 'residentsubuser/list/rotation', {
            data: { package_key: packageKey, id: id, rotation: rotation }
        });
    }

    /**
     * Create the tools list inside a subpackage
     * @return object
     */
    async residentSubUserListTools(packageKey) {
        return this.request('put', 'residentsubuser/list/tools', { data: { package_key: packageKey } });
    }

    /**
     * Delete a list inside a subpackage
     * @return object {status: 'delete'} либо {status: 'not-found'} — сервер отдаёт not-found
     *               внутри успешного конверта, проверяйте поле status
     */
    async residentSubUserListDelete(packageKey, id) {
        return this._deleteResult(await this.request('delete', 'residentsubuser/list/delete', {
            data: { package_key: packageKey, id: id }
        }));
    }
}

export default ProxySellerUserApi;
