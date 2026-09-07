import axios from 'axios';

/**
 * Единственный тип ошибки SDK: и локальные проверки, и ошибки сервера.
 *
 * Ошибки доступа (битый ключ / IP не в allowlist / превышен лимит запросов) приходят
 * с HTTP 200 и ФИКСИРОВАННОЙ тройкой в errors[] — "Error api key", "IP not allowed <ip>",
 * "Request limit reached", все с code=503 (LegacyClientApiErrorResponseAdvice +
 * CustomHandlerInterceptor на бэкенде). Понять, что именно произошло, по errors[0] нельзя,
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
 * proxy/replace: причина замены (НЕ тип прокси). Совпадает с enum ProxyReplaceType
 * на бэкенде; сервер приводит значение к upper case перед valueOf.
 */
export const PROXY_REPLACE_TYPES = Object.freeze([
    'NOT_WORK', 'INCORRECT_LOCATION', 'CANT_CHANGE_NETWORK', 'LOW_SPEED', 'CUSTOM'
]);

/** Поля тела balance/autotopup/set. Всё опционально — это partial update. */
const AUTO_TOPUP_SET_FIELDS = Object.freeze([
    'enabled', 'threshold', 'amount', 'subscriptionId'
]);

/**
 * Убраны из контракта 18.08.2026 (AutoTopupSetRequestClientDto): сервер их больше не читает,
 * коды ошибок 54/55 удалены и не переиспользуются, ключа minDailyCountCap в customData нет.
 * Раньше SDK их отправлял — вызов проходил локальный гейт, отвечал success и не делал НИЧЕГО.
 * Отбиваем локально, чтобы тихий no-op стал видимым.
 */
const AUTO_TOPUP_REMOVED_FIELDS = Object.freeze(['dailyCountCap', 'monthlyAmountCap']);

/**
 * Пары *Id / *Code с указанием СТАРШЕЙ половины — дословно так их разбирает сервер
 * (ClientApiService.normalizeOrderReferenceCodes). payment/country/period резолвятся от кода
 * (`if (code)`), а operator/rotation/mix/tarif — от идентификатора
 * (`if (code && !trimToNull(id))`): там код применяется, только когда парный id пуст.
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
 * Пары *Id / *Code тела prolong/* и autoprolong/*: normalizeProlongReferenceCodes знает только
 * эти две, и обе резолвятся от кода.
 */
const PROLONG_REFERENCE_PAIRS = Object.freeze([
    ['periodId', 'periodCode', 'code'],
    ['paymentId', 'paymentCode', 'code']
]);

/** Имя заголовка фингерпринта — единственное место, где оно записано. */
const FINGERPRINT_HEADER = 'X-Fingerprint';

/**
 * Секции order/make, которые без фингерпринта не создаются ВООБЩЕ: OrderService
 * .createResidentOrder / .createScraperOrder отвечают 400 "Header X-Fingerprint is required"
 * ещё до расчёта цены. Остальные секции заголовок игнорируют, слать его им безопасно.
 */
const FINGERPRINT_REQUIRED_SECTIONS = Object.freeze(['resident', 'scraper']);

/**
 * Snake-алиасы тела autoprolong/*, которые сервер принимает наравне с camelCase
 * (AutoProlongRequestClientDto.applyAliases). Приводим их к каноническому написанию:
 * camelCase на сервере старше, и отправлять оба написания сразу незачем.
 */
const AUTO_PROLONG_ALIASES = Object.freeze({
    payment_id: 'paymentId',
    subscription_id: 'subscriptionId',
    tarif_id: 'tarifId',
    tariffId: 'tarifId'
});

class ProxySellerUserApi {
    URL = 'https://proxy-seller.com/personal/api/v2/';
    paymentId = null
    paymentCode = null
    generateAuth = 'N'
    fingerprint = null

    /**
     * Key placed in https://proxy-seller.com/personal/api/ — уходит в ПУТЬ запроса,
     * не в заголовок.
     *
     * config.fingerprint — значение заголовка X-Fingerprint, см. setFingerprint().
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
            timeout = 30000,
            headers = {},
            fingerprint = null,
            ...axiosConfig
        } = config;
        const apiRoot = String(baseUrl || baseURL || this.URL).replace(/\/+$/, '') + '/';

        this.baseURL = apiRoot + encodeURIComponent(key) + '/';
        this.timeout = timeout;
        this.setFingerprint(fingerprint);
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
     * Payment system id (MongoDB ObjectId from balance/payments/list).
     * For order/* and prolong/* a stable payment code is accepted here too — the server retries the
     * value as a code when it is not a valid id. balance/add takes the ObjectId only.
     * @param string id
     */
    setPaymentId(id) {
        this.paymentId = id
    }

    getPaymentId() {
        return this.paymentId
    }

    /**
     * Stable payment-system code (for example `balance`). Resolved by order/* and prolong/* only —
     * balance/add needs setPaymentId(). balance/payments/list returns id + name, no code, so the
     * codes are not discoverable through the API.
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
     * Контракт объявляет заголовок обязательным на всей операции, но реально его требуют только
     * резидентские и скраперные заказы: без него сервер отвечает
     * "Header X-Fingerprint is required" и заказ не создаётся вовсе. Прочие секции заголовок
     * игнорируют, поэтому SDK шлёт его всегда, когда значение задано.
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
     * Send request into server
     *
     * options.headers кладутся ПОВЕРХ заголовков клиента (axios мержит их с дефолтами
     * инстанса), не заменяя их: так order/make добавляет X-Fingerprint, не трогая
     * Content-Type и то, что передали в конструктор.
     * @param string method
     * @param string uri
     * @param {*} options
     * @return mixed
     * @throws Error
     */
    async request(method, uri, options = {}) {
        const { method: ignoredMethod, url: ignoredUrl, baseURL: ignoredBaseURL, ...requestOptions } = options;
        let response;
        try {
            response = await this.client.request({
                ...requestOptions,
                method: method,
                url: uri
            });
        } catch (error) {
            throw new ApiError(error?.message || 'Client API request failed', {
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
                // Calculation warnings and insufficient-funds responses intentionally use
                // status=error, errors=[], and put useful calculation details in data.
                if (response.status >= 200 && response.status < 300 &&
                    data.data !== undefined && data.data !== null) {
                    return data.data;
                }
                throw new ApiError('Client API returned an error', {
                    httpStatus: response.status,
                    body: data
                });
            }

            if (response.status < 200 || response.status >= 300) {
                throw this.toApiError(data, response.status, data);
            }
        } else if (response.status < 200 || response.status >= 300) {
            throw new ApiError(`Client API HTTP ${response.status}`, {
                httpStatus: response.status,
                body: data
            });
        }

        return data;
    }

    toApiError(error, httpStatus, body, errors = null) {
        const item = error && typeof error === 'object' ? error : {};
        return new ApiError(item.message || item.error || `Client API HTTP ${httpStatus}`, {
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

    paymentOptions() {
        return this.getPaymentCode()
            ? { paymentCode: this.getPaymentCode() }
            : { paymentId: this.getPaymentId() };
    }

    /**
     * Merge optional v2 order identifiers/codes without sending conflicting pairs.
     * Explicit per-call values take precedence over values configured on the client.
     *
     * countryId / periodId / paymentId / operatorId / mixId / tarifId accept an ObjectId OR the
     * corresponding stable code: normalizeOrderReferenceCodes on the server retries the value as
     * a code whenever it is not a valid id and the paired *Code field is empty. The separate
     * *Code fields are therefore optional, not the only way to pass a code.
     *
     * rotationId is NOT an id and has NO code: it is the rotation interval in minutes
     * (0 = By Link, 5, 10, 60...). rotationCode is only copied into rotationId after an
     * isInteger() check, so '5m' / '10m' are always rejected with
     * "Set existed [rotationCode] from reference".
     *
     * Когда заполнены обе половины пары, лишняя убирается по ПРИОРИТЕТУ СЕРВЕРА
     * (ORDER_REFERENCE_PAIRS): payment/country/period резолвятся от кода, а
     * operator/rotation/mix/tarif — от идентификатора.
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
        for (const key of allowed) {
            if (Object.prototype.hasOwnProperty.call(values, key)) {
                payload[key] = values[key];
            }
        }

        return this.filterEmpty(this._resolveReferencePairs(payload, ORDER_REFERENCE_PAIRS));
    }

    /**
     * Оставляет в теле ту половину пары *Id / *Code, которую выбрал бы сервер, и выбрасывает
     * вторую. Правило приоритета лежит в самой паре — см. ORDER_REFERENCE_PAIRS.
     *
     * Пустое значение ('' и пробелы) считается НЕзаданным. Раньше проверка была на `!= null`,
     * из-за чего `*Code: ''` стирал валидный парный `*Id`, и заказ уезжал без ссылки на
     * справочник — сервер сам трактует пустую строку как отсутствие (trimToNull).
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
     * balance/payments/list). Стабильные коды платёжных систем здесь НЕ резолвятся:
     * BalanceAddRequestClientDto знает лишь `summ` и `paymentId`, а
     * normalizeOrderReferenceCodes (то, что резолвит коды в order/prolong) в addBalance
     * не вызывается. setPaymentCode() на этот эндпоинт не влияет.
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
        const explicitId = asObject ? asObject.paymentId : paymentId;
        const explicitCode = asObject ? asObject.paymentCode : null;
        const effectiveId = explicitId ?? this.getPaymentId();

        if (effectiveId == null || String(effectiveId).trim() === '') {
            const code = explicitCode ?? this.getPaymentCode();
            if (code != null && String(code).trim() !== '') {
                throw new ApiError(
                    `balance/add does not resolve paymentCode ("${code}"): the endpoint accepts only ` +
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
            data: { summ: summ, paymentId: effectiveId }
        })).url;
    }

    /**
     * List of payment systems for balance replenishing
     * @return array
     */
    async balancePaymentsList() {
        return (await this.request('get', 'balance/payments/list')).items;
    }

    /**
     * Текущее состояние авто-пополнения баланса.
     *
     * data (AutoTopupStateClientDto): configured, enabled, state, threshold, amount,
     * subscriptionId, paymentMethod {id, status, paymentMethod, brand, last4, exp},
     * failCount, lastAttemptAt, lastEvent {status, amount, at, reason}.
     *
     * `state` — одно из NO_PAYMENT_METHOD | DISABLED | ACTIVE | PAYMENT_INVALID | PAUSED_FAILURES.
     * `lastEvent.status` — TRIGGERED | SUCCEEDED | FAILED | SKIPPED_CAP | SETTINGS_SAVED | PAUSED.
     * paymentMethod = null, если платёжный метод не привязан; lastEvent = null, если срабатываний
     * ещё не было. Лимитов dailyCountCap/monthlyAmountCap в ответе БОЛЬШЕ НЕТ — они убраны из
     * контракта 18.08.2026.
     *
     * Если фича выключена на окружении (Property enabled_autopopup_balance), приходит
     * ошибка code=49 "Auto top-up is not available".
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
     * Платёжные системы лежат отдельно, в balancePaymentsList(): там id — настоящий ObjectId,
     * и это единственное исключение: на один код шлюза приходится несколько систем.
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
     * Повторяет проверку цели из client-api v1: для ipv4/ipv6/isp заказ без цели не принимается.
     * В v1 цель задавалась targetId+targetSectionId либо своим текстом, в v2 остался только
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
     * Повторяет ClientApiService.parseMixSelection: сервер распознаёт mix не только по
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

    /**
     * Резидентский и скраперный заказы без X-Fingerprint не создаются вовсе: сервер отвечает
     * "Header X-Fingerprint is required" ещё до расчёта цены. Падаем локально — как на
     * "Set [paymentId]", — вместо заведомо отбиваемого запроса. Прочие секции заголовок
     * игнорируют, для них отсутствие значения не ошибка.
     * @param {object} json
     * @param {*} fingerprint
     * @throws ApiError
     */
    _assertFingerprint(json, fingerprint) {
        if (fingerprint != null) {
            return;
        }
        const section = json ? String(json.sectionCode) : '';
        if (!FINGERPRINT_REQUIRED_SECTIONS.includes(section)) {
            return;
        }
        throw new ApiError(
            `order/make for ${section} requires the ${FINGERPRINT_HEADER} header ` +
            '("Header X-Fingerprint is required"): pass a stable identifier of your installation ' +
            'as new ProxySellerUserApi({ key, fingerprint }), via setFingerprint(value) or as the ' +
            'second argument of orderMake(). The SDK never invents one — a value that changes ' +
            'between runs breaks the anti-fraud and affiliate attribution the header exists for.'
        );
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
     *        значение клиента (конструктор / setFingerprint), а также ключ fingerprint из json
     * @return object
     */
    async orderMake(json, fingerprint = null) {
        const taken = this._takeFingerprint(json, fingerprint);
        this.assertTargetName(taken.body);
        this._assertFingerprint(taken.body, taken.fingerprint);
        return this.request('post', 'order/make', {
            data: taken.body,
            // Заголовок шлём для ЛЮБОЙ секции: обязателен он только для резидентки и скрапера,
            // остальные его игнорируют, а анти-фрод и атрибуция от него зависят везде.
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
     * Требует X-Fingerprint: без него сервер отвечает "Header X-Fingerprint is required" и
     * пакет не создаётся. Задайте значение через setFingerprint() / конструктор либо
     * положите его в options как fingerprint — иначе SDK падает локально.
     * @param {string|object} tarifId tariff ObjectId or its code; object = whole payload
     * @param {string} coupon
     * @param {object} options fields with no positional slot: paymentId/paymentCode, tarifCode,
     *        fingerprint, ...
     */
    async orderMakeResident(tarifId, coupon = null, options = {}) {
        return this.orderMake(this.prepareResident(tarifId, coupon, options));
    }

    /////////////////////////////// Prolong ///////////////////////////////

    /**
     * Разводит то, что пришло от вызывающего, на адреса и ObjectId.
     *
     * Клиенту удобнее продлевать по самим адресам — именно их он видит в proxy/list.
     * Сервер принимает их в поле ips и сам переводит в ids
     * (ClientApiService.resolveProlongIpsToIds — безусловно и для calc, и для make).
     * Адрес содержит точку или двоеточие (ipv4/isp/mix "ip", ipv6 "ip" = "шлюз:порт",
     * mobile "ip:port_http:port_socks"), ObjectId — 24 hex-символа без них, так что
     * смешанный список тоже работает.
     *
     * У ipv6 поле "ip" из proxy/list уже содержит шлюз с портом ("1.2.3.4:26000"),
     * а "ip_only" — только шлюз, так что "ip" передаётся как есть, как и для остальных типов.
     * @param {array|string} ipsOrIds
     * @return {{ips: string[], ids: string[]}}
     */
    _splitProlongTargets(ipsOrIds) {
        const ips = [];
        const ids = [];
        let items;
        if (typeof ipsOrIds === 'string') {
            items = ipsOrIds.split(',');
        } else if (Array.isArray(ipsOrIds)) {
            items = ipsOrIds;
        } else {
            return { ips, ids };
        }
        for (const item of items) {
            if (typeof item !== 'string') {
                ids.push(item);
                continue;
            }
            const value = item.trim();
            if (!value) {
                continue;
            }
            (value.includes('.') || value.includes(':') ? ips : ids).push(value);
        }
        return { ips, ids };
    }

    prepareProlong(ids, periodId, coupon, options = {}) {
        let payload;
        let values;
        if (ids && typeof ids === 'object' && !Array.isArray(ids)) {
            payload = { ...this.paymentOptions() };
            values = { ...ids, ...options };
        } else {
            const targets = this._splitProlongTargets(ids);
            const routed = {};
            if (targets.ips.length || targets.ids.length) {
                // Пустой ids рядом с ips не ставим: сервер отдаёт приоритет ids.
                if (targets.ids.length) routed.ids = targets.ids;
                if (targets.ips.length) routed.ips = targets.ips;
            } else if (ids != null) {
                routed.ids = ids;
            }
            payload = { ...this.paymentOptions(), ...routed, periodId: periodId, coupon: coupon };
            values = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
        }
        for (const key of [
            'ids', 'ips', 'orderSeparatorIds', 'orderSeparatorId', 'coupon',
            'periodId', 'periodCode', 'paymentId', 'paymentCode'
        ]) {
            if (Object.prototype.hasOwnProperty.call(values, key)) {
                payload[key] = values[key];
            }
        }
        return this.filterEmpty(this._resolveReferencePairs(payload, PROLONG_REFERENCE_PAIRS));
    }

    /**
     * Calculate the renewal
     * @param string type - ipv4 | ipv6 | mobile | isp | mix
     * @param {array|string} ipsOrIds the addresses themselves, exactly as proxy/list returns them:
     *   the 'ip' field ('1.2.3.4') for ipv4/isp/mix/mix_isp, the 'ip' field for ipv6 too
     *   (it already carries the gateway with the port, '1.2.3.4:26000', while 'ip_only' holds
     *   the bare gateway), and ip + ':' + port_http + ':' + port_socks for mobile.
     *   ObjectId strings are accepted too, and a mixed array works — each value is routed by shape.
     *   An object here is treated as the whole payload instead.
     * @param {string} periodId ObjectId or period code (e.g. '1m') — prolong runs the same fallback
     * @param string coupon
     * @param {object} options fields with no positional slot: orderSeparatorIds, paymentId/paymentCode
     * @return object
     */
    async prolongCalc(type, ipsOrIds, periodId = null, coupon = '', options = {}) {
        return this.request('post', 'prolong/calc/' + this._pathSegment(type), {
            data: this.prepareProlong(ipsOrIds, periodId, coupon, options)
        });
    }

    /**
     * Create a renewal order. Attention! Deducts money from the balance.
     * @param string type - ipv4 | ipv6 | mobile | isp | mix
     * @param {array|string} ipsOrIds the addresses themselves, exactly as proxy/list returns them:
     *   the 'ip' field ('1.2.3.4') for ipv4/isp/mix/mix_isp, the 'ip' field for ipv6 too
     *   (it already carries the gateway with the port, '1.2.3.4:26000', while 'ip_only' holds
     *   the bare gateway), and ip + ':' + port_http + ':' + port_socks for mobile.
     *   ObjectId strings are accepted too, and a mixed array works — each value is routed by shape.
     *   An object here is treated as the whole payload instead.
     * @param {string} periodId ObjectId or period code (e.g. '1m') — prolong runs the same fallback
     * @param string coupon
     * @return object {orderId, total, balance, listBaseOrderNumbers}
     * @throws ApiError при нехватке средств: продление НЕ состоялось, причина приходит как
     *         code 16 "Insufficient funds on balance", а расчёт с warning/balance/total
     *         остаётся доступен в error.body.data
     */
    async prolongMake(type, ipsOrIds, periodId = null, coupon = '', options = {}) {
        // Отдельная пост-проверка результата больше не нужна: нехватку средств сервер кладёт
        // в errors[{code:16}] (ProlongMakeResponseClientDto.ofInsufficientFunds), и общий
        // разбор конверта в request() бросает ApiError сам, сохранив calc-данные в error.body.
        // Прежняя обёртка писалась под форму "status:error + ПУСТОЙ errors[]" и после правки
        // сервера умела только одно: превращать легитимный success с пустым orderId в
        // фальшивую ошибку, теряя total/balance/listBaseOrderNumbers уже ПОСЛЕ списания денег.
        return this.request('post', 'prolong/make/' + this._pathSegment(type), {
            data: this.prepareProlong(ipsOrIds, periodId, coupon, options)
        });
    }

    /////////////////////////////// Autoprolong ///////////////////////////////

    /**
     * Тело autoprolong/*: то же, что у prolong/* (ids/ips/orderSeparatorIds,
     * periodId/periodCode, paymentId/paymentCode), плюс subscriptionId и tarifId.
     *
     * Купона здесь нет специально: автопродление промокоды НЕ применяет нигде, и сервер
     * сознательно не передаёт coupon в расчёт — иначе превью показывало бы цену со скидкой,
     * которой в день списания не будет.
     *
     * Snake-алиасы (payment_id, subscription_id, tarif_id, tariffId) на входе принимаются, но в
     * тело уходит каноническое camelCase-написание: на сервере camelCase старше snake_case, и
     * отправлять оба сразу незачем.
     * @param {array|string|object} ipsOrIds адреса/ObjectId, либо объект = всё тело целиком
     * @param {string} periodId ObjectId or period code (e.g. '1m')
     * @param {object} options subscriptionId, tarifId, orderSeparatorIds, paymentId/paymentCode
     * @return {object}
     */
    prepareAutoProlong(ipsOrIds, periodId, options = {}) {
        const isPayload = ipsOrIds && typeof ipsOrIds === 'object' && !Array.isArray(ipsOrIds);
        const extra = options && typeof options === 'object' && !Array.isArray(options)
            ? options
            : {};
        const values = this._normalizeAutoProlongAliases(isPayload ? { ...ipsOrIds, ...extra } : extra);
        // Купон явно null: у prepareProlong он позиционный, а автопродлению не нужен.
        const payload = this.prepareProlong(isPayload ? values : ipsOrIds, periodId, null, values);
        for (const key of ['subscriptionId', 'tarifId']) {
            if (Object.prototype.hasOwnProperty.call(values, key)) {
                payload[key] = values[key];
            }
        }
        return this.filterEmpty(payload);
    }

    /**
     * Приводит snake-алиасы к каноническому написанию. Если рядом уже лежит camelCase-ключ,
     * алиас отбрасывается — тот же приоритет, что у AutoProlongRequestClientDto.applyAliases.
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
     * резолва типа, так что запрос отбивается целиком. Резидентка сюда НЕ попадает: её
     * autoprolong обслуживает ClientApiAutoProlongRouter, там тип поддержан.
     * @param {*} type
     * @param {string} action
     * @throws ApiError
     */
    _assertAutoProlongType(type, action) {
        if (String(type == null ? '' : type).trim().toLowerCase() !== 'scraper') {
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
     * SDK уже проверяет. Принимаются только balance и paddle_subscription.
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
            'paddle_subscription are accepted, and paddle_subscription also needs subscriptionId.'
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
     * @param string type - ipv4 | ipv6 | mobile | isp | mix | mix_isp | resident
     * @param {array|string|object} ipsOrIds адреса/ObjectId; для type='resident' не нужны —
     *        единица правки там ПАКЕТ, тело состоит из paymentId и необязательного tarifId
     * @param {string} periodId ObjectId or period code (e.g. '1m'); резидентке не нужен —
     *        период берётся из её тарифа
     * @param {object} options subscriptionId, tarifId, orderSeparatorIds, paymentId/paymentCode
     * @return object
     * @throws ApiError при type='scraper' и без платёжки
     */
    async autoProlongCalc(type, ipsOrIds = null, periodId = null, options = {}) {
        this._assertAutoProlongType(type, 'calc');
        const payload = this.prepareAutoProlong(ipsOrIds, periodId, options);
        this._assertAutoProlongPayment(payload, 'calc');
        return this.request('post', 'autoprolong/calc/' + this._pathSegment(type), { data: payload });
    }

    /**
     * Enable automatic extension for proxies. Сейчас ничего не списывается — платёжка и период
     * лишь привязываются к выбранным прокси.
     *
     * data: autoProlong, quantity, ids[], days, paymentId, chargeDate, dateEnd.
     * quantity/ids — то, что РЕАЛЬНО затронуто, а не эхо запроса: у ipv6 автопродление
     * включается целым заказом, так что один адрес включает их все. У резидентки приходит
     * quantity=1 и пустой ids — единица правки там пакет.
     * @param string type - ipv4 | ipv6 | mobile | isp | mix | mix_isp | resident
     * @param {array|string|object} ipsOrIds адреса/ObjectId; для type='resident' не нужны
     * @param {string} periodId ObjectId or period code (e.g. '1m'); резидентке не нужен
     * @param {object} options subscriptionId (обязателен для paddle_subscription), tarifId,
     *        orderSeparatorIds, paymentId/paymentCode
     * @return object
     * @throws ApiError при type='scraper' и без платёжки
     */
    async autoProlongEnable(type, ipsOrIds = null, periodId = null, options = {}) {
        this._assertAutoProlongType(type, 'enable');
        const payload = this.prepareAutoProlong(ipsOrIds, periodId, options);
        this._assertAutoProlongPayment(payload, 'enable');
        return this.request('post', 'autoprolong/enable/' + this._pathSegment(type), { data: payload });
    }

    /**
     * Disable automatic extension for proxies. Сбрасывает и период, и платёжку, поэтому
     * ни periodId, ни paymentId здесь не нужны — только выбор прокси. Для type='resident'
     * тело не нужно вовсе: пакет адресуется по apiKey.
     *
     * В ответе days/paymentId/chargeDate приходят null, а dateEnd остаётся — прокси не
     * исчезает, он просто перестаёт продлеваться сам.
     * @param string type - ipv4 | ipv6 | mobile | isp | mix | mix_isp | resident
     * @param {array|string|object} ipsOrIds адреса/ObjectId; для type='resident' не нужны
     * @param {object} options orderSeparatorIds и прочие поля тела
     * @return object
     * @throws ApiError при type='scraper'
     */
    async autoProlongDisable(type, ipsOrIds = null, options = {}) {
        this._assertAutoProlongType(type, 'disable');
        return this.request('post', 'autoprolong/disable/' + this._pathSegment(type), {
            data: this.prepareAutoProlong(ipsOrIds, null, options)
        });
    }

    /////////////////////////////// Proxy ///////////////////////////////

    /**
     * List of proxies
     * @param string type - ipv4 | ipv6 | mobile | isp | mix | resident | null
     * @param {*} filters latest | orderId | country | ends | page | per_page
     *                    orderId — ObjectId-строка, не число
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
     *        /proxy/download/resident обслуживается ResidentUserController.downloadProxyList,
     *        который знает лишь listId|id|ext|maxLine, а package_key молча игнорирует и отдаёт
     *        выгрузку РОДИТЕЛЬСКОГО пакета. По той же причине при type='resident' молча
     *        выбрасываются proto, country и ends — для резидентки берите
     *        proxyDownloadResident(), у неё есть maxLine.
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
     *        query-параметр `id` — контроллер принимает его как алиас к `listId`
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
     * Локально повторяет валидацию ClientApiService.replaceProxies: сначала enum причины
     * (иначе сервер отвечает "Set coorect type: ..." с code 0), затем непустой comment для
     * CUSTOM. Регистр сервер не важен (valueOf(value.toUpperCase())), поэтому нормализуем
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
     * ResidentUserApiService.getTrafficDetails читает именно их и без него отвечает
     * "key is required". Остальные фильтры: login, date_start, date_end.
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
     * (downloadGeoFile сериализует geo-структуру в pretty-printed JSON). Метод возвращает
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
     * geo целиком опционален: validateCreateListGeo выходит сразу, если ни country, ни region,
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
     * package_key обязателен (checkSubPackageListLimit падает с "packageKey is empty").
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
