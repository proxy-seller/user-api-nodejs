#!/usr/bin/env node
/**
 * Самопроверка SDK без сети: локальные гейты, сборка тел запросов и очередь запросов.
 * Ни один кейс не ходит в интернет: проверки либо синхронные, либо падают до отправки
 * запроса, либо подменяют request(), либо — для очереди — подменяют транспорт (adapter
 * axios) и крутят виртуальное время, так что ни одна пауза очереди не ждётся по-настоящему.
 *
 * Запуск: npm test
 */
import ProxySellerUserApi, { ApiError, PROXY_REPLACE_TYPES } from '../index.js';

let passed = 0;
const failures = [];

/**
 * Проверка может быть и синхронной, и асинхронной: async-методы SDK бросают ApiError
 * внутри async-функции, то есть возвращают отклонённый промис, а не кидают наружу.
 * Поэтому результат всегда await-им.
 */
async function check(name, fn) {
    try {
        await fn();
        passed++;
    } catch (e) {
        failures.push(`${name}: ${e && e.message ? e.message : e}`);
    }
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message || 'assertion failed');
    }
}

function assertEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    assert(a === b, `${message || 'values differ'}: expected ${b}, got ${a}`);
}

/** Сравнение тел запросов без учёта порядка ключей: важен состав тела, а не порядок полей. */
function assertBody(actual, expected, message) {
    const sorted = (value) => Object.fromEntries(Object.keys(value || {}).sort().map((key) => [key, value[key]]));
    assertEqual(sorted(actual), sorted(expected), message || 'request body differs');
}

/**
 * Ожидаем ApiError (а не TypeError/Error) из синхронного или асинхронного вызова.
 * Важно именно ApiError: единый тип ошибок — часть публичного контракта SDK.
 */
async function expectApiError(fn, substring) {
    let error = null;
    let resolved = false;
    try {
        await fn();
        resolved = true;
    } catch (e) {
        error = e;
    }
    assert(!resolved, 'expected ApiError, call succeeded instead');
    assert(error instanceof ApiError,
        `expected ApiError, got ${error && error.name}: ${error && error.message}`);
    if (substring) {
        assert(String(error.message).includes(substring),
            `message must contain "${substring}", got "${error.message}"`);
    }
}

/**
 * Перехватывает request(), чтобы проверить СОБРАННЫЙ запрос (URI, тело, заголовки), не выходя
 * в сеть: настоящий вызов не делается, вместо ответа отдаётся заглушка.
 * @return {array} перехваченные вызовы {method, uri, options}
 */
async function captureRequest(client, fn, response = {}) {
    const calls = [];
    client.request = async (method, uri, options = {}) => {
        calls.push({ method: method, uri: uri, options: options });
        return response;
    };
    try {
        await fn();
    } finally {
        delete client.request;
    }
    return calls;
}

const api = new ProxySellerUserApi({ key: 'SELFCHECK_KEY' });

// id прокси (поле id из proxy/list) и id заказа (order_id из proxy/list / order/list):
// оба ObjectId, по форме их не отличить — поле выбора задаёт тип.
const PROXY_ID = '68b1f0c4e13a4c0f1a2b3c4d';
const ORDER_ID = '6a248de4717805635cf6057d';
const ORDER_ID_2 = '6a248de4717805635cf6058a';

/////////////////////////////// assertTargetName ///////////////////////////////

await check('assertTargetName: ipv4 без цели падает', () =>
    expectApiError(() => api.assertTargetName({ sectionCode: 'ipv4' }), 'customTargetName is required'));

await check('assertTargetName: ipv4 с целью проходит', () => {
    api.assertTargetName({ sectionCode: 'ipv4', customTargetName: 'scraping' });
});

await check('assertTargetName: ipv6 требует цель', () =>
    expectApiError(() => api.assertTargetName({ sectionCode: 'ipv6' })));

await check('assertTargetName: isp требует цель', () =>
    expectApiError(() => api.assertTargetName({ sectionCode: 'isp' })));

await check('assertTargetName: resident/mobile цель не требуют', () => {
    api.assertTargetName({ sectionCode: 'resident' });
    api.assertTargetName({ sectionCode: 'mobile' });
});

await check('assertTargetName: mix через mixId/mixCode освобождает от цели', () => {
    api.assertTargetName({ sectionCode: 'mix', mixId: 'MIX_ID' });
    api.assertTargetName({ sectionCode: 'mix', mixCode: 'mix-us-eu' });
});

await check('assertTargetName: mix через countryId + quantity освобождает от цели', () => {
    api.assertTargetName({ sectionCode: 'mix', countryId: 'PACKAGE_ID', quantity: 2 });
});

await check('assertTargetName: mix через countryId со ":" освобождает от цели', () => {
    api.assertTargetName({ sectionCode: 'mix', countryId: 'PACKAGE_ID:5' });
});

await check('assertTargetName: mix без mix-признаков всё ещё требует цель', () =>
    expectApiError(() => api.assertTargetName({ sectionCode: 'mix' })));

await check('assertTargetName: mix с quantity=0 требует цель', () =>
    expectApiError(() => api.assertTargetName({ sectionCode: 'mix', countryId: 'PACKAGE_ID', quantity: 0 })));

await check('assertTargetName: mix_isp с countryId+quantity проходит', () => {
    api.assertTargetName({ sectionCode: 'mix_isp', countryId: 'PACKAGE_ID', quantity: 1 });
});

await check('assertTargetName: mix_isp без признаков требует цель', () =>
    expectApiError(() => api.assertTargetName({ sectionCode: 'mix_isp' })));

await check('assertTargetName: пустая строка в цели не считается заполненной', () =>
    expectApiError(() => api.assertTargetName({ sectionCode: 'ipv4', customTargetName: '   ' })));

/////////////////////////////// примеры из README ///////////////////////////////

// Коды уходят ПОЗИЦИОННО в *Id: сервер резолвит значение как код, если это не валидный
// ObjectId и парный *Code пуст. Цепочки null и options ради кодов не нужны — эти проверки
// фиксируют именно те вызовы, что показаны в README.
// Заказ и продление оплачиваются только кодом balance или paddle_subscription:
// balance/payments/list — это системы пополнения, и самого баланса в нём нет.
await check('README: ipv4 позиционно с кодами и целью, оплата кодом balance', () => {
    const local = new ProxySellerUserApi({ key: 'K' });
    local.setPaymentCode('balance');
    const payload = local.prepareRegular('ipv4', 'USA', '1m', 2, null, null, 'scraping');
    local.assertTargetName(payload);
    assertBody(payload, {
        paymentCode: 'balance', sectionCode: 'ipv4', countryId: 'USA',
        periodId: '1m', quantity: 2, customTargetName: 'scraping'
    });
});

await check('README: оплата привязанной картой — код paddle_subscription, без paymentId', () => {
    const local = new ProxySellerUserApi({ key: 'K' });
    local.setPaymentCode('paddle_subscription');
    const payload = local.prepareResident('1-gb');
    assertEqual(payload.paymentCode, 'paddle_subscription', 'paymentCode lost');
    assert(!('paymentId' in payload), `paymentId must not be sent next to paymentCode, got ${JSON.stringify(payload)}`);
});

await check('README: разовый paymentCode в options уходит в заказ и продление', () => {
    const payload = api.prepareRegular('ipv4', 'USA', '1m', 1, null, null, 'scraping', { paymentCode: 'balance' });
    assertEqual(payload.paymentCode, 'balance', 'order: paymentCode lost');
    const prolong = api.prepareProlong('ipv4', [PROXY_ID], '1m', '', { paymentCode: 'balance' });
    assertEqual(prolong.paymentCode, 'balance', 'prolong: paymentCode lost');
});

await check('README: ipv4 без цели падает локально (старый пример был сломан)', () =>
    expectApiError(
        () => api.assertTargetName(api.prepareRegular('ipv4', { countryCode: 'USA', periodCode: '1m', quantity: 2 })),
        'customTargetName is required'
    ));

// rotationId — МИНУТЫ (0 = By Link), а не код: '5m'/'10m' сервер отвергает
// ("Set existed [rotationCode] from reference"), потому что rotationCode принимается только
// целым числом.
await check('README: mobile позиционно, rotationId числом', () => {
    const local = new ProxySellerUserApi({ key: 'K' });
    local.setPaymentCode('balance');
    assertBody(
        local.prepareMobile('USA', '1m', 1, null, null, 'OPERATOR_ID', 10),
        {
            paymentCode: 'balance', sectionCode: 'mobile', countryId: 'USA',
            periodId: '1m', quantity: 1, operatorId: 'OPERATOR_ID', rotationId: 10,
            mobileServiceType: 'dedicated'
        }
    );
});

await check('README: rotationId=0 (By Link) не отбрасывается как пустое', () => {
    const payload = api.prepareMobile('USA', '1m', 1, null, null, 'OPERATOR_ID', 0, 'shared');
    assertEqual(payload.rotationId, 0, 'rotationId=0 must survive');
    assertEqual(payload.mobileServiceType, 'shared', 'mobileServiceType lost');
});

await check('README: mix принимает код пакета и его ObjectId', () => {
    for (const identifier of ['europe-2-mix_IPv4', '68b1f0c4e13a4c0f1a2b3c4d']) {
        const payload = api.prepareMix(identifier, '1m', 1);
        api.assertTargetName(payload);
        assertEqual(payload.mixId, identifier, 'mixId lost');
    }
});

await check('README: prolong ipv4 по адресам с кодом периода и купоном', () => {
    assertEqual(
        api.prepareProlong('ipv4', ['1.2.3.4', '5.6.7.8'], '1m', 'SALE10'),
        { ips: ['1.2.3.4', '5.6.7.8'], periodId: '1m', coupon: 'SALE10' }
    );
});

await check('README: ipv6 продлевается целым заказом — Set из order_id уходит в orderIds', () => {
    assertBody(
        api.prepareProlong('ipv6', new Set([ORDER_ID, ORDER_ID_2, ORDER_ID]), '1m', ''),
        { orderIds: [ORDER_ID, ORDER_ID_2], periodId: '1m', coupon: '' }
    );
});

await check('README: объектная форма для mix — orderIds, период и купон как переданы', () => {
    assertBody(
        api.prepareProlong('mix', { orderIds: ['ORDER_ID'], periodId: '1m', coupon: 'SALE10' }),
        { orderIds: ['ORDER_ID'], periodId: '1m', coupon: 'SALE10' }
    );
});

await check('README: autoprolong ipv6 включается по order_id', () => {
    assertBody(
        api.prepareAutoProlong('ipv6', ['ORDER_ID'], '1m', { paymentId: 'balance' }),
        { paymentId: 'balance', orderIds: ['ORDER_ID'], periodId: '1m' }
    );
});

/////////////////////////////// _deleteResult ///////////////////////////////

await check('_deleteResult: строка "delete" -> {status}', () => {
    assertEqual(api._deleteResult('delete'), { status: 'delete' });
});

await check('_deleteResult: JSON внутри строки разбирается', () => {
    assertEqual(api._deleteResult('{"status":"not-found"}'), { status: 'not-found' });
});

await check('_deleteResult: объект остаётся как есть', () => {
    assertEqual(api._deleteResult({ status: 'delete' }), { status: 'delete' });
});

await check('_deleteResult: null -> {}', () => {
    assertEqual(api._deleteResult(null), {});
});

await check('_deleteResult: битый JSON заворачивается в status', () => {
    assertEqual(api._deleteResult('{not json'), { status: '{not json' });
});

/////////////////////////////// autotopup ///////////////////////////////

await check('autotopup set: только переданные поля уходят в тело', () => {
    assertEqual(api._autoTopupSetBody({ threshold: 20 }), { threshold: 20 });
});

await check('autotopup set: undefined/null поля не уезжают как null', () => {
    assertEqual(
        api._autoTopupSetBody({ enabled: true, threshold: undefined, amount: null }),
        { enabled: true }
    );
});

await check('autotopup set: enabled=false сохраняется (не путать с пустым)', () => {
    assertEqual(api._autoTopupSetBody({ enabled: false }), { enabled: false });
});

await check('autotopup set: неизвестные поля отбрасываются', () => {
    assertEqual(api._autoTopupSetBody({ amount: 10, whatever: 1 }), { amount: 10 });
});

await check('autotopup set: полный набор полей доезжает целиком', () => {
    assertEqual(
        api._autoTopupSetBody({
            enabled: true, threshold: 5, amount: 25, subscriptionId: 'sub_1'
        }),
        {
            enabled: true, threshold: 5, amount: 25, subscriptionId: 'sub_1'
        }
    );
});

// dailyCountCap/monthlyAmountCap убраны из контракта 18.08.2026: сервер их молча
// игнорирует, поэтому отправка выглядела бы успехом, ничего не изменившим. Отбиваем
// по имени — ровно то, ради чего белый список полей и существует.
await check('autotopup set: удалённые из контракта лимиты отбиваются по имени', () => {
    for (const field of ['dailyCountCap', 'monthlyAmountCap']) {
        let threw = false;
        try { api._autoTopupSetBody({ [field]: 3 }); } catch { threw = true; }
        if (!threw) throw new Error(`${field} обязан отбиваться локально`);
    }
});

await check('autotopup set: пустое тело — локальная ApiError', () =>
    expectApiError(() => api._autoTopupSetBody({}), 'partial update'));

await check('autotopup set: только неизвестные поля — локальная ApiError', () =>
    expectApiError(() => api._autoTopupSetBody({ nope: 1 }), 'partial update'));

await check('autotopup: методы объявлены', () => {
    assert(typeof api.balanceAutoTopupGet === 'function', 'balanceAutoTopupGet missing');
    assert(typeof api.balanceAutoTopupSet === 'function', 'balanceAutoTopupSet missing');
});

/////////////////////////////// proxy/replace ///////////////////////////////

await check('proxyReplace: enum причин экспортирован целиком', () => {
    assertEqual(PROXY_REPLACE_TYPES,
        ['NOT_WORK', 'INCORRECT_LOCATION', 'CANT_CHANGE_NETWORK', 'LOW_SPEED', 'CUSTOM']);
});

await check('proxyReplace: валидная причина нормализуется в upper case', () => {
    assertEqual(api._assertReplaceType('not_work', null), 'NOT_WORK');
    assertEqual(api._assertReplaceType('  LOW_SPEED  ', null), 'LOW_SPEED');
});

await check('proxyReplace: неизвестная причина падает локально', () =>
    expectApiError(() => api._assertReplaceType('ipv4', null), 'replacement reason'));

await check('proxyReplace: отсутствующая причина падает локально', () =>
    expectApiError(() => api._assertReplaceType(null, null), 'nothing was passed'));

await check('proxyReplace: CUSTOM без comment падает локально', () =>
    expectApiError(() => api._assertReplaceType('CUSTOM', null), 'non-empty comment'));

await check('proxyReplace: CUSTOM с пробельным comment падает локально', () =>
    expectApiError(() => api._assertReplaceType('CUSTOM', '   '), 'non-empty comment'));

await check('proxyReplace: CUSTOM с comment проходит', () => {
    assertEqual(api._assertReplaceType('custom', 'ip blocked by target'), 'CUSTOM');
});

/////////////////////////////// balance/add ///////////////////////////////

await check('balanceAdd: paymentCode без paymentId — понятная локальная ошибка', () => {
    const local = new ProxySellerUserApi({ key: 'K' });
    local.setPaymentCode('balance');
    return expectApiError(() => local.balanceAdd(10), 'does not resolve paymentCode');
});

await check('balanceAdd: без платёжных данных вообще — тоже локальная ошибка', () => {
    const local = new ProxySellerUserApi({ key: 'K' });
    return expectApiError(() => local.balanceAdd(10), 'requires paymentId');
});

/////////////////////////////// ext / пути ///////////////////////////////

await check('assertExt: слишком длинный ext падает ApiError', () =>
    expectApiError(() => api.assertExt('x'.repeat(251)), 'too long'));

await check('assertExt: CR/LF/слэши запрещены', async () => {
    for (const bad of ['a\rb', 'a\nb', 'a/b', 'a\\b']) {
        await expectApiError(() => api.assertExt(bad), 'forbidden characters');
    }
});

await check('assertExt: допустимый шаблон проходит', () => {
    assertEqual(api.assertExt('$ip:$port@$user:$pass'), '$ip:$port@$user:$pass');
});

await check('_pathSegment: опасные символы кодируются', () => {
    assertEqual(api._pathSegment('ipv4'), 'ipv4');
    assertEqual(api._pathSegment('a/b'), 'a%2Fb');
    assertEqual(api._pathSegment('a b#c'), 'a%20b%23c');
});

await check('proxyDownload: package_key на type=resident падает локально', () =>
    expectApiError(
        () => api.proxyDownload('resident', 'txt', null, null, { package_key: 'KEY' }),
        'subresident'
    ));

/////////////////////////////// ApiError ///////////////////////////////

await check('ApiError: весь массив errors доступен', () => {
    const triple = [
        { message: 'Error api key', code: 503 },
        { message: 'IP not allowed 1.2.3.4', code: 503 },
        { message: 'Request limit reached', code: 503 }
    ];
    const error = api.toApiError(triple[0], 200, { status: 'error', data: null, errors: triple }, triple);
    assert(error instanceof ApiError, 'not an ApiError');
    assertEqual(error.errors.length, 3, 'errors array must be preserved');
    assertEqual(error.errors[2].message, 'Request limit reached', 'third error lost');
    assertEqual(error.message, 'Error api key', 'message must come from errors[0]');
});

await check('ApiError: customData доступна (границы autotopup 50/51/54)', () => {
    const item = { message: 'Top-up amount must be 5 or more', code: 51, customData: { minAmount: 5 } };
    const error = api.toApiError(item, 200, { status: 'error', errors: [item] }, [item]);
    assertEqual(error.code, 51, 'code lost');
    assertEqual(error.customData, { minAmount: 5 }, 'customData lost');
});

await check('ApiError: errors по умолчанию массив, а не null', () => {
    const error = new ApiError('local failure');
    assertEqual(error.errors, [], 'errors must default to []');
});

/////////////////////////////// baseURL ///////////////////////////////

await check('constructor: apiKey кодируется в baseURL', () => {
    const local = new ProxySellerUserApi({ key: 'a b/c' });
    assert(local.baseURL.endsWith('/a%20b%2Fc/'), `unexpected baseURL: ${local.baseURL}`);
});

await check('constructor: без key — ApiError', () =>
    expectApiError(() => new ProxySellerUserApi({}), 'Need key'));

/////////////////////////////// X-Fingerprint ///////////////////////////////

// Заголовок необязателен: заказы по API-ключу сервер создаёт и без него, резидентские и
// скраперные тоже. SDK шлёт его, когда значение задано, и никогда не падает без него.
const FINGERPRINT_HEADER = 'X-Fingerprint';

await check('fingerprint: resident и scraper без значения не падают и уходят без заголовка', async () => {
    const client = new ProxySellerUserApi({ key: 'k' });
    const calls = await captureRequest(client, async () => {
        await client.orderMakeResident('1-gb');
        await client.orderMake({ sectionCode: 'scraper', tarifId: 'scraper-1' });
    });
    assertEqual(calls.length, 2, 'both orders must be sent');
    for (const call of calls) {
        assertEqual(call.uri, 'order/make', 'path');
        assert(!call.options.headers, `no header expected, got ${JSON.stringify(call.options.headers)}`);
        assert(!('fingerprint' in call.options.data), 'fingerprint must never be in the body');
    }
});

await check('fingerprint: значение клиента уходит заголовком в любой секции', async () => {
    const client = new ProxySellerUserApi({ key: 'k', fingerprint: '  install-1  ' });
    const calls = await captureRequest(client, async () => {
        await client.orderMakeResident('1-gb');
        await client.orderMake({ sectionCode: 'scraper', tarifId: 'scraper-1' });
        await client.orderMakeIpv4('USA', '1m', 1, null, null, 'scraping');
    });
    assertEqual(calls.length, 3, 'all orders must be sent');
    for (const call of calls) {
        assertEqual(call.options.headers, { [FINGERPRINT_HEADER]: 'install-1' }, 'client value must be sent trimmed');
    }
});

await check('fingerprint: аргумент вызова и ключ в options старше значения клиента', async () => {
    const client = new ProxySellerUserApi({ key: 'k', fingerprint: 'client' });
    const calls = await captureRequest(client, async () => {
        await client.orderMake({ sectionCode: 'resident', tarifId: '1-gb', fingerprint: 'inline' }, 'explicit');
        await client.orderMakeResident('1-gb', null, { fingerprint: 'from-options' });
    });
    assertEqual(calls[0].options.headers, { [FINGERPRINT_HEADER]: 'explicit' }, 'explicit argument must win');
    assertEqual(calls[1].options.headers, { [FINGERPRINT_HEADER]: 'from-options' }, 'options value must beat the client one');
    for (const call of calls) {
        assert(!('fingerprint' in call.options.data), 'fingerprint must never be in the body');
    }
});

await check('fingerprint: пустая строка и пробелы — значение не задано, заголовка нет', async () => {
    const client = new ProxySellerUserApi({ key: 'k', fingerprint: '   ' });
    assertEqual(client.getFingerprint(), null, 'blank client value must count as not set');
    const calls = await captureRequest(client, async () => {
        await client.orderMakeResident('1-gb', null, { fingerprint: '' });
        await client.orderMakeResident('1-gb', null, { fingerprint: '  \t ' });
        await client.orderMake({ sectionCode: 'scraper', tarifId: 'scraper-1' }, '   ');
    });
    assertEqual(calls.length, 3, 'all orders must be sent');
    for (const call of calls) {
        assert(!call.options.headers, `no header expected, got ${JSON.stringify(call.options.headers)}`);
        assert(!('fingerprint' in call.options.data), 'fingerprint must never be in the body');
    }
});

await check('fingerprint: order/calc заголовок не шлёт и поле из тела вынимает', async () => {
    const client = new ProxySellerUserApi({ key: 'k', fingerprint: 'install-1' });
    const calls = await captureRequest(client, () => client.orderCalcResident('1-gb', null, { fingerprint: 'x' }));
    assertEqual(calls[0].uri, 'order/calc', 'path');
    assert(!calls[0].options.headers, 'order/calc must not send the header');
    assert(!('fingerprint' in calls[0].options.data), 'fingerprint must not be in the body');
});

/////////////////////////////// prolong: выбор зависит от типа ///////////////////////////////

// ipv4 / isp / mobile продлеваются по отдельным прокси: адрес -> ips, id прокси -> ids.
// ipv6 / mix / mix_isp — только целыми заказами: order_id -> orderIds. orderSeparatorIds и
// orderSeparatorId сервер больше не читает — SDK не шлёт их ни при каком вызове, а переданные
// отбивает локально с именем замены (orderIds).
const REMOVED_PROLONG_FIELDS = ['orderSeparatorIds', 'orderSeparatorId'];

function assertNoRemovedFields(payload) {
    for (const field of REMOVED_PROLONG_FIELDS) {
        assert(!(field in payload), `${field} must never be sent, got ${JSON.stringify(payload)}`);
    }
}

const prolongClient = new ProxySellerUserApi({ key: 'k' });

// Тела сверяются целиком (assertBody): так в них не пролезет ни одно поле сверх контракта.
await check('prolong ipv4: адреса уезжают в ips, пустого ids рядом нет', () => {
    const payload = prolongClient.prepareProlong('ipv4', ['1.2.3.4', '5.6.7.8'], '1m', '');
    assertBody(payload, { ips: ['1.2.3.4', '5.6.7.8'], periodId: '1m', coupon: '' }, 'ipv4 by address');
    assertNoRemovedFields(payload);
});

await check('prolong ipv4: id прокси уезжает в ids, а не в orderIds', () => {
    const payload = prolongClient.prepareProlong('ipv4', [PROXY_ID], '1m', '');
    assertBody(payload, { ids: [PROXY_ID], periodId: '1m', coupon: '' }, 'ipv4 by id');
    assertNoRemovedFields(payload);
});

// Сервер продлевает по ids и игнорирует ips, когда пришли оба: адреса молча выпали бы из
// оплаченного продления. Поэтому смесь id и адресов у ipv4/isp/mobile — локальная ошибка,
// откуда бы ни пришли обе половины: из позиционного списка, из options или из объекта.
await check('prolong ipv4/isp/mobile: смесь id и адресов отбивается локально', async () => {
    for (const type of ['ipv4', 'isp', 'mobile', ' ISP ']) {
        await expectApiError(() => prolongClient.prepareProlong(type, ['1.2.3.4', PROXY_ID], '1m', ''),
            'Mixing proxy ids and addresses in one call is not supported');
    }
    await expectApiError(
        () => prolongClient.prepareProlong('ipv4', ['1.2.3.4'], '1m', '', { ids: [PROXY_ID] }),
        'the server renews by ids and ignores ips');
    await expectApiError(
        () => prolongClient.prepareProlong('mobile', { ids: [PROXY_ID], ips: ['10.0.0.1:8000:9000'] }),
        'pass either ids or addresses');
});

await check('prolong ipv4/isp/mobile: смесь не уходит в сеть ни через calc, ни через make', async () => {
    const client = new ProxySellerUserApi({ key: 'k' });
    const calls = await captureRequest(client, async () => {
        await expectApiError(() => client.prolongCalc('ipv4', ['1.2.3.4', PROXY_ID], '1m'), 'Mixing');
        await expectApiError(() => client.prolongMake('isp', `1.2.3.4, ${PROXY_ID}`, '1m'), 'Mixing');
    });
    assertEqual(calls.length, 0, 'no request may be sent');
});

await check('prolong isp/mobile: как ipv4 — id в ids, mobile-тройка в ips', () => {
    for (const type of ['isp', 'mobile']) {
        const byId = prolongClient.prepareProlong(type, [PROXY_ID], '1m', '');
        assertBody(byId, { ids: [PROXY_ID], periodId: '1m', coupon: '' }, `${type}: by id`);
    }
    const byAddress = prolongClient.prepareProlong('mobile', ['10.0.0.1:8000:9000'], '1m', '');
    assertBody(byAddress, { ips: ['10.0.0.1:8000:9000'], periodId: '1m', coupon: '' }, 'mobile: by address');
});

await check('prolong ipv6/mix/mix_isp: order_id уезжает в orderIds, а не в ids', () => {
    for (const type of ['ipv6', 'mix', 'mix_isp']) {
        const payload = prolongClient.prepareProlong(type, [ORDER_ID], '1m', '');
        assertBody(payload, { orderIds: [ORDER_ID], periodId: '1m', coupon: '' }, `${type}: by order`);
        assertNoRemovedFields(payload);
    }
});

// Адрес для заказных типов не подменяется молча: он уходит в ips, и сервер отвечает
// "[ips] is not applicable for <type>: prolong by [orderIds]" — ошибка называет нужное поле.
// Смесь здесь локально НЕ отбивается: адреса ничего не теряют молча, их отбивает сервер.
await check('prolong ipv6/mix/mix_isp: адрес уезжает в ips, order_id — в orderIds', () => {
    for (const type of ['ipv6', 'mix', 'mix_isp']) {
        const payload = prolongClient.prepareProlong(type, ['1.2.3.4:26000', ORDER_ID], '1m', '');
        assertBody(payload, { ips: ['1.2.3.4:26000'], orderIds: [ORDER_ID], periodId: '1m', coupon: '' },
            `${type}: address and order`);
    }
});

await check('prolong: тип нормализуется, как на сервере (trim, регистр, "-" и пробел)', () => {
    for (const type of [' IPv6 ', 'MIX', 'mix-isp', 'Mix ISP']) {
        const payload = prolongClient.prepareProlong(type, [ORDER_ID], '1m', '');
        assertEqual(payload.orderIds, [ORDER_ID], `"${type}" must route to orderIds`);
    }
    assertEqual(prolongClient.prepareProlong(' ISP ', [PROXY_ID], '1m', '').ids, [PROXY_ID],
        '" ISP " must route to ids');
});

await check('prolong: строка через запятую, Set и пустые элементы', () => {
    assertEqual(prolongClient.prepareProlong('ipv4', '1.2.3.4, 5.6.7.8 ,  ', '1m', '').ips,
        ['1.2.3.4', '5.6.7.8'], 'comma-separated string lost');
    assertEqual(prolongClient.prepareProlong('mix_isp', new Set([ORDER_ID]), '1m', '').orderIds,
        [ORDER_ID], 'Set lost');
    assertEqual(prolongClient.prepareProlong('ipv4', [' ', null, PROXY_ID], '1m', '').ids,
        [PROXY_ID], 'blank and null items must be skipped');
});

await check('prolong: пустой выбор — в теле нет ни одного пустого списка', () => {
    for (const selection of [[], '', ' , ', null, undefined]) {
        for (const type of ['ipv4', 'ipv6']) {
            const payload = prolongClient.prepareProlong(type, selection, '1m', '');
            for (const field of ['ids', 'ips', 'orderIds', ...REMOVED_PROLONG_FIELDS]) {
                assert(!(field in payload),
                    `${type} ${JSON.stringify(selection)}: ${field} must be absent, got ${JSON.stringify(payload)}`);
            }
        }
    }
});

// ids — рабочее поле выбора ipv4/isp/mobile, а не удалённое: ни в options, ни в объектной форме
// оно не отбивается. Подходит ли поле типу, решает сервер ("[ids] is not applicable for ipv6:
// prolong by [orderIds]"), поэтому явно переданное ids уходит как есть и в orderIds не подменяется.
await check('prolong: ids из options и объектной формы — рабочее поле, уходит как передано', () => {
    assertBody(prolongClient.prepareProlong('ipv4', null, '1m', '', { ids: [PROXY_ID] }),
        { ids: [PROXY_ID], periodId: '1m', coupon: '' }, 'ipv4: ids from options');
    assertBody(prolongClient.prepareProlong('isp', { ids: PROXY_ID, periodId: '1m' }),
        { ids: [PROXY_ID], periodId: '1m' }, 'isp: ids in the object form');
    assertBody(prolongClient.prepareProlong('ipv6', null, '1m', '', { ids: [PROXY_ID] }),
        { ids: [PROXY_ID], periodId: '1m', coupon: '' }, 'ipv6: explicit ids must go out as given');
});

// Удалённые поля не выбрасываются молча, а отбиваются с именем замены — как dailyCountCap у
// balance/autotopup/set. Отбивается само наличие ключа, даже с пустым значением.
await check('prolong: orderSeparatorIds/orderSeparatorId — локальная ошибка с заменой', async () => {
    for (const field of ['orderSeparatorIds', 'orderSeparatorId']) {
        await expectApiError(() => prolongClient.prepareProlong('mix', [ORDER_ID], '1m', '', { [field]: 'SEP' }),
            '`orderSeparatorIds`/`orderSeparatorId` were removed: use `orderIds`');
        await expectApiError(() => prolongClient.prepareProlong('ipv4', [PROXY_ID], '1m', '', { [field]: [] }),
            '`orderSeparatorIds`/`orderSeparatorId` were removed: use `orderIds`');
    }
});

await check('prolong: удалённые поля в объектной форме тоже отбиваются', async () => {
    await expectApiError(() => prolongClient.prepareProlong('mix', {
        orderSeparatorIds: ['SEP'], orderIds: [ORDER_ID], periodId: '1m'
    }), '`orderSeparatorIds`/`orderSeparatorId` were removed: use `orderIds`');
    await expectApiError(() => prolongClient.prepareProlong('ipv4', { orderSeparatorId: 'SEP', ids: [PROXY_ID] }),
        'use `orderIds`');
});

await check('prolong: удалённые поля не уходят в сеть', async () => {
    const client = new ProxySellerUserApi({ key: 'k' });
    const calls = await captureRequest(client, async () => {
        await expectApiError(() => client.prolongMake('mix', [ORDER_ID], '1m', '', { orderSeparatorId: 'SEP' }),
            'orderSeparatorId');
        await expectApiError(() => client.prolongCalc('mix', { orderSeparatorIds: ['SEP'] }), 'orderSeparatorIds');
    });
    assertEqual(calls.length, 0, 'no request may be sent');
});

await check('prolong: явные ids/ips/orderIds из options уходят как переданы, пустые — нет', () => {
    const explicit = prolongClient.prepareProlong('ipv4', null, '1m', '', {
        ids: `${PROXY_ID}, `, orderIds: [], ips: []
    });
    assertEqual(explicit.ids, [PROXY_ID], 'explicit ids lost');
    assert(!('orderIds' in explicit) && !('ips' in explicit),
        `empty lists must not be sent, got ${JSON.stringify(explicit)}`);

    const cleared = prolongClient.prepareProlong('ipv4', [PROXY_ID], '1m', '', { ids: [] });
    assert(!('ids' in cleared), `explicit empty ids must clear the routed one, got ${JSON.stringify(cleared)}`);

    const ordered = prolongClient.prepareProlong('ipv6', ['1.2.3.4:26000'], '1m', '', { orderIds: [ORDER_ID] });
    assertEqual(ordered.orderIds, [ORDER_ID], 'explicit orderIds lost');
    assertEqual(ordered.ips, ['1.2.3.4:26000'], 'routed ips lost');
});

// У резидентки выбора нет: автопродление применяется ко всему пакету. Выбросить выбор молча
// нельзя — disable, адресованный паре адресов, выключил бы автопродление всего пакета.
await check('prolong resident: любой непустой выбор — локальная ошибка', async () => {
    const message = 'resident auto-prolong applies to the whole package: do not pass proxy or order ids';
    for (const type of ['resident', ' Residential ']) {
        await expectApiError(() => prolongClient.prepareProlong(type, ['1.2.3.4', PROXY_ID], null, null), message);
        await expectApiError(() => prolongClient.prepareProlong(type, [PROXY_ID], null, null), message);
    }
    for (const field of ['ids', 'ips', 'orderIds']) {
        await expectApiError(() => prolongClient.prepareProlong('resident', null, null, null, { [field]: ['X'] }), message);
    }
});

await check('prolong resident: пустой выбор проходит и тело остаётся пустым', () => {
    for (const selection of [null, undefined, [], '']) {
        assertBody(prolongClient.prepareProlong('resident', selection, null, null, { ids: [] }), {},
            `${JSON.stringify(selection)}: body must be empty`);
    }
});

await check('prolongCalc/prolongMake: тип доезжает и до разводки, и до пути', async () => {
    const client = new ProxySellerUserApi({ key: 'k' });
    const calc = await captureRequest(client, () => client.prolongCalc('ipv6', [ORDER_ID], '1m'));
    assertEqual(calc.length, 1, 'expected exactly one request');
    assertEqual(calc[0].uri, 'prolong/calc/ipv6', 'calc path');
    assertBody(calc[0].options.data, { orderIds: [ORDER_ID], periodId: '1m', coupon: '' }, 'calc body');

    const make = await captureRequest(client,
        () => client.prolongMake('ipv4', [PROXY_ID], '1m', 'SALE10'));
    assertEqual(make[0].uri, 'prolong/make/ipv4', 'make path');
    assertBody(make[0].options.data, { ids: [PROXY_ID], periodId: '1m', coupon: 'SALE10' }, 'make body');

    const byAddress = await captureRequest(client, () => client.prolongMake('mobile', ['10.0.0.1:8000:9000'], '1m'));
    assertBody(byAddress[0].options.data, { ips: ['10.0.0.1:8000:9000'], periodId: '1m', coupon: '' }, 'mobile body');
});

/////////////////////////////// autoprolong: тот же выбор ///////////////////////////////

await check('autoProlongCalc ipv4: id прокси -> ids, платёжка и период на месте', async () => {
    const client = new ProxySellerUserApi({ key: 'k' });
    const calls = await captureRequest(client,
        () => client.autoProlongCalc('ipv4', [PROXY_ID], '1m', { paymentId: 'balance' }));
    assertEqual(calls[0].uri, 'autoprolong/calc/ipv4', 'path');
    assertBody(calls[0].options.data, { paymentId: 'balance', ids: [PROXY_ID], periodId: '1m' });
});

await check('autoProlongEnable ipv6/mix/mix_isp: order_id -> orderIds', async () => {
    const client = new ProxySellerUserApi({ key: 'k' });
    for (const type of ['ipv6', 'mix', 'mix_isp']) {
        const calls = await captureRequest(client,
            () => client.autoProlongEnable(type, [ORDER_ID], '1m', { paymentId: 'balance' }));
        assertEqual(calls[0].uri, `autoprolong/enable/${type}`, `${type}: path`);
        assertBody(calls[0].options.data,
            { paymentId: 'balance', orderIds: [ORDER_ID], periodId: '1m' }, `${type}: body`);
    }
});

await check('autoProlongDisable: выбор по типу, без платёжки и периода', async () => {
    const client = new ProxySellerUserApi({ key: 'k' });
    const byOrder = await captureRequest(client, () => client.autoProlongDisable('ipv6', [ORDER_ID]));
    assertBody(byOrder[0].options.data, { orderIds: [ORDER_ID] }, 'ipv6 body');
    const byAddress = await captureRequest(client,
        () => client.autoProlongDisable('mobile', ['10.0.0.1:8000:9000']));
    assertBody(byAddress[0].options.data, { ips: ['10.0.0.1:8000:9000'] }, 'mobile body');
});

await check('autoprolong resident: пакетная форма уходит без выбора', async () => {
    const client = new ProxySellerUserApi({ key: 'k' });
    const calc = await captureRequest(client,
        () => client.autoProlongCalc('resident', null, null, { paymentId: 'balance', tarif_id: 'trial' }));
    assertBody(calc[0].options.data, { paymentId: 'balance', tarifId: 'trial' }, 'resident calc body');
    const disable = await captureRequest(client, () => client.autoProlongDisable('resident'));
    assertEqual(disable[0].uri, 'autoprolong/disable/resident', 'resident disable path');
    assertBody(disable[0].options.data, {}, 'resident disable body');
});

await check('autoprolong resident: выбор отбивается локально и в сеть не уходит', async () => {
    const client = new ProxySellerUserApi({ key: 'k' });
    const message = 'resident auto-prolong applies to the whole package';
    const calls = await captureRequest(client, async () => {
        await expectApiError(() => client.autoProlongDisable('resident', ['1.2.3.4']), message);
        await expectApiError(() => client.autoProlongDisable('resident', null, { ids: [PROXY_ID] }), message);
        await expectApiError(
            () => client.autoProlongEnable('resident', [PROXY_ID], null, { paymentId: 'balance' }), message);
        await expectApiError(
            () => client.autoProlongCalc('residential', null, null, { paymentId: 'balance', orderIds: [ORDER_ID] }),
            message);
        await expectApiError(() => client.autoProlongCalc('resident', { ips: ['1.2.3.4'], paymentId: 'balance' }),
            message);
    });
    assertEqual(calls.length, 0, 'no request may be sent');
});

await check('autoprolong: удалённые поля и смесь id с адресами отбиваются до запроса', async () => {
    const client = new ProxySellerUserApi({ key: 'k' });
    const calls = await captureRequest(client, async () => {
        await expectApiError(
            () => client.autoProlongEnable('ipv4', ['1.2.3.4'], '1m', { paymentId: 'balance', ids: [PROXY_ID] }),
            'the server renews by ids and ignores ips');
        await expectApiError(
            () => client.autoProlongDisable('mix', null, { orderSeparatorIds: ['SEP'] }),
            '`orderSeparatorIds`/`orderSeparatorId` were removed: use `orderIds`');
        await expectApiError(
            () => client.prepareAutoProlong('mix', { orderSeparatorId: 'SEP', orderIds: [ORDER_ID] }),
            'use `orderIds`');
        await expectApiError(
            () => client.autoProlongCalc('mobile', ['10.0.0.1:8000:9000', PROXY_ID], '1m', { paymentId: 'balance' }),
            'Mixing proxy ids and addresses in one call is not supported');
    });
    assertEqual(calls.length, 0, 'no request may be sent');
});

await check('autoprolong: snake-алиасы по-прежнему приводятся к camelCase', async () => {
    const client = new ProxySellerUserApi({ key: 'k' });
    const calls = await captureRequest(client, () => client.autoProlongEnable('ipv4', [PROXY_ID], '1m', {
        payment_id: 'balance', subscription_id: 'sub_1'
    }));
    assertBody(calls[0].options.data,
        { paymentId: 'balance', subscriptionId: 'sub_1', ids: [PROXY_ID], periodId: '1m' });
    assertNoRemovedFields(calls[0].options.data);
});

await check('autoprolong: scraper и вызов без платёжки отбиваются до запроса', async () => {
    const client = new ProxySellerUserApi({ key: 'k' });
    const calls = await captureRequest(client, async () => {
        await expectApiError(() => client.autoProlongCalc(' Scraper ', [], null, { paymentId: 'balance' }),
            'scraper is not supported');
        await expectApiError(() => client.autoProlongEnable('ipv6', [ORDER_ID], '1m', {}),
            'requires a payment system');
    });
    assertEqual(calls.length, 0, 'no request may be sent');
});

await check('order/calc mix: код пакета уезжает в mixId', () => {
    const payload = prolongClient.prepareMix('europe-2-mix_IPv4', '1m', 10, null, null, null);
    assertEqual(payload.mixId, 'europe-2-mix_IPv4', 'mixId lost');
    assert(!('countryId' in payload), `countryId must not be sent, got ${JSON.stringify(payload)}`);
});

/////////////////////////////// order/list ///////////////////////////////

// Фильтры order/list называются в snake_case (start_date, is_extend, order_id) и уходят ровно
// под этими именами: переименование сломало бы вызов молча — запрос бы ушёл, фильтр бы не
// применился.
await check('order/list: фильтры уходят в snake_case без переименования', async () => {
    const listClient = new ProxySellerUserApi({ key: 'SELFCHECK_KEY' });
    const filters = {
        order_id: 'ORDER_OBJECT_ID', start_date: '01.06.2023', end_date: '30.06.2023',
        status: 'PAYED', is_extend: 'Y', auto_order: 'N', page: 1, limit: 20,
        sort_by: 'date_insert', order: 'desc'
    };
    const calls = await captureRequest(listClient, () => listClient.orderList(filters));
    assertEqual(calls.length, 1, 'ожидался ровно один запрос');
    assertEqual(calls[0].method, 'get', 'order/list — это GET');
    assertEqual(calls[0].uri, 'order/list', 'неверный путь');
    assertEqual(calls[0].options.params, filters, 'фильтры переименованы или потеряны');
});

await check('order/list: все фильтры опциональны, null не уезжает', async () => {
    const listClient = new ProxySellerUserApi({ key: 'SELFCHECK_KEY' });
    const empty = await captureRequest(listClient, () => listClient.orderList());
    assertEqual(empty[0].options.params, {}, 'без фильтров params должен быть пустым');

    const partial = await captureRequest(
        listClient, () => listClient.orderList({ order_id: null, status: 'NOT_PAYED' }));
    assertEqual(partial[0].options.params, { status: 'NOT_PAYED' }, 'null не отфильтрован');
});

/////////////////////////////// очередь запросов (rateLimit) ///////////////////////////////

// Очередь проверяется целиком — через настоящие request() и axios. Подменён только транспорт
// (adapter axios), а часы и таймер отданы клиенту через rateLimit.now / rateLimit.sleep. Время
// виртуальное: тесты не ждут ни миллисекунды, а параллельные вызовы живут на общей шкале, так что
// перекрытие запросов и интервалы между стартами видны точно.

/**
 * Виртуальное время. now() и sleep(ms) уходят в rateLimit клиента и в задержку транспорта;
 * run(work) крутит «событийный цикл»: дожидается, пока отработают все микрозадачи, и переводит
 * часы к ближайшему таймеру — и так, пока work не завершится. Работа ждёт, а таймеров нет —
 * значит, зависла: run() падает, а не висит.
 */
function virtualTime(start = 0) {
    let current = start;
    let order = 0;
    const timers = [];
    const now = () => current;
    const sleep = (ms) => new Promise((resolve) => {
        timers.push({ at: current + Math.max(0, Number(ms) || 0), order: order++, resolve: resolve });
    });
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    async function run(work) {
        let outcome = null;
        Promise.resolve().then(work).then(
            (value) => { outcome = { ok: true, value: value }; },
            (error) => { outcome = { ok: false, error: error }; }
        );
        for (let idle = 0; outcome === null;) {
            await tick();
            if (outcome !== null) {
                break;
            }
            if (timers.length === 0) {
                if (++idle > 20) {
                    throw new Error('virtual time: the work is waiting, but no timer is pending');
                }
                continue;
            }
            idle = 0;
            timers.sort((a, b) => a.at - b.at || a.order - b.order);
            const timer = timers.shift();
            current = Math.max(current, timer.at);
            timer.resolve();
        }
        if (!outcome.ok) {
            throw outcome.error;
        }
        return outcome.value;
    }
    return { now: now, sleep: sleep, run: run };
}

/**
 * Подменённый транспорт — adapter axios: в сеть не ходит, отвечает по сценарию reply(config, n)
 * (n — номер запроса с единицы) и ведёт журнал: когда по виртуальным часам запрос ушёл и когда
 * закончился. reply возвращает { status, data, headers, latency, error } — всё необязательно: по
 * умолчанию это успешный конверт без задержки, а для не-2xx — HTML-страница, как у лимита на входе.
 * validateStatus применяется так же, как у настоящих адаптеров axios (settle).
 */
function stubTransport(time, reply = () => ({})) {
    const log = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const adapter = async (config) => {
        const entry = { method: config.method, url: config.url, data: config.data, start: time.now(), end: null };
        log.push(entry);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
            const answer = (await reply(config, log.length)) || {};
            if (answer.latency) {
                await time.sleep(answer.latency);
            }
            if (answer.error) {
                throw answer.error;
            }
            const status = answer.status || 200;
            const ok = status >= 200 && status < 300;
            const hasData = Object.prototype.hasOwnProperty.call(answer, 'data');
            const response = {
                data: hasData ? answer.data : (ok ? { status: 'success', data: {}, errors: [] } : `<html>${status}</html>`),
                status: status,
                statusText: '',
                headers: { 'content-type': hasData || ok ? 'application/json' : 'text/html', ...(answer.headers || {}) },
                config: config,
                request: {}
            };
            if (typeof config.validateStatus === 'function' && !config.validateStatus(status)) {
                throw Object.assign(new Error(`Request failed with status code ${status}`), { response: response });
            }
            return response;
        } finally {
            inFlight--;
            entry.end = time.now();
        }
    };
    return {
        adapter: adapter,
        log: log,
        maxInFlight: () => maxInFlight,
        starts: (filter = () => true) => log.filter(filter).map((entry) => entry.start)
    };
}

/** Клиент на подменённом транспорте и виртуальных часах; sleeps — паузы, которые взяла сама очередь. */
function pacedClient(time, transport, rateLimit = {}) {
    const sleeps = [];
    const client = new ProxySellerUserApi({
        key: 'k',
        adapter: transport.adapter,
        rateLimit: {
            now: time.now,
            sleep: (ms) => {
                sleeps.push(ms);
                return time.sleep(ms);
            },
            ...rateLimit
        }
    });
    return { client: client, sleeps: sleeps };
}

/** Старты по путям: { 'auth/add': [0], ... } — для сравнения без учёта порядка путей. */
function startsByUrl(log) {
    const result = {};
    for (const entry of log) {
        (result[entry.url] = result[entry.url] || []).push(entry.start);
    }
    return result;
}

/** Ни в каком отрезке [s, s + 60 с) не больше limit стартов. */
function assertWindow(starts, limit) {
    for (const from of starts) {
        const inWindow = starts.filter((start) => start >= from && start < from + 60000).length;
        assert(inWindow <= limit, `${inWindow} starts within 60 s from ${from}, limit ${limit}`);
    }
}

/**
 * Инварианты полосы записи по журналу: write/money не перекрываются, каждый стартует после конца
 * предыдущего и не раньше writeIntervalMs от его старта, money — ещё и не раньше moneyIntervalMs
 * от старта предыдущего money.
 */
function assertLane(log, client, writeIntervalMs, moneyIntervalMs) {
    let previous = null;
    let previousMoney = null;
    for (const entry of log) {
        const category = client._requestCategory(entry.url);
        if (category === 'read') {
            continue;
        }
        if (previous) {
            assert(entry.start >= previous.end,
                `${entry.url}@${entry.start} overlaps ${previous.url}, which ended at ${previous.end}`);
            assert(entry.start - previous.start >= writeIntervalMs,
                `${entry.url}@${entry.start} is closer than ${writeIntervalMs} ms to ${previous.url}@${previous.start}`);
        }
        if (category === 'money' && previousMoney) {
            assert(entry.start - previousMoney.start >= moneyIntervalMs,
                `${entry.url}@${entry.start} is closer than ${moneyIntervalMs} ms to ${previousMoney.url}@${previousMoney.start}`);
        }
        previous = entry;
        if (category === 'money') {
            previousMoney = entry;
        }
    }
}

const ADDRESS = '1.2.3.4';

await check('rate limit: money — не чаще moneyIntervalMs, write — не чаще writeIntervalMs (по умолчанию 2000 / 1000)', async () => {
    const moneyTime = virtualTime();
    const money = stubTransport(moneyTime, () => ({ latency: 100 }));
    const { client: moneyClient } = pacedClient(moneyTime, money);
    await moneyTime.run(async () => {
        await moneyClient.prolongMake('ipv4', [ADDRESS], '1m');
        await moneyClient.orderMakeResident('1-gb');
        await moneyClient.balanceAdd(10, 'PAYMENT_ID');
    });
    assertEqual(money.starts(), [0, 2000, 4000], 'money starts');

    const writeTime = virtualTime();
    const write = stubTransport(writeTime, () => ({ latency: 100 }));
    const { client: writeClient } = pacedClient(writeTime, write);
    await writeTime.run(async () => {
        await writeClient.authAdd('ORDER_NUMBER', 'N');
        await writeClient.proxyCommentSet([PROXY_ID], 'note');
        await writeClient.autoProlongDisable('ipv4', [ADDRESS]);
    });
    assertEqual(write.starts(), [0, 1000, 2000], 'write starts');
});

await check('rate limit: money сразу после write ждёт max(writeIntervalMs от старта write, moneyIntervalMs от старта money)', async () => {
    // Старше moneyInterval: M 0, W 1000, M max(1000 + 1000, 0 + 5000) = 5000, W 6000,
    // M max(6000 + 1000, 5000 + 5000) = 10000.
    const time = virtualTime();
    const transport = stubTransport(time, () => ({ latency: 100 }));
    const { client } = pacedClient(time, transport, { writeIntervalMs: 1000, moneyIntervalMs: 5000 });
    await time.run(async () => {
        await client.prolongMake('ipv4', [ADDRESS], '1m');
        await client.authAdd('ORDER_NUMBER', 'N');
        await client.prolongMake('ipv4', [ADDRESS], '1m');
        await client.authChange('AUTH_ID', true);
        await client.orderMakeResident('1-gb');
    });
    assertEqual(transport.starts(), [0, 1000, 5000, 6000, 10000], 'moneyIntervalMs must win');

    // Старше writeInterval: M 0, W 3000, M max(3000 + 3000, 0 + 2000) = 6000.
    const time2 = virtualTime();
    const transport2 = stubTransport(time2, () => ({ latency: 100 }));
    const { client: client2 } = pacedClient(time2, transport2, { writeIntervalMs: 3000, moneyIntervalMs: 2000 });
    await time2.run(async () => {
        await client2.balanceAdd(10, 'PAYMENT_ID');
        await client2.proxyReplace([PROXY_ID], 'NOT_WORK');
        await client2.prolongMake('ipv4', [ADDRESS], '1m');
    });
    assertEqual(transport2.starts(), [0, 3000, 6000], 'writeIntervalMs must win');
});

await check('rate limit: read не ждёт полосу записи — только окно', async () => {
    const time = virtualTime();
    const transport = stubTransport(time,
        (config) => ({ latency: config.url.startsWith('prolong/make/') ? 5000 : 10 }));
    const { client } = pacedClient(time, transport);
    const isMake = (entry) => entry.url.startsWith('prolong/make/');
    await time.run(async () => {
        const lane = [
            client.prolongMake('ipv4', [ADDRESS], '1m'),     // в полёте 0..5000
            client.prolongMake('ipv4', ['5.6.7.8'], '1m')    // ждёт конца первого
        ];
        // calc-эндпоинты и resident/consumption шлются POST, но меняют ничего — это read.
        await Promise.all([
            client.proxyList('ipv4'),
            client.prolongCalc('ipv4', [ADDRESS], '1m'),
            client.orderCalcIpv4('USA', '1m', 1, null, null, 'scraping'),
            client.autoProlongCalc('ipv4', [ADDRESS], '1m', { paymentId: 'balance' }),
            client.residentConsumption()
        ]);
        await time.sleep(1000);
        await client.balance(); // посреди ожидания полосы — тоже сразу
        await Promise.all(lane);
    });
    assertEqual(transport.starts(isMake), [0, 5000], 'the lane');
    assertEqual(transport.starts((entry) => !isMake(entry)), [0, 0, 0, 0, 0, 1010], 'reads must not wait for the lane');
});

await check('rate limit: глобальное окно — не больше requestsPerMinute стартов за 60 с, одно на все категории', async () => {
    const time = virtualTime();
    const transport = stubTransport(time);
    const { client } = pacedClient(time, transport, { requestsPerMinute: 3 });
    await time.run(() => Promise.all(Array.from({ length: 7 }, () => client.proxyList())));
    assertEqual(transport.starts(), [0, 0, 0, 60000, 60000, 60000, 120000], 'reads');
    assertWindow(transport.starts(), 3);

    // write, read и money делят одно окно: третий старт ждёт, пока первому не исполнится 60 с.
    const time2 = virtualTime();
    const transport2 = stubTransport(time2);
    const { client: client2 } = pacedClient(time2, transport2, { requestsPerMinute: 2 });
    await time2.run(() => Promise.all([
        client2.authAdd('ORDER_NUMBER', 'N'),
        client2.proxyList(),
        client2.prolongMake('ipv4', [ADDRESS], '1m')
    ]));
    assertBody(startsByUrl(transport2.log), { 'auth/add': [0], 'proxy/list': [0], 'prolong/make/ipv4': [60000] });
});

await check('rate limit: окно скользящее, а не bucket — всплеска сверх N за 60 с не бывает', async () => {
    const time = virtualTime();
    const transport = stubTransport(time);
    const { client } = pacedClient(time, transport, { requestsPerMinute: 2 });
    await time.run(async () => {
        await client.proxyList();      // 0
        await time.sleep(30000);
        await client.proxyList();      // 30000
        await client.proxyList();      // bucket пустил бы сразу; окно — только в 60000
        await client.proxyList();      // 90000: 60 с от второго
    });
    assertEqual(transport.starts(), [0, 30000, 60000, 90000]);
    assertWindow(transport.starts(), 2);
});

await check('rate limit: по умолчанию — 1000 стартов за 60 с', async () => {
    const time = virtualTime();
    const transport = stubTransport(time);
    const { client } = pacedClient(time, transport);
    await time.run(() => Promise.all(Array.from({ length: 1001 }, () => client.proxyList())));
    const starts = transport.starts();
    assertEqual(starts.filter((start) => start === 0).length, 1000, 'the first 1000 go at once');
    assertEqual(starts[1000], 60000, 'the 1001st waits for the window');
});

await check('rate limit: 429 — пауза по Retry-After и повтор того же запроса', async () => {
    const time = virtualTime();
    const transport = stubTransport(time, (config, n) => (n <= 2
        ? { status: 429, headers: { 'Retry-After': '5' } }
        : { data: { status: 'success', data: { orderId: ORDER_ID }, errors: [] } }));
    const { client } = pacedClient(time, transport);
    const result = await time.run(() => client.prolongMake('ipv4', [ADDRESS], '1m'));
    assertEqual(result, { orderId: ORDER_ID }, 'the call must return the answer of the successful attempt');
    assertEqual(transport.starts(), [0, 5000, 10000], 'Retry-After: 5 between the attempts');
    assert(transport.log.every((entry) => entry.data === transport.log[0].data), 'every attempt must send the same body');
});

await check('rate limit: 429 после maxRetries повторов — обычная ApiError с httpStatus 429; без Retry-After — 2 с', async () => {
    const time = virtualTime();
    const transport = stubTransport(time, () => ({ status: 429 }));
    const { client } = pacedClient(time, transport);
    let error = null;
    await time.run(async () => {
        try {
            await client.prolongMake('ipv4', [ADDRESS], '1m');
        } catch (e) {
            error = e;
        }
    });
    assert(error instanceof ApiError, `expected ApiError, got ${error}`);
    assertEqual(error.httpStatus, 429, 'httpStatus');
    assertEqual(transport.starts(), [0, 2000, 4000, 6000], '1 + maxRetries (3 by default) attempts, 2 s apart');

    for (const [maxRetries, expected] of [[0, [0]], [1, [0, 2000]]]) {
        const localTime = virtualTime();
        const local = stubTransport(localTime, () => ({ status: 429 }));
        const { client: localClient } = pacedClient(localTime, local, { maxRetries: maxRetries });
        await expectApiError(() => localTime.run(() => localClient.proxyList()), 'HTTP 429');
        assertEqual(local.starts(), expected, `maxRetries=${maxRetries}`);
    }
});

await check('rate limit: Retry-After — секунды или HTTP-дата, потолок 60 с, неразборчивое — 2 с', async () => {
    const inTenSeconds = new Date(Date.now() + 10000).toUTCString();
    const cases = [
        ['7', 7000, 7000],
        ['0', 0, 0],
        ['600', 60000, 60000],                              // потолок
        ['Fri, 01 Jan 2100 00:00:00 GMT', 60000, 60000],    // дата далеко впереди — тоже потолок
        ['Sat, 01 Jan 2000 00:00:00 GMT', 0, 0],            // дата в прошлом — сразу
        [inTenSeconds, 8000, 10000],                        // HTTP-дата точна до секунды
        [undefined, 2000, 2000],                            // заголовка нет
        ['', 2000, 2000],
        ['soon', 2000, 2000],
        ['1.5', 2000, 2000],
        ['-3', 2000, 2000]
    ];
    for (const [value, min, max] of cases) {
        const time = virtualTime();
        let throttled = false;
        const transport = stubTransport(time, () => {
            if (throttled) {
                return {};
            }
            throttled = true;
            return { status: 429, headers: value === undefined ? {} : { 'retry-after': value } };
        });
        const { client } = pacedClient(time, transport);
        await time.run(() => client.proxyList());
        const [first, second] = transport.starts();
        const wait = second - first;
        assert(wait >= min && wait <= max,
            `Retry-After ${JSON.stringify(value)}: waited ${wait} ms, expected ${min}..${max}`);
    }
});

await check('rate limit: повтор write/money держит место в полосе — никто не влезает вперёд', async () => {
    const time = virtualTime();
    let throttled = false;
    const transport = stubTransport(time, (config) => {
        if (config.url === 'prolong/make/ipv4' && !throttled) {
            throttled = true;
            return { status: 429, headers: { 'retry-after': '3' }, latency: 100 };
        }
        return { latency: 100 };
    });
    const { client } = pacedClient(time, transport);
    await time.run(() => Promise.all([
        client.prolongMake('ipv4', [ADDRESS], '1m'),
        client.authAdd('ORDER_NUMBER', 'N'),
        client.proxyList()
    ]));
    // prolong/make: 429 в 0..100, повтор через 3 с — 3100..3200. auth/add стоял за ним: стартует
    // после конца повтора и не раньше writeIntervalMs от старта ПОВТОРА — каждая попытка считается
    // стартом. proxy/list полосу не ждёт.
    assertBody(startsByUrl(transport.log), { 'prolong/make/ipv4': [0, 3100], 'auth/add': [4100], 'proxy/list': [0] });
});

await check('rate limit: каждый повтор — новый старт в окне', async () => {
    const time = virtualTime();
    let throttled = false;
    const transport = stubTransport(time, () => {
        if (throttled) {
            return {};
        }
        throttled = true;
        return { status: 429, headers: { 'retry-after': '1' } };
    });
    const { client } = pacedClient(time, transport, { requestsPerMinute: 2 });
    await time.run(async () => {
        await client.proxyList();   // 0 -> 429, повтор в 1000: это уже два старта
        await client.proxyList();   // окно полно до 60000
    });
    assertEqual(transport.starts(), [0, 1000, 60000]);
});

await check('rate limit: 429 исключением (validateStatus переопределён в вызове) тоже повторяется', async () => {
    const time = virtualTime();
    let throttled = false;
    const transport = stubTransport(time, () => {
        if (throttled) {
            return {};
        }
        throttled = true;
        return { status: 429, headers: { 'retry-after': '4' } };
    });
    const { client } = pacedClient(time, transport);
    const data = await time.run(() => client.request('get', 'proxy/list', { validateStatus: (status) => status < 400 }));
    assertEqual(data, {}, 'data of the successful attempt');
    assertEqual(transport.starts(), [0, 4000]);
});

await check('rate limit: code 57 и тройка отказа доступа не повторяются', async () => {
    const inProgress = [{ code: 57, message: 'Prolong for this order is already in progress' }];
    const denied = [
        { message: 'Error api key', code: 503 },
        { message: 'IP not allowed 1.2.3.4', code: 503 },
        { message: 'Request limit reached', code: 503 }
    ];
    const calls = [
        (client) => client.prolongMake('ipv4', [ADDRESS], '1m'),
        (client) => client.proxyList()
    ];
    for (const errors of [inProgress, denied]) {
        for (const call of calls) {
            const time = virtualTime();
            const transport = stubTransport(time, () => ({ data: { status: 'error', data: null, errors: errors } }));
            const { client, sleeps } = pacedClient(time, transport);
            let error = null;
            await time.run(async () => {
                try {
                    await call(client);
                } catch (e) {
                    error = e;
                }
            });
            assert(error instanceof ApiError, `expected ApiError, got ${error}`);
            assertEqual(error.code, errors[0].code, 'code');
            assertEqual(error.errors, errors, 'the whole errors array');
            assertEqual(transport.log.length, 1, `code ${errors[0].code} must not be retried (${call})`);
            assertEqual(sleeps, [], 'nothing to wait for');
        }
    }
});

await check('rate limit: другие HTTP-ошибки и сетевые сбои не повторяются, полоса после сбоя свободна', async () => {
    for (const status of [500, 502, 503]) {
        const time = virtualTime();
        const transport = stubTransport(time, () => ({ status: status }));
        const { client } = pacedClient(time, transport);
        await expectApiError(() => time.run(() => client.prolongMake('ipv4', [ADDRESS], '1m')), `HTTP ${status}`);
        assertEqual(transport.log.length, 1, `HTTP ${status} must not be retried`);
    }

    const time = virtualTime();
    let calls = 0;
    const transport = stubTransport(time, () => (++calls === 1
        ? { latency: 100, error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }
        : {}));
    const { client } = pacedClient(time, transport);
    await time.run(async () => {
        await expectApiError(() => client.prolongMake('ipv4', [ADDRESS], '1m'), 'socket hang up');
        await client.authAdd('ORDER_NUMBER', 'N');
    });
    assertBody(startsByUrl(transport.log), { 'prolong/make/ipv4': [0], 'auth/add': [1000] });
});

await check('rate limit: enabled=false — без ожиданий и без повторов, как до очереди', async () => {
    for (const rateLimit of [{ enabled: false }, false]) {
        const time = virtualTime();
        const transport = stubTransport(time, (config) => (config.url === 'proxy/list'
            ? { status: 429, headers: { 'retry-after': '1' } }
            : { latency: 100 }));
        const client = new ProxySellerUserApi({ key: 'k', adapter: transport.adapter, rateLimit: rateLimit });
        assertEqual(client.requestQueue, null, `${JSON.stringify(rateLimit)}: no queue`);
        let error = null;
        await time.run(async () => {
            await Promise.all([
                client.prolongMake('ipv4', [ADDRESS], '1m'),
                client.prolongMake('ipv4', ['5.6.7.8'], '1m'),
                client.authAdd('ORDER_NUMBER', 'N')
            ]);
            await client.balanceAdd(10, 'PAYMENT_ID');
            try {
                await client.proxyList();
            } catch (e) {
                error = e;
            }
        });
        assertEqual(transport.starts(), [0, 0, 0, 100, 200], 'every request must go out at once');
        assertEqual(transport.maxInFlight(), 3, 'nothing may be serialized');
        assert(error instanceof ApiError && error.httpStatus === 429, 'a 429 must surface at once, without a retry');
    }
});

await check('rate limit: два параллельных prolongMake на одном клиенте не перекрываются', async () => {
    const time = virtualTime();
    const transport = stubTransport(time, () => ({ latency: 1500 }));
    const { client } = pacedClient(time, transport);
    await time.run(() => Promise.all([
        client.prolongMake('ipv4', [ADDRESS], '1m'),
        client.prolongMake('ipv4', ['5.6.7.8'], '1m')
    ]));
    assertEqual(transport.maxInFlight(), 1, 'the two renewals overlapped');
    const [first, second] = transport.log;
    assert(second.start >= first.end, `the second started at ${second.start}, before the first ended at ${first.end}`);
    assertEqual(transport.starts(), [0, 2000], 'moneyIntervalMs between the starts');
    assert(first.data.includes(ADDRESS) && second.data.includes('5.6.7.8'), 'the lane must keep the call order');
});

await check('rate limit: параллельные write/money идут по одному, в порядке вызова', async () => {
    const time = virtualTime();
    const transport = stubTransport(time, () => ({ latency: 1500 }));
    const { client } = pacedClient(time, transport);
    await time.run(() => Promise.all([
        client.orderMakeResident('1-gb'),
        client.authAdd('ORDER_NUMBER', 'N'),
        client.prolongMake('ipv4', [ADDRESS], '1m'),
        client.autoProlongEnable('ipv4', [ADDRESS], '1m', { paymentId: 'balance' }),
        client.balanceAdd(10, 'PAYMENT_ID')
    ]));
    assertEqual(transport.log.map((entry) => entry.url),
        ['order/make', 'auth/add', 'prolong/make/ipv4', 'autoprolong/enable/ipv4', 'balance/add'], 'order');
    assertEqual(transport.maxInFlight(), 1, 'write/money overlapped');
    assertLane(transport.log, client, 1000, 2000);
    // M 0..1500, W 1500, M max(3000, 1500 + 1000, 0 + 2000) = 3000, W 4500, M max(6000, 4500 + 1000, 3000 + 2000) = 6000
    assertEqual(transport.starts(), [0, 1500, 3000, 4500, 6000]);
});

await check('rate limit: вызов, отбитый локальной проверкой, в очередь не попадает', async () => {
    const time = virtualTime();
    const transport = stubTransport(time);
    const { client } = pacedClient(time, transport);
    await time.run(async () => {
        await expectApiError(() => client.prolongMake('ipv4', [ADDRESS, PROXY_ID], '1m'), 'Mixing');
        await client.prolongMake('ipv4', [ADDRESS], '1m');
    });
    assertEqual(transport.starts(), [0], 'the rejected call must not take the lane or the window');
});

// Классификация — одна таблица по пути. Каждый метод, который сам зовёт request(), обязан быть в
// этом списке со своей категорией: новый эндпоинт без записи здесь роняет проверку, а не уезжает
// молча в read.
await check('rate limit: каждый метод SDK попадает в свою категорию', async () => {
    const client = new ProxySellerUserApi({ key: 'k' });
    const expected = [
        ['money', 'orderMake', { sectionCode: 'resident', tarifId: '1-gb' }],
        ['money', 'orderMakeIpv4', 'USA', '1m', 1, null, null, 'scraping'],
        ['money', 'prolongMake', 'ipv4', [ADDRESS], '1m'],
        ['money', 'prolongMake', 'mix_isp', [ORDER_ID], '1m'],
        ['money', 'balanceAdd', 10, 'PAYMENT_ID'],
        ['write', 'autoProlongEnable', 'ipv6', [ORDER_ID], '1m', { paymentId: 'balance' }],
        ['write', 'autoProlongDisable', 'resident'],
        ['write', 'authAdd', 'ORDER_NUMBER', 'N'],
        ['write', 'authAddIp', 'ORDER_NUMBER', ADDRESS],
        ['write', 'authChange', 'AUTH_ID', true],
        ['write', 'authDelete', 'AUTH_ID'],
        ['write', 'proxyReplace', [PROXY_ID], 'NOT_WORK'],
        ['write', 'proxyCommentSet', [PROXY_ID], 'note'],
        ['write', 'balanceAutoTopupSet', { threshold: 20 }],
        ['write', 'residentListAdd', 'list'],
        ['write', 'residentListRename', 1, 'list'],
        ['write', 'residentListRotation', 1, 0],
        ['write', 'residentListTools'],
        ['write', 'residentListDelete', 1],
        ['write', 'residentSubUserCreate', { traffic_limit: '1073741824' }],
        ['write', 'residentSubUserUpdate', { package_key: 'PACKAGE_KEY' }],
        ['write', 'residentSubUserDelete', 'PACKAGE_KEY'],
        ['write', 'residentSubUserListAdd', 'PACKAGE_KEY', 'list'],
        ['write', 'residentSubUserListRename', 'PACKAGE_KEY', 1, 'list'],
        ['write', 'residentSubUserListRotation', 'PACKAGE_KEY', 1, 0],
        ['write', 'residentSubUserListTools', 'PACKAGE_KEY'],
        ['write', 'residentSubUserListDelete', 'PACKAGE_KEY', 1],
        ['read', 'authList'],
        ['read', 'balance'],
        ['read', 'balancePaymentsList'],
        ['read', 'balanceAutoTopupGet'],
        ['read', 'referenceList'],
        ['read', 'referenceList', 'mix'],
        ['read', 'orderCalc', { sectionCode: 'resident', tarifId: '1-gb' }],
        ['read', 'orderCalcIpv4', 'USA', '1m', 1, null, null, 'scraping'],
        ['read', 'orderList'],
        ['read', 'prolongCalc', 'ipv6', [ORDER_ID], '1m'],
        ['read', 'autoProlongCalc', 'ipv4', [ADDRESS], '1m', { paymentId: 'balance' }],
        ['read', 'proxyList'],
        ['read', 'proxyList', 'ipv4'],
        ['read', 'proxyDownload', 'ipv4', 'txt'],
        ['read', 'proxyDownloadResident'],
        ['read', 'residentPackage'],
        ['read', 'residentConsumption'],
        ['read', 'residentTrafficDetails', { packageKey: 'PACKAGE_KEY' }],
        ['read', 'residentGeo'],
        ['read', 'residentGeoIsp'],
        ['read', 'residentGeoCount'],
        ['read', 'residentList'],
        ['read', 'residentSubUserPackages'],
        ['read', 'residentSubUserLists', 'PACKAGE_KEY']
    ];
    for (const [category, name, ...args] of expected) {
        const calls = await captureRequest(client, () => client[name](...args));
        assertEqual(calls.length, 1, `${name}: one request expected`);
        assertEqual(`${name} -> ${calls[0].uri}: ${client._requestCategory(calls[0].uri)}`,
            `${name} -> ${calls[0].uri}: ${category}`);
    }

    const proto = ProxySellerUserApi.prototype;
    const covered = new Set(expected.map(([, name]) => name));
    // constructor — это исходник всего класса, в нём request() встречается у каждого метода.
    const missing = Object.getOwnPropertyNames(proto).filter((name) => name !== 'constructor' &&
        typeof proto[name] === 'function' && String(proto[name]).includes('this.request(') && !covered.has(name));
    assertEqual(missing, [], 'methods that call request() with no expected category');
});

await check('rate limit: категория — по пути: без регистра, лишних слэшей и query; {type} — любой сегмент', () => {
    const client = new ProxySellerUserApi({ key: 'k' });
    const cases = {
        'order/make': 'money', '/order/make': 'money', 'order/make/': 'money', 'ORDER/Make': 'money',
        'order//make': 'money', 'order/make?coupon=x': 'money',
        'prolong/make/ipv4': 'money', 'prolong/make/mix%20isp': 'money', 'prolong/calc/ipv4': 'read',
        'autoprolong/enable/resident': 'write', 'autoprolong/calc/resident': 'read',
        'resident/list': 'write', 'resident/list/add': 'write', 'resident/lists': 'read',
        'auth/add/ip': 'write', 'auth/list': 'read', 'order/calc': 'read', 'reference/list/ipv4': 'read',
        'balance/autotopup/set': 'write', 'balance/autotopup/get': 'read', 'balance/payments/list': 'read',
        'residentsubuser/list/tools': 'write', 'residentsubuser/lists': 'read', '': 'read'
    };
    for (const [uri, category] of Object.entries(cases)) {
        assertEqual(client._requestCategory(uri), category, `"${uri}"`);
    }
});

await check('rate limit: неверная конфигурация — ApiError из конструктора; в axios rateLimit не уходит', async () => {
    const invalid = [
        5, 'off', [],
        { requestsPerMinute: 0 }, { requestsPerMinute: 1.5 }, { requestsPerMinute: '1000' },
        { writeIntervalMs: -1 }, { moneyIntervalMs: NaN }, { moneyIntervalMs: Infinity },
        { maxRetries: -1 }, { maxRetries: 0.5 }, { enabled: 'no' }, { sleep: 5 }, { now: 'clock' },
        { requestPerMinute: 10 }
    ];
    for (const rateLimit of invalid) {
        await expectApiError(() => new ProxySellerUserApi({ key: 'k', rateLimit: rateLimit }), 'rateLimit');
    }

    const defaults = new ProxySellerUserApi({ key: 'k' });
    const queue = defaults.requestQueue;
    assert(queue !== null, 'the queue must be on by default');
    assertEqual([queue.requestsPerMinute, queue.writeIntervalMs, queue.moneyIntervalMs, queue.maxRetries],
        [1000, 1000, 2000, 3], 'defaults');

    const configured = new ProxySellerUserApi({ key: 'k', rateLimit: { maxRetries: 0, writeIntervalMs: undefined } });
    assertEqual([configured.requestQueue.maxRetries, configured.requestQueue.writeIntervalMs], [0, 1000],
        'an omitted option keeps its default');
    assertEqual(configured.client.defaults.rateLimit, undefined, 'rateLimit must not reach axios');
    assert(new ProxySellerUserApi({ key: 'k', rateLimit: true }).requestQueue !== null, 'true = defaults');
});

/////////////////////////////// итог ///////////////////////////////

if (failures.length > 0) {
    console.error(`selfcheck FAILED: ${failures.length} of ${passed + failures.length}`);
    for (const failure of failures) {
        console.error(`  - ${failure}`);
    }
    process.exit(1);
}

console.log(`selfcheck OK: ${passed} checks passed`);
