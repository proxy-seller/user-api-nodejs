import axios from 'axios';

class ProxySellerUserApi {
    URL = 'https://proxy-seller.com/personal/api/v1/';
    paymentId = 1
    generateAuth = 'N'

    /**
     * Key placed in https://proxy-seller.com/personal/api/
     * @param {*} config
     * @throws Error
     */
    constructor(config = {}) {
        if (!config.key) {
            throw new Error('Need key, placed in https://proxy-seller.com/personal/api/');
        }
        config.headers = { 'Content-Type': 'application/json' };
        config.baseURL = this.URL + config.key + "/";
        this.config = config;
    }

    /**
     * Payment id=1(inner balance), id=43(subscribed card)
     * @param integer id 
     */
    setPaymentId(id) {
        this.paymentId = id
    }

    getPaymentId() {
        return this.paymentId
    }

    /**
     * Generate new auths Y/N, default N
     * @param string yn 
     */
    setGenerateAuth(yn) {
        this.generateAuth = (yn == 'Y' ? "Y" : "N");
    }

    getGenerateAuth() {
        return this.generateAuth
    }

    /**
     * Send request into server
     * @param string method
     * @param string uri
     * @param {*} options
     * @return mixed
     * @throws Error
     */
    async request(method, uri, options = {}) {
        const response = await axios.request({
            method: method,
            url: uri,
            ...options,
            ...this.config
        });

        if (response.data instanceof Object) {
            if (response.data.status && response.data.status === 'success') {
                return response.data.data;
            } else if (response.data.errors) {
                throw new Error(response.data.errors[0].message);
            }
        }
        return response.data;
    }

    /////////////////////////////// Auth ///////////////////////////////

    /**
     * Get auths
     * @return array Returns list auths
     */
    async authList() {
        return this.request('GET', 'auth/list');
    }

    /**
     * Set auth active state
     * @param integer auth id
     * @param string active state (Y/N)
     * @return string Returns current auth
     */
    async authActive(id, active) {
        return this.request('POST', 'auth/active', { data: { id: id, active: active } });
    }

    /////////////////////////////// Balance ///////////////////////////////

    /**
     * Get balance statistic
     * @return float
     */
    async balance() {
        const response = await this.request('get', 'balance/get');
        return response.summ;
    }

    /**
     * Replenish the balance
     * @param float summ
     * @param integer paymentId
     * @return string Returns a link to the payment page
     * https://proxy-seller.com/personal/pay/?ORDER_ID=123456789&PAYMENT_ID=987654321&HASH=343bd596fb97c04bfb76557710837d34
     */
    async balanceAdd(summ = 5, paymentId = 29) {
        const response = await this.request('post', 'balance/add', { data: { summ: summ, paymentId: paymentId } });
        return response.url;
    }

    /**
     * List of payment systems for balance replenishing
     * @return array Example items:
     * [
     *   [
     *      'id' => '29',
     *      'name' =>'PayPal'
     *   ],
     *   [
     *      'id' => '37',
     *      'name' => 'Visa / MasterCard'
     *   ]
     * ]
     */
    async balancePaymentsList() {
        const response = await this.request('get', 'balance/payments/list');
        return response.items;
    }

    /////////////////////////////// Order ///////////////////////////////

    /**
     * Necessary guides for creating an order
     * - Countries + operators and rotation periods (mobile only)
     * - Proxy periods
     * - Purposes and services (only for ipv4,ipv6,isp,mix,mix_isp,resident)
     * - Quantities allowed (only for mix proxy)
     * @param string type - ipv4 | ipv6 | mobile | isp | mix | ''
     * @return array
     */
    async referenceList(type = '') {
        const response = await this.request('get', 'reference/list/' + type);
        return response;
    }
    /**
     * Calculate the order IPv4
     * Preliminary order calculation
     * An error in warning must be corrected before placing an order.
     * @param integer countryId
     * @param integer periodId
     * @param integer quantity
     * @param string authorization
     * @param string coupon
     * @param string customTargetName
     * @return array Example
     * [
     *     'warning' => 'Insufficient funds. Total $2. Not enough $33.10',
     *     'balance' => 2,
     *     'total' => 35.1,
     *     'quantity' => 5,
     *     'currency' => 'USD',
     *     'discount' => 0.22,
     *     'price' => 7.02
     * ]
     */
    async orderCalcIpv4(countryId, periodId, quantity, authorization, coupon, customTargetName) {
        const json = this.prepareIpv4(countryId, periodId, quantity, authorization, coupon, customTargetName);
        return this.orderCalc(json);
    }

    /**
     * Calculate the order ISP
     * Preliminary order calculation
     * An error in warning must be corrected before placing an order.
     * @param integer countryId
     * @param integer periodId
     * @param integer quantity
     * @param string authorization
     * @param string coupon
     * @param string customTargetName
     * @return array Example
     * [
     *     'warning' => 'Insufficient funds. Total $2. Not enough $33.10',
     *     'balance' => 2,
     *     'total' => 35.1,
     *     'quantity' => 5,
     *     'currency' => 'USD',
     *     'discount' => 0.22,
     *     'price' => 7.02
     * ]
     */
    async orderCalcIsp(countryId, periodId, quantity, authorization, coupon, customTargetName) {
        const json = this.prepareIpv4(countryId, periodId, quantity, authorization, coupon, customTargetName);
        return this.orderCalc(json);
    }
    /**
     * Calculate the order MIX
     * Preliminary order calculation
     * An error in warning must be corrected before placing an order.
     * @param integer countryId
     * @param integer periodId
     * @param integer quantity
     * @param string authorization
     * @param string coupon
     * @param string customTargetName
     * @return array Example
     * [
     *     'warning' => 'Insufficient funds. Total $2. Not enough $33.10',
     *     'balance' => 2,
     *     'total' => 35.1,
     *     'quantity' => 5,
     *     'currency' => 'USD',
     *     'discount' => 0.22,
     *     'price' => 7.02
     * ]
     */
    async orderCalcMix(countryId, periodId, quantity, authorization, coupon, customTargetName) {
        const json = this.prepareIpv4(countryId, periodId, quantity, authorization, coupon, customTargetName);
        return this.orderCalc(json);
    }
    /**
     * Calculate the order IPv6
     * Preliminary order calculation
     * An error in warning must be corrected before placing an order.
     * @param integer countryId
     * @param integer periodId
     * @param integer quantity
     * @param string authorization
     * @param string coupon
     * @param string customTargetName
     * @param string protocol
     * @return array Example
     * [
     *     'warning' => 'Insufficient funds. Total $2. Not enough $33.10',
     *     'balance' => 2,
     *     'total' => 35.1,
     *     'quantity' => 5,
     *     'currency' => 'USD',
     *     'discount' => 0.22,
     *     'price' => 7.02
     * ]
     */
    async orderCalcIpv6(countryId, periodId, quantity, authorization, coupon, customTargetName, protocol) {
        const json = this.prepareIpv6(countryId, periodId, quantity, authorization, coupon, customTargetName, protocol);
        return this.orderCalc(json);
    }
    /**
     * Calculate the order Mobile
     * Preliminary order calculation
     * An error in warning must be corrected before placing an order.
     * @param integer countryId
     * @param integer periodId
     * @param integer quantity
     * @param string authorization
     * @param string coupon
     * @param integer operatorId
     * @param integer rotationId
     * @return array Example
     * [
     *     'warning' => 'Insufficient funds. Total $2. Not enough $33.10',
     *     'balance' => 2,
     *     'total' => 35.1,
     *     'quantity' => 5,
     *     'currency' => 'USD',
     *     'discount' => 0.22,
     *     'price' => 7.02
     * ]
     */
    async orderCalcMobile(countryId, periodId, quantity, authorization, coupon, operatorId, rotationId) {
        const json = this.prepareMobile(countryId, periodId, quantity, authorization, coupon, operatorId, rotationId);
        return this.orderCalc(json);
    }

    /**
     * Calculate the order Resident
     * Preliminary order calculation
     * An error in warning must be corrected before placing an order.
     * @param integer tarifId
     * @param string coupon
     * @return array Example
     * [
     *     'warning' => 'Insufficient funds. Total $2. Not enough $33.10',
     *     'balance' => 2,
     *     'total' => 35.1,
     *     'quantity' => 5,
     *     'currency' => 'USD',
     *     'discount' => 0.22,
     *     'price' => 7.02
     * ]
     */
    async orderCalcResident(tarifId, coupon) {
        const json = this.prepareResident(tarifId, coupon);
        return this.orderCalc(json);
    }


    /**
     * Create an order IPv4
     * Attention! Calling this method will deduct $ from your balance!
     * The parameters are identical to the /order/calc method. Practice there before calling the /order/make method.
     * @param integer countryId
     * @param integer periodId
     * @param integer quantity
     * @param string authorization
     * @param string coupon
     * @param string customTargetName
     * @return array Example
     * [
     *     'orderId' => 1000000,
     *     'total' => 35.1,
     *     'balance' => 10.19
     * ]
     */
    async orderMakeIpv4(countryId, periodId, quantity, authorization, coupon, customTargetName) {
        const json = this.prepareIpv4(countryId, periodId, quantity, authorization, coupon, customTargetName);
        return this.orderMake(json);
    }
    /**
     * Create an order ISP
     * Attention! Calling this method will deduct $ from your balance!
     * The parameters are identical to the /order/calc method. Practice there before calling the /order/make method.
     * @param integer countryId
     * @param integer periodId
     * @param integer quantity
     * @param string authorization
     * @param string coupon
     * @param string customTargetName
     * @return array Example
     * [
     *     'orderId' => 1000000,
     *     'total' => 35.1,
     *     'balance' => 10.19
     * ]
     */
    async orderMakeIsp(countryId, periodId, quantity, authorization, coupon, customTargetName) {
        const json = this.prepareIpv4(countryId, periodId, quantity, authorization, coupon, customTargetName);
        return this.orderMake(json);
    }
    /**
     * Create an order MIX
     * Attention! Calling this method will deduct $ from your balance!
     * The parameters are identical to the /order/calc method. Practice there before calling the /order/make method.
     * @param integer countryId
     * @param integer periodId
     * @param integer quantity
     * @param string authorization
     * @param string coupon
     * @param string customTargetName
     * @return array Example
     * [
     *     'orderId' => 1000000,
     *     'total' => 35.1,
     *     'balance' => 10.19
     * ]
     */
    async orderMakeMix(countryId, periodId, quantity, authorization, coupon, customTargetName) {
        const json = this.prepareIpv4(countryId, periodId, quantity, authorization, coupon, customTargetName);
        return this.orderMake(json);
    }
    /**
     * Create an order IPv6
     * Attention! Calling this method will deduct $ from your balance!
     * The parameters are identical to the /order/calc method. Practice there before calling the /order/make method.
     * @param integer countryId
     * @param integer periodId
     * @param integer quantity
     * @param string authorization
     * @param string coupon
     * @param string customTargetName
     * @param string protocol
     * @return array Example
     * [
     *     'orderId' => 1000000,
     *     'total' => 35.1,
     *     'balance' => 10.19
     * ]
     */
    async orderMakeIpv6(countryId, periodId, quantity, authorization, coupon, customTargetName, protocol) {
        const json = this.prepareIpv6(countryId, periodId, quantity, authorization, coupon, customTargetName, protocol);
        return this.orderMake(json);
    }
    /**
     * Create an order Mobile
     * Attention! Calling this method will deduct $ from your balance!
     * The parameters are identical to the /order/calc method. Practice there before calling the /order/make method.
     * @param integer countryId
     * @param integer periodId
     * @param integer quantity
     * @param string authorization
     * @param string coupon
     * @param integer operatorId
     * @param integer rotationId
     * @return array Example
     * [
     *     'orderId' => 1000000,
     *     'total' => 35.1,
     *     'balance' => 10.19
     * ]
     */
    async orderMakeMobile(countryId, periodId, quantity, authorization, coupon, operatorId, rotationId) {
        const json = this.prepareMobile(countryId, periodId, quantity, authorization, coupon, operatorId, rotationId);
        return this.orderMake(json);
    }

    /**
     * Create an order Resident
     * Attention! Calling this method will deduct $ from your balance!
     * The parameters are identical to the /order/calc method. Practice there before calling the /order/make method.
     * @param integer $tarifId
     * @param string $coupon
     * @return array Example
     * [
     *     'orderId' => 1000000,
     *     'total' => 35.1,
     *     'balance' => 10.19
     * ]
     */
    async orderMakeResident(tarifId, coupon) {
        const json = this.prepareResident(tarifId, coupon);
        return this.orderMake(json);
    }


    prepareIpv4(countryId, periodId, quantity, authorization, coupon, customTargetName) {
        return {
            paymentId: this.paymentId,
            generateAuth: this.generateAuth,
            countryId: countryId,
            periodId: periodId,
            quantity: quantity,
            authorization: authorization,
            coupon: coupon,
            customTargetName: customTargetName,
        };
    }

    prepareIpv6(countryId, periodId, quantity, authorization, coupon, customTargetName, protocol) {
        return {
            paymentId: this.paymentId,
            generateAuth: this.generateAuth,
            countryId: countryId,
            periodId: periodId,
            quantity: quantity,
            authorization: authorization,
            coupon: coupon,
            customTargetName: customTargetName,
            protocol: protocol
        };
    }

    prepareMobile(countryId, periodId, quantity, authorization, coupon, operatorId, rotationId) {
        return {
            paymentId: this.paymentId,
            generateAuth: this.generateAuth,
            countryId: countryId,
            periodId: periodId,
            quantity: quantity,
            authorization: authorization,
            coupon: coupon,
            operatorId: operatorId,
            rotationId: rotationId
        };
    }

    prepareResident(tarifId, coupon) {
        return {
            paymentId: this.paymentId,
            tarifId: tarifId,
            coupon: coupon
        };
    }

    /**
     * Calculate the order
     * @param array json Free format array to send into endpoint
     * @return array
     */
    async orderCalc(json) {
        return this.request('post', 'order/calc', { data: json });
    }
    /**
     * Create an order
     * @param array json Free format array to send into endpoint
     * @return array
     */
    async orderMake(json) {
        return this.request('post', 'order/make', { data: json });
    }

    /////////////////////////////// Prolong ///////////////////////////////
    prepareProlong(ids, periodId, coupon) {
        return {
            ids: ids,
            periodId: periodId,
            coupon: coupon
        };
    }
    /**
     * Calculate the renewal
     * @param string type - ipv4 | ipv6 | mobile | isp | mix
     * @param array ids
     * @param string periodId
     * @param string coupon
     * @return array Example
     * [
     *     'warning' => 'Insufficient funds. Total $2. Not enough $33.10',
     *     'balance' => 2,
     *     'total' => 35.1,
     *     'quantity' => 5,
     *     'currency' => 'USD',
     *     'discount' => 0.22,
     *     'price' => 7.02,
     *     'items' => [],
     *     'orders' => 1
     * ]
     */
    async prolongCalc(type, ids, periodId, coupon = '') {
        return this.request('post', 'prolong/calc' + type, { data: this.prepareProlong(ids, periodId, coupon) });
    }
    /**
     * Create a renewal order
     * Attention! Calling this method will deduct $ from your balance!
     * The parameters are identical to the /prolong/calc method. Practice there before calling the /prolong/make method.
     * @param string type - ipv4 | ipv6 | mobile | isp | mix
     * @param array ids
     * @param string periodId
     * @param string coupon
     * @return array Example
     * [
     *     'orderId' => 1000000,
     *     'total' => 35.1,
     *     'balance' => 10.19
     * ]
     */
    async prolongMake(type, ids, periodId, coupon = '') {
        return this.request('post', 'prolong/make/' + type, { data: this.prepareProlong(ids, periodId, coupon) });
    }
    /////////////////////////////// Proxy ///////////////////////////////

    /**
     * Proxies list
     * @param string type - ipv4 | ipv6 | mobile | isp | mix | ''
     * @return array Example
     * [
     *     'id' => 9876543,
     *     'order_id' => 123456,
     *     'basket_id' => 9123456,
     *     'ip' => 127.0.0.2,
     *     'ip_only' => 127.0.0.2,
     *     'protocol' => 'HTTP',
     *     'port_socks' => 50101,
     *     'port_http' => 50100,
     *     'login' => 'login',
     *     'password' => 'password',
     *     'auth_ip' => '',
     *     'rotation' => '',
     *     'link_reboot' => '#',
     *     'country' => 'France',
     *     'country_alpha3' => 'FRA',
     *     'status' => 'Active',
     *     'status_type' => 'ACTIVE',
     *     'can_prolong' => 1,
     *     'date_start' => '26.06.2023',
     *     'date_end' => '26.07.2023',
     *     'comment' => '',
     *     'auto_renew' => 'Y',
     *     'auto_renew_period' => ''
     * ]
     */
    async proxyList(type = '') {
        return this.request('get', 'proxy/list/' + type);
    }

    /**
     * Proxy export of certain type in txt or csv
     * @param string type - ipv4 | ipv6 | mobile | isp | mix
     * @param string ext - txt | csv
     * @param string proto - https | socks5 | ''
     * @param integer listId - only for resident, if not set - will return ip from all sheets
     * @return string Example
     * login:password@127.0.0.2:50100
     */
    async proxyDownload(type, ext = '', proto = '', listId = 0) {
        return this.request('get', 'proxy/download/' + type, { params: { ext: ext, proto: proto, listId: listId  } });
    }

    /**
     * Set proxy comment
     * @param array ids Any id, regardless of the type of proxy
     * @param string comment
     * @return integer Count updated proxy
     */
    async proxyCommentSet(ids, comment = '') {
        const response = await this.request('post', 'proxy/comment/set', { data: { ids: ids, comment: comment } });
        return response.updated;
    }
    /////////////////////////////// Tools ///////////////////////////////

    /**
     * Check single proxy
     * @param string proxy Available values - user:password@127.0.0.1:8080, user@127.0.0.1:8080, 127.0.0.1:8080
     * @return array Example result:
     *  [
     *      'ip' => '127.0.0.1',
     *      'port' => 8080,
     *      'user' => 'user',
     *      'password' => 'password',
     *      'valid' => true,
     *      'protocol' => 'HTTP',
     *      'time' => 1234
     *  ]
     */
    async proxyCheck(proxy) {
        return this.request('get', 'tools/proxy/check', { params: { proxy: proxy } });
    }
    /////////////////////////////// System ///////////////////////////////

    /**
     * Check service availability
     * @return timestamp
     */
    async ping() {
        const response = await this.request('get', 'system/ping');
        return response.pong;
    }
    
    /////////////////////////////// Resident ///////////////////////////////

    /**
     * Package Information
     * Remaining traffic, end date
     * @return array Example
     * [
     *     'is_active': true,
     *     'rotation': 60,
     *     'tarif_id': 2,
     *     'traffic_limit': 7516192768,
     *     'traffic_usage': 10,
     *     'expired_at': "d.m.Y H:i:s",
     *     'auto_renew': false
     * ]
     */
    async residentPackage() {
        return this.request('get', 'resident/package');
    }

    /**
     * Database geo locations (zip ~300Kb, unzip ~3Mb)
     * @return binary
     */
    async residentGeo() {
        return this.request('get', 'resident/geo');
    }

    /**
     * List of existing ip list in a package
     * You can download the list via endpoint /proxy/download/resident?listId=123
     * @return array
     */
    async residentList() {
        return this.request('get', 'resident/lists');
    }

    /**
     * Rename list in user package
     * @param integer id - listId
     * @param string title
     * @return array Updated list model
     */
    async residentListRename(id, title) {
        return this.request('post', 'resident/list/rename', { data: { id: id, title: title } });
    }

    /**
     * Remove list from user package
     * @param integer id - listId
     * @return array Updated list model
     */
    async residentListDelete(id) {
        return this.request('delete', 'resident/list/delete', { params: { id: id } });
    }
}

export default ProxySellerUserApi;