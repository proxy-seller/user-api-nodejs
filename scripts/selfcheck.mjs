#!/usr/bin/env node
/**
 * Самопроверка SDK без сети: гоняем только локальные гейты и сборку тел запросов.
 * Ни один кейс не должен ходить в интернет — все проверки либо синхронные, либо
 * падают до момента отправки запроса.
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

// Коды уходят ПОЗИЦИОННО в *Id: сервер (normalizeOrderReferenceCodes) резолвит значение как
// код, если это не валидный ObjectId и парный *Code пуст. Цепочки null и options ради кодов
// не нужны — эти проверки фиксируют именно те вызовы, что показаны в README.
await check('README: ipv4 позиционно с кодами и целью', () => {
    const local = new ProxySellerUserApi({ key: 'K' });
    local.setPaymentId('PAYMENT_SYSTEM_OBJECT_ID');
    const payload = local.prepareRegular('ipv4', 'USA', '1m', 2, null, null, 'scraping');
    local.assertTargetName(payload);
    assertEqual(payload, {
        paymentId: 'PAYMENT_SYSTEM_OBJECT_ID', sectionCode: 'ipv4', countryId: 'USA',
        periodId: '1m', quantity: 2, customTargetName: 'scraping'
    });
});

await check('README: ipv4 без цели падает локально (старый пример был сломан)', () =>
    expectApiError(
        () => api.assertTargetName(api.prepareRegular('ipv4', { countryCode: 'USA', periodCode: '1m', quantity: 2 })),
        'customTargetName is required'
    ));

// rotationId — МИНУТЫ (0 = By Link), а не код: '5m'/'10m' сервер отвергает
// ("Set existed [rotationCode] from reference"), потому что rotationCode проверяется isInteger().
await check('README: mobile позиционно, rotationId числом', () => {
    const local = new ProxySellerUserApi({ key: 'K' });
    local.setPaymentId('PAYMENT_SYSTEM_OBJECT_ID');
    assertEqual(
        local.prepareMobile('USA', '1m', 1, null, null, 'OPERATOR_ID', 10),
        {
            paymentId: 'PAYMENT_SYSTEM_OBJECT_ID', sectionCode: 'mobile', countryId: 'USA',
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

await check('README: prolong по адресам с кодом периода и купоном', () => {
    assertEqual(
        api.prepareProlong(['1.2.3.4', '5.6.7.8'], '1m', 'SALE10'),
        { ips: ['1.2.3.4', '5.6.7.8'], periodId: '1m', coupon: 'SALE10' }
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

/////////////////////////////// prolong по адресам ///////////////////////////////

const prolongClient = new ProxySellerUserApi({ key: 'k' });

await check('prolong: адреса уезжают в ips, пустого ids рядом нет', () => {
    const payload = prolongClient.prepareProlong(['1.2.3.4', '5.6.7.8'], '1m', '');
    assertEqual(payload.ips, ['1.2.3.4', '5.6.7.8'], 'ips lost');
    assert(!('ids' in payload), `ids must be absent, got ${JSON.stringify(payload)}`);
});

await check('prolong: ObjectId уезжает в ids', () => {
    const payload = prolongClient.prepareProlong(['68b1f0c4e13a4c0f1a2b3c4d'], '1m', '');
    assertEqual(payload.ids, ['68b1f0c4e13a4c0f1a2b3c4d'], 'ids lost');
    assert(!('ips' in payload), `ips must be absent, got ${JSON.stringify(payload)}`);
});

await check('prolong: смешанный список разводится по форме', () => {
    const payload = prolongClient.prepareProlong(['1.2.3.4', '68b1f0c4e13a4c0f1a2b3c4d'], '1m', '');
    assertEqual(payload.ips, ['1.2.3.4'], 'ips lost');
    assertEqual(payload.ids, ['68b1f0c4e13a4c0f1a2b3c4d'], 'ids lost');
});

await check('prolong: ipv6 "host:port" и mobile-тройка — тоже адреса', () => {
    const payload = prolongClient.prepareProlong(['2001:db8::1:8080', '10.0.0.1:8000:9000'], '1m', '');
    assertEqual(payload.ips, ['2001:db8::1:8080', '10.0.0.1:8000:9000'], 'ips lost');
});

await check('prolong: строка через запятую и пустые элементы', () => {
    const payload = prolongClient.prepareProlong('1.2.3.4, 5.6.7.8 ,  ', '1m', '');
    assertEqual(payload.ips, ['1.2.3.4', '5.6.7.8'], 'ips lost');
});

await check('order/calc mix: код пакета уезжает в mixId', () => {
    const payload = prolongClient.prepareMix('europe-2-mix_IPv4', '1m', 10, null, null, null);
    assertEqual(payload.mixId, 'europe-2-mix_IPv4', 'mixId lost');
    assert(!('countryId' in payload), `countryId must not be sent, got ${JSON.stringify(payload)}`);
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
