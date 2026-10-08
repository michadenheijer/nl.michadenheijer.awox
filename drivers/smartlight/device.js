'use strict';

const Homey = require('homey');

const normalize = uuid => uuid.replace(/-/g, '').toLowerCase();

const SERVICE_STATE = normalize('33160fb9-5b27-4e70-b0f8-ff411e3ae078');
const SERVICE_WHITE = normalize('fff6fe25-469d-42bc-9179-b3a093f19032');
const CHAR_STATE = normalize('217887f8-0af2-4002-9c05-24c9ecf71600');
const CHAR_TEMP = normalize('5b430c99-cb06-4c66-be2c-b538acfd1961');
const CHAR_BRIGHTNESS = normalize('d8da934c-3d8f-4bdf-9230-f61295b69570');

const BRIGHTNESS_MAX = 0x73;
const TEMP_MAX = 0x7f;

const RECONNECT_DELAYS_MS = [2000, 5000, 10000, 30000, 60000];
const UNRESPONSIVE_DELAY_MS = 5 * 60 * 1000;
const UNRESPONSIVE_AFTER_TIMEOUTS = 3;
const UNAVAILABLE_AFTER_ATTEMPTS = 3;
const WRITE_RETRY_DELAY_MS = 1000;
const DEFAULT_POLL_INTERVAL_S = 60;

const clamp01 = x => Math.max(0, Math.min(1, x));
const isTimeout = err => /timeout/i.test(err && err.message ? err.message : '');

class SmartLightDevice extends Homey.Device {
  async onInit() {
    this.peripheral = null;
    this.chars = null;
    this.connecting = null;
    this.reconnectTimer = null;
    this.pollTimer = null;
    this.reconnectAttempt = 0;
    this.consecutiveTimeouts = 0;
    this.stopped = false;
    this.queue = Promise.resolve();

    this.registerCapabilityListener('onoff', value => this.enqueue(() => this.setPower(value)));
    this.registerCapabilityListener('dim', value => this.enqueue(() => this.setDim(value)));
    this.registerCapabilityListener('light_temperature', value =>
      this.enqueue(() => this.writeByte(CHAR_TEMP, Math.round(clamp01(value) * TEMP_MAX))));

    this.startPolling(this.getSetting('poll_interval'));
    this.ensureConnected().catch(err => this.scheduleReconnect(err));
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('poll_interval')) {
      this.startPolling(newSettings.poll_interval);
    }
  }

  startPolling(intervalSeconds) {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    this.pollTimer = null;
    const seconds = Number.isFinite(intervalSeconds) ? intervalSeconds : DEFAULT_POLL_INTERVAL_S;
    if (seconds <= 0) {
      this.log('polling disabled');
      return;
    }
    this.pollTimer = this.homey.setInterval(() => this.poll(), seconds * 1000);
    this.log(`polling every ${seconds}s`);
  }

  poll() {
    if (!this.chars || this.connecting || this.stopped) return;
    this.enqueue(() => this.readState()).catch(err => {
      this.log(`poll failed (${err.message})`);
      this.dropConnection();
      this.scheduleReconnect(err);
    });
  }

  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  async setPower(on) {
    await this.writeByte(CHAR_STATE, on ? 1 : 0);
  }

  async setDim(value) {
    if (value <= 0) {
      await this.writeByte(CHAR_STATE, 0);
      await this.setCapabilityValue('onoff', false).catch(this.error);
      return;
    }
    await this.writeByte(CHAR_BRIGHTNESS, Math.max(1, Math.round(clamp01(value) * BRIGHTNESS_MAX)));
    if (!this.getCapabilityValue('onoff')) {
      await this.writeByte(CHAR_STATE, 1);
      await this.setCapabilityValue('onoff', true).catch(this.error);
    }
  }

  async writeByte(charUuid, value) {
    const payload = Buffer.from([value]);
    const hadConnection = Boolean(this.chars);
    try {
      await this.ensureConnected();
      await this.chars[charUuid].write(payload);
    } catch (err) {
      this.dropConnection();
      if (!hadConnection) {
        this.scheduleReconnect(err);
        throw this.userFacingError();
      }
      this.log(`write failed on open connection (${err.message}), retrying`);
      await new Promise(resolve => this.homey.setTimeout(resolve, WRITE_RETRY_DELAY_MS));
      try {
        await this.ensureConnected();
        await this.chars[charUuid].write(payload);
      } catch (retryErr) {
        this.scheduleReconnect(retryErr);
        throw this.userFacingError();
      }
    }
  }

  userFacingError() {
    const key = this.consecutiveTimeouts >= UNRESPONSIVE_AFTER_TIMEOUTS ? 'errors.unresponsive' : 'errors.unreachable';
    return new Error(this.homey.__(key));
  }

  ensureConnected() {
    if (this.chars) return Promise.resolve();
    if (this.stopped) return Promise.reject(new Error('Device is stopped'));
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  async connect() {
    const advertisement = await this.homey.ble.find(this.getStore().peripheralUuid);
    const peripheral = await advertisement.connect();

    try {
      const wanted = {
        [SERVICE_STATE]: [CHAR_STATE],
        [SERVICE_WHITE]: [CHAR_TEMP, CHAR_BRIGHTNESS],
      };
      const chars = {};
      for (const [serviceUuid, charUuids] of Object.entries(wanted)) {
        const service = await peripheral.getService(serviceUuid);
        for (const char of await service.discoverCharacteristics(charUuids)) {
          chars[normalize(char.uuid)] = char;
        }
      }
      for (const id of [CHAR_STATE, CHAR_TEMP, CHAR_BRIGHTNESS]) {
        if (!chars[id]) throw new Error(`Characteristic ${id} not found`);
      }

      peripheral.once('disconnect', () => this.onPeripheralDisconnect(peripheral));
      this.peripheral = peripheral;
      this.chars = chars;

      await this.subscribe();
      await this.readState();
    } catch (err) {
      this.dropConnection();
      await peripheral.disconnect().catch(() => {});
      throw err;
    }

    this.reconnectAttempt = 0;
    this.consecutiveTimeouts = 0;
    this.log('connected');
    await this.setAvailable().catch(this.error);
  }

  async readState() {
    const state = await this.chars[CHAR_STATE].read();
    const brightness = await this.chars[CHAR_BRIGHTNESS].read();
    const temp = await this.chars[CHAR_TEMP].read();
    this.log(`state=${state.toString('hex')} brightness=${brightness.toString('hex')} temp=${temp.toString('hex')}`);
    this.applyState(CHAR_STATE, state);
    this.applyState(CHAR_BRIGHTNESS, brightness);
    this.applyState(CHAR_TEMP, temp);
  }

  async subscribe() {
    for (const id of [CHAR_STATE, CHAR_BRIGHTNESS, CHAR_TEMP]) {
      await this.chars[id].subscribeToNotifications(data => this.applyState(id, data));
    }
  }

  applyState(charUuid, data) {
    if (!data || data.length === 0) return;
    const byte = data[0];
    if (charUuid === CHAR_STATE) {
      this.setCapabilityValue('onoff', byte === 1).catch(this.error);
    } else if (charUuid === CHAR_BRIGHTNESS) {
      this.setCapabilityValue('dim', clamp01(byte / BRIGHTNESS_MAX)).catch(this.error);
    } else if (charUuid === CHAR_TEMP) {
      this.setCapabilityValue('light_temperature', clamp01(byte / TEMP_MAX)).catch(this.error);
    }
  }

  onPeripheralDisconnect(peripheral) {
    if (peripheral !== this.peripheral) return;
    this.log('disconnected');
    this.dropConnection();
    this.scheduleReconnect(new Error('Bulb disconnected'));
  }

  dropConnection() {
    this.peripheral = null;
    this.chars = null;
  }

  scheduleReconnect(err) {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    this.consecutiveTimeouts = isTimeout(err) ? this.consecutiveTimeouts + 1 : 0;

    const unresponsive = this.consecutiveTimeouts >= UNRESPONSIVE_AFTER_TIMEOUTS;
    const delay = unresponsive
      ? UNRESPONSIVE_DELAY_MS
      : RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt - 1, RECONNECT_DELAYS_MS.length - 1)];

    this.log(`connect failed (${err.message}), retry ${this.reconnectAttempt} in ${delay / 1000}s`);

    if (unresponsive) {
      this.setUnavailable(this.homey.__('errors.unresponsive')).catch(this.error);
    } else if (this.reconnectAttempt >= UNAVAILABLE_AFTER_ATTEMPTS) {
      this.setUnavailable(this.homey.__('errors.unreachable')).catch(this.error);
    }

    this.reconnectTimer = this.homey.setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected().catch(e => this.scheduleReconnect(e));
    }, delay);
  }

  async shutdown() {
    this.stopped = true;
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    if (this.reconnectTimer) this.homey.clearTimeout(this.reconnectTimer);
    this.pollTimer = null;
    this.reconnectTimer = null;
    const { peripheral } = this;
    this.dropConnection();
    if (peripheral) await peripheral.disconnect().catch(() => {});
  }

  async onUninit() {
    await this.shutdown();
  }

  async onDeleted() {
    await this.shutdown();
  }
}

module.exports = SmartLightDevice;
