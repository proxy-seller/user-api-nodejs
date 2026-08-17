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
            enabled: true, threshold: 5, amount: 25, subscriptionId: 'sub_1',
            dailyCountCap: 3, monthlyAmountCap: 300
        }),
        {
            enabled: true, threshold: 5, amount: 25, subscriptionId: 'sub_1',
            dailyCountCap: 3, monthlyAmountCap: 300
        }
    );
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

/////////////////////////////// итог ///////////////////////////////

if (failures.length > 0) {
    console.error(`selfcheck FAILED: ${failures.length} of ${passed + failures.length}`);
    for (const failure of failures) {
        console.error(`  - ${failure}`);
    }
    process.exit(1);
}

console.log(`selfcheck OK: ${passed} checks passed`);
