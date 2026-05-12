# proxy-seller nodejs api

Install from [npmjs.com](https://www.npmjs.com/package/proxy-seller-user-api)
```sh
npm i proxy-seller-user-api
```

Or manual install from [proxy-seller/user-api-nodejs](https://github.com/proxy-seller/user-api-nodejs) repository
```sh
npm install https://github.com/proxy-seller/user-api-nodejs.git
```

## Quick start
Get API key [here](https://proxy-seller.com/personal/api/)
```nodejs
import ProxySellerUserApi from 'proxy-seller-user-api';
const api = new ProxySellerUserApi({ key: 'YOUR_API_KEY' })
// api.setPaymentId(1)
// api.setGenerateAuth('N')
console.log(await api.balance())
```

## Changelog
```
22.01.2024
Breaking changes:
! remove targetId and targetSectionId from all calc/make requests
! add listId into proxyDownload method

New methods:
+ setPaymentId() - used in all calc/make requests (payment id=1(inner balance), id=43(subscribed card))
+ setGenerateAuth() - used in all calc/make requests (Y/N, default N)

+ authList
+ authActive
+ orderCalcResident
+ orderMakeResident
+ residentPackage
+ residentGeo
+ residentList
+ residentListRename
+ residentListDelete
```

## Methods available:
* authList
* authActive
* balance
* balanceAdd
* balancePaymentsList
* referenceList
* orderCalcIpv4
* orderCalcIsp
* orderCalcMix
* orderCalcIpv6
* orderCalcMobile
* orderCalcResident
* orderMakeIpv4
* orderMakeIsp
* orderMakeMix
* orderMakeIpv6
* orderMakeMobile
* orderMakeResident
* prolongCalc
* prolongMake
* proxyList
* proxyDownload
* proxyCommentSet
* proxyCheck
* ping
* residentPackage
* residentGeo
* residentList
* residentListRename
* residentListDelete