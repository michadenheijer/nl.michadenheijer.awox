'use strict';

const Homey = require('homey');

const NAME_PREFIX = 'SML';

class SmartLightDriver extends Homey.Driver {
  async onPairListDevices() {
    const advertisements = await this.homey.ble.discover();
    const bulbs = advertisements.filter(ad => (ad.localName || '').startsWith(NAME_PREFIX));
    this.log(`discovered ${advertisements.length} BLE devices, ${bulbs.length} SmartLIGHT bulbs`);

    return bulbs.map(ad => ({
      name: `AwoX ${ad.localName}`,
      data: { id: ad.uuid },
      store: { peripheralUuid: ad.uuid, address: ad.address },
    }));
  }
}

module.exports = SmartLightDriver;
