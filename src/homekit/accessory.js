// The air conditioner as HomeKit sees it: a heater-cooler, which is the one service Apple Home
// draws with a range slider rather than a single setpoint. That slider is the whole point - it is
// what AUTO needs, and what the Sensibo fork exposes today.

import AutoController, { ACTION, normaliseBand } from '../auto.js';
import { MODE } from '../cloud/ac.js';

export default class AirConditionerAccessory {
  /**
   * @param {object} platform The platform, for its logger, config and HAP handles.
   * @param {object} accessory The Homebridge accessory to furnish.
   * @param {object} device An {@link AqaraAirConditioner}.
   */
  constructor(platform, accessory, device) {
    this.platform = platform;
    this.accessory = accessory;
    this.device = device;
    this.log = platform.log;

    const { Service, Characteristic } = platform.api.hap;
    this.Characteristic = Characteristic;

    this.auto = new AutoController({ deadband: platform.config.deadband ?? 0.2 });

    // What HomeKit has been shown, so a poll that changes nothing says nothing.
    this.shown = {};

    accessory.getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Aqara')
      .setCharacteristic(Characteristic.Model, 'Hub M200 infrared air conditioner')
      .setCharacteristic(Characteristic.SerialNumber, device.did);

    this.service = accessory.getService(Service.HeaterCooler)
      ?? accessory.addService(Service.HeaterCooler, accessory.displayName);

    this.service.getCharacteristic(Characteristic.Active)
      .onSet(value => this.setActive(value === Characteristic.Active.ACTIVE));

    // Cooling only: the remote can heat, but a plugin that offers heat has to decide what AUTO
    // means with both ends live, and this room only ever cools.
    this.service.getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: [Characteristic.TargetHeaterCoolerState.AUTO, Characteristic.TargetHeaterCoolerState.COOL] })
      .onSet(value => this.setTargetState(value));

    // The two ends of the band. In COOL only the cooling end is used, as the setpoint.
    for (const characteristic of [Characteristic.CoolingThresholdTemperature, Characteristic.HeatingThresholdTemperature]) {
      this.service.getCharacteristic(characteristic)
        .setProps({ minValue: 16, maxValue: 32, minStep: platform.config.temperatureStep ?? 1 })
        .onSet(value => this.setThreshold(characteristic, value));
    }

    // Four speeds, so each quarter of the slider is one of them.
    this.service.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
      .onSet(value => this.setFanSpeed(value));

    if (platform.config.showHumidity !== false) {
      this.humidity = accessory.getService(Service.HumiditySensor)
        ?? accessory.addService(Service.HumiditySensor, `${accessory.displayName} Humidity`);
    }
  }

  /** @returns {{low: number, high: number}} The band HomeKit is currently asking for. */
  get band() {
    return normaliseBand({
      low: this.service.getCharacteristic(this.Characteristic.HeatingThresholdTemperature).value,
      high: this.service.getCharacteristic(this.Characteristic.CoolingThresholdTemperature).value,
    });
  }

  /** @returns {boolean} Whether HomeKit is asking for AUTO rather than plain cooling. */
  get inAuto() {
    return this.service.getCharacteristic(this.Characteristic.TargetHeaterCoolerState).value
      === this.Characteristic.TargetHeaterCoolerState.AUTO;
  }

  /** @returns {boolean} Whether HomeKit has the accessory switched on at all. */
  get isActive() {
    return this.service.getCharacteristic(this.Characteristic.Active).value
      === this.Characteristic.Active.ACTIVE;
  }

  /**
   * Shows HomeKit a value, unless it already has it.
   *
   * @param {*} characteristic Which one.
   * @param {*} value What it should read.
   * @returns {void}
   */
  show(characteristic, value) {
    if (value === undefined || value === null || Number.isNaN(value)) {
      return;
    }

    const key = characteristic.UUID;
    if (this.shown[key] === value) {
      return;
    }

    this.shown[key] = value;
    this.service.updateCharacteristic(characteristic, value);
  }

  /* ---------- what HomeKit asks for ---------- */

  /**
   * @param {boolean} active Whether the air conditioner should be on.
   * @returns {Promise<void>} Resolves once it has been told.
   */
  async setActive(active) {
    this.log.info('%s: HomeKit switched it %s', this.accessory.displayName, active ? 'on' : 'off');

    if (!active) {
      this.auto.sync(false);
      await this.device.setPower(false);
      this.show(this.Characteristic.CurrentHeaterCoolerState, this.Characteristic.CurrentHeaterCoolerState.INACTIVE);
      return;
    }

    // Switched on in AUTO, the band decides whether anything should actually run; in COOL it runs.
    if (this.inAuto) {
      await this.applyAuto({ force: true });
      return;
    }

    await this.startCooling(this.band.high);
  }

  /**
   * @param {number} value The requested target state.
   * @returns {Promise<void>} Resolves once the air conditioner matches it.
   */
  async setTargetState(value) {
    const auto = value === this.Characteristic.TargetHeaterCoolerState.AUTO;
    this.log.info('%s: HomeKit asked for %s', this.accessory.displayName, auto ? 'AUTO' : 'COOL');

    if (!this.isActive) {
      return;
    }

    if (auto) {
      // Take the device's word for whether it is running, so the band picks up from reality.
      this.auto.sync(true);
      await this.applyAuto({ force: true });
      return;
    }

    await this.startCooling(this.band.high);
  }

  /**
   * @param {*} characteristic Which end of the band moved.
   * @param {number} value Where to.
   * @returns {Promise<void>} Resolves once the air conditioner has been told, if it needed telling.
   */
  async setThreshold(characteristic, value) {
    this.log.info('%s: band is now %s-%s', this.accessory.displayName, this.band.low, this.band.high);

    if (!this.isActive) {
      return;
    }

    if (this.inAuto) {
      await this.applyAuto({ force: false });
      return;
    }

    // In plain cooling the cooling end is the setpoint; the heating end is not used.
    if (characteristic === this.Characteristic.CoolingThresholdTemperature) {
      await this.device.setTargetTemperature(value);
    }
  }

  /**
   * @param {number} percent Where the speed slider was left.
   * @returns {Promise<void>} Resolves once the air conditioner has been told.
   */
  async setFanSpeed(percent) {
    if (percent === 0) {
      return;
    }

    const speed = Math.min(4, Math.max(1, Math.round(percent / 25)));
    this.log.info('%s: fan speed %s', this.accessory.displayName, speed);
    await this.device.setFanSpeed(speed);
  }

  /* ---------- the loop ---------- */

  /**
   * Starts the air conditioner cooling, at a setpoint. Mode and setpoint go before the power so
   * the unit does not run for a moment on whatever it was last left with.
   *
   * @param {number} setpoint What to ask the air conditioner for.
   * @returns {Promise<void>} Resolves once it is running.
   */
  async startCooling(setpoint) {
    await this.device.setMode(MODE.cool);
    await this.device.setTargetTemperature(setpoint);
    await this.device.setPower(true);
    this.show(this.Characteristic.CurrentHeaterCoolerState, this.Characteristic.CurrentHeaterCoolerState.COOLING);
  }

  /**
   * One pass of the AUTO loop: reads the room, and switches the air conditioner on or off if the
   * band says so.
   *
   * @param {object} [options] How insistent to be.
   * @param {boolean} [options.force] Apply the decision even when nothing changed, which is what a
   *   fresh switch into AUTO wants.
   * @returns {Promise<void>} Resolves once anything needed has been done.
   */
  async applyAuto({ force = false } = {}) {
    const state = await this.device.read();
    this.report(state);

    const decision = this.auto.decide(state.roomTemperature, this.band);
    const setpoint = this.platform.config.autoTargetTemperature ?? 22;

    if (decision === ACTION.COOL || (force && this.auto.activity === 'cooling')) {
      this.log.info(
        '%s: %s°C is above the band %s-%s, cooling at %s°C',
        this.accessory.displayName, state.roomTemperature, this.band.low, this.band.high, setpoint,
      );
      await this.startCooling(setpoint);
      await this.device.setFanSpeed(this.platform.config.autoFanSpeed ?? 1);
      return;
    }

    if (decision === ACTION.OFF || (force && this.auto.activity === 'idle')) {
      this.log.info(
        '%s: %s°C is within the band %s-%s, switching off',
        this.accessory.displayName, state.roomTemperature, this.band.low, this.band.high,
      );
      await this.device.setPower(false);
      this.show(this.Characteristic.CurrentHeaterCoolerState, this.Characteristic.CurrentHeaterCoolerState.IDLE);
    }
  }

  /**
   * Shows HomeKit what the room and the air conditioner are doing.
   *
   * @param {object} state What the device read.
   * @returns {void}
   */
  report(state) {
    const { Characteristic } = this.platform.api.hap;

    this.show(Characteristic.CurrentTemperature, state.roomTemperature);

    if (this.humidity && state.roomHumidity !== undefined) {
      this.humidity.updateCharacteristic(Characteristic.CurrentRelativeHumidity, Math.round(state.roomHumidity));
    }

    if (!this.isActive) {
      this.show(Characteristic.CurrentHeaterCoolerState, Characteristic.CurrentHeaterCoolerState.INACTIVE);
      return;
    }

    const running = this.device.isRunning(state);

    this.show(
      Characteristic.CurrentHeaterCoolerState,
      running ? Characteristic.CurrentHeaterCoolerState.COOLING : Characteristic.CurrentHeaterCoolerState.IDLE,
    );

    if (Number.isFinite(state.fanSpeed)) {
      this.show(Characteristic.RotationSpeed, state.fanSpeed * 25);
    }
  }

  /**
   * The scheduled pass: report what the room reads, and let AUTO act on it.
   *
   * @returns {Promise<void>} Resolves once the pass is done.
   */
  async poll() {
    try {
      if (this.isActive && this.inAuto) {
        await this.applyAuto();
        return;
      }

      this.report(await this.device.read());
    } catch (error) {
      this.log.debug('%s: could not reach the hub: %s', this.accessory.displayName, error.message);
    }
  }
}
