// The air conditioner as HomeKit sees it: a heater-cooler, which is the one service Apple Home
// draws with a range slider rather than a single setpoint. That slider is the whole point - it is
// what AUTO needs, and what the Sensibo fork exposes today.
//
// A note on how often this talks to the cloud, because dragging that slider is a trap. Apple Home
// sends a value for every position a finger passes through, so anything that reaches the network
// from an onSet handler multiplies by however far the finger travelled. Nothing here does: moving
// the band touches no API at all, and the only writes that follow a drag are the ones the room
// actually calls for, once the finger stops.

import AutoController, { ACTION, normaliseBand } from '../auto.js';
import { MODE } from '../cloud/ac.js';

/** What the remote itself accepts, and the furthest these bounds can be pushed. */
const COLDEST = 16;
const WARMEST = 32;

/**
 * @param {number} value A configured bound.
 * @returns {number} It, unless it is outside what the remote takes - the remote would refuse those.
 */
function clamp(value) {
  return Math.min(WARMEST, Math.max(COLDEST, value));
}

/** How long to wait after the last movement of a slider before acting on where it ended up. */
const BAND_SETTLE_MS = 3000;
const FAN_SETTLE_MS = 1500;

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

    // The last reading, so the band can be judged against the room without asking again. The poll
    // keeps it current; nothing else needs to.
    this.lastState = null;

    // What HomeKit has been shown, so a poll that changes nothing says nothing.
    this.shown = {};

    // Sliders in flight.
    this.bandTimer = null;
    this.fanTimer = null;

    // How many commands are on their way to the hub. A reading taken while one is in flight shows
    // the state from before it, and reporting that flips the tile to whatever we are in the middle
    // of changing - which in the Sensibo fork showed up as the accessory switching itself off.
    this.inFlight = 0;

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
    //
    // Half a degree, because the band is this plugin's own to keep - it is compared against the
    // hub's thermometer, which reads hundredths, and never sent to the air conditioner as it
    // stands. The setpoint that does reach the remote is rounded on the way out, since the trait
    // only takes whole degrees.
    //
    // The bounds are narrowed to taste: what the remote accepts is 16-32, and dragging across all
    // of it to reach the four degrees anyone actually uses is a chore. Anything outside what the
    // remote takes is ignored rather than honoured.
    const minValue = clamp(platform.config.minTemperature ?? 16);
    const maxValue = clamp(platform.config.maxTemperature ?? 32);

    for (const characteristic of [Characteristic.CoolingThresholdTemperature, Characteristic.HeatingThresholdTemperature]) {
      this.service.getCharacteristic(characteristic)
        .setProps({ minValue, maxValue, minStep: platform.config.temperatureStep ?? 0.5 })
        .onSet(value => this.setThreshold(characteristic, value));
    }

    // A brand new accessory arrives holding HomeKit's own defaults, which sit outside what this
    // air conditioner accepts and would show as a band spanning the whole dial. A restored one
    // keeps whatever it was last set to.
    this.settleThreshold(Characteristic.HeatingThresholdTemperature, platform.config.defaultLow ?? 20);
    this.settleThreshold(Characteristic.CoolingThresholdTemperature, platform.config.defaultHigh ?? 26);

    // The fan slider is off by default. AUTO sets the speed itself and nothing else here needs it,
    // so the tile is cleaner without it - and a slider nobody wanted is still a slider that
    // reports every position a finger passes through.
    this.showFanSpeed = platform.config.showFanSpeed === true;

    if (this.showFanSpeed) {
      // Four speeds, so each quarter of the slider is one of them.
      this.service.getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
        .onSet(value => this.setFanSpeed(value));
    } else if (this.service.testCharacteristic(Characteristic.RotationSpeed)) {
      // Left over from a configuration that did show it; a controller keeps whatever it was given.
      this.service.removeCharacteristic(this.service.getCharacteristic(Characteristic.RotationSpeed));
    }

    if (platform.config.showHumidity !== false) {
      this.humidity = accessory.getService(Service.HumiditySensor)
        ?? accessory.addService(Service.HumiditySensor, `${accessory.displayName} Humidity`);
    }
  }

  /**
   * Gives one end of the band a starting value, but only when what it holds is not a value this
   * air conditioner could have been set to - which is how a fresh accessory is told apart from one
   * restored with the band someone chose.
   *
   * @param {*} characteristic Which end.
   * @param {number} value What to start it at.
   * @returns {void}
   */
  settleThreshold(characteristic, value) {
    const current = this.service.getCharacteristic(characteristic).value;

    if (!Number.isFinite(current) || current < 16 || current > 32) {
      this.service.updateCharacteristic(characteristic, value);
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

  /**
   * The room as last read. Asking the cloud again for the sake of one slider movement is what
   * turns a drag into a burst of requests, so this is what the band is judged against.
   *
   * @returns {Promise<object>} The last reading, taking one now only if there has never been one.
   */
  async state() {
    if (!this.lastState) {
      this.lastState = await this.device.read();
    }

    return this.lastState;
  }

  /**
   * Runs one command, and while it is on its way marks the accessory as mid-change so a reading
   * taken in the same moment is not reported: it would carry the state from before the command and
   * flip the tile back to it.
   *
   * @param {Function} work The command.
   * @returns {Promise<*>} Whatever it returned.
   */
  async command(work) {
    this.inFlight += 1;

    try {
      return await work();
    } finally {
      this.inFlight -= 1;
    }
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
      await this.command(() => this.device.setPower(false));
      this.show(this.Characteristic.CurrentHeaterCoolerState, this.Characteristic.CurrentHeaterCoolerState.INACTIVE);
      return;
    }

    // Switched on in AUTO, the band decides whether anything should actually run; in COOL it runs.
    if (this.inAuto) {
      await this.applyAuto(await this.state(), { force: true });
      return;
    }

    await this.command(() => this.startCooling(this.band.high));
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
      await this.applyAuto(await this.state(), { force: true });
      return;
    }

    await this.command(() => this.startCooling(this.band.high));
  }

  /**
   * Moving the band touches no API. Apple Home reports every position the finger passes through,
   * and a reading taken for each of them is the burst of requests this design exists to avoid; the
   * room cannot have changed while a slider was being dragged anyway. Once it settles, the band is
   * judged against the reading the poll already has.
   *
   * @param {*} characteristic Which end of the band moved.
   * @param {number} value Where to.
   * @returns {void}
   */
  setThreshold(characteristic, value) {
    // Read the band now rather than when the timer fires. Anything that lands in the window and
    // touches these characteristics would otherwise be what gets acted on, and the change that was
    // actually asked for would be quietly undone - which is what happened in the Sensibo fork,
    // where dragging to 23.5-24.5 wrote back 23.2-24.
    const wanted = this.band;
    const isCoolingEnd = characteristic === this.Characteristic.CoolingThresholdTemperature;

    clearTimeout(this.bandTimer);

    this.bandTimer = setTimeout(() => {
      this.log.info('%s: band is now %s-%s', this.accessory.displayName, wanted.low, wanted.high);

      if (!this.isActive) {
        return;
      }

      if (this.inAuto) {
        this.state()
          .then(state => this.applyAuto(state, { band: wanted }))
          .catch(error => this.log.warn('%s: could not act on the new band: %s', this.accessory.displayName, error.message));
        return;
      }

      // In plain cooling the cooling end is the setpoint; the heating end is not used.
      if (isCoolingEnd) {
        this.command(() => this.device.setTargetTemperature(value))
          .catch(error => this.log.warn('%s: could not set the temperature: %s', this.accessory.displayName, error.message));
      }
    }, this.platform.config.settleMs ?? BAND_SETTLE_MS);
  }

  /**
   * Debounced for the same reason as the band: the speed slider reports every position too.
   *
   * @param {number} percent Where the speed slider was left.
   * @returns {void}
   */
  setFanSpeed(percent) {
    if (percent === 0) {
      return;
    }

    clearTimeout(this.fanTimer);

    this.fanTimer = setTimeout(() => {
      const speed = Math.min(4, Math.max(1, Math.round(percent / 25)));
      this.log.info('%s: fan speed %s', this.accessory.displayName, speed);
      this.command(() => this.device.setFanSpeed(speed))
        .catch(error => this.log.warn('%s: could not set the fan speed: %s', this.accessory.displayName, error.message));
    }, FAN_SETTLE_MS);
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
   * One pass of the AUTO loop. It is given the room rather than fetching it, so the same reading
   * serves the poll that took it and any band change that follows.
   *
   * @param {object} state What the room and the air conditioner were last seen doing.
   * @param {object} [options] How insistent to be.
   * @param {boolean} [options.force] Act even when nothing crossed a threshold, which is what a
   *   fresh switch into AUTO wants.
   * @returns {Promise<void>} Resolves once anything needed has been done.
   */
  async applyAuto(state, { force = false, band = this.band } = {}) {
    const decision = this.auto.decide(state?.roomTemperature, band);
    const setpoint = this.platform.config.autoTargetTemperature ?? 22;

    if (decision === ACTION.COOL || (force && this.auto.activity === 'cooling')) {
      this.log.info(
        '%s: %s°C is above the band %s-%s, cooling at %s°C on speed %s',
        this.accessory.displayName, state?.roomTemperature, band.low, band.high,
        setpoint, this.platform.config.autoFanSpeed ?? 1,
      );

      await this.command(async () => {
        await this.startCooling(setpoint);
        await this.device.setFanSpeed(this.platform.config.autoFanSpeed ?? 1);
      });
      return;
    }

    if (decision === ACTION.OFF || (force && this.auto.activity === 'idle')) {
      this.log.info(
        '%s: %s°C is within the band %s-%s, switching off',
        this.accessory.displayName, state?.roomTemperature, band.low, band.high,
      );
      await this.command(() => this.device.setPower(false));
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

    // Mid-change the reading is older than the command, so saying anything about what the air
    // conditioner is doing would undo what was just asked for.
    if (this.inFlight > 0) {
      return;
    }

    // In AUTO the controller is the one switching the unit, so its own idea of whether it is
    // running is ahead of anything the hub can say - and the hub cannot really say, since infrared
    // gives it nothing to read back.
    const running = this.inAuto ? this.auto.activity === 'cooling' : this.device.isRunning(state);

    this.show(
      Characteristic.CurrentHeaterCoolerState,
      running ? Characteristic.CurrentHeaterCoolerState.COOLING : Characteristic.CurrentHeaterCoolerState.IDLE,
    );

    if (this.showFanSpeed && Number.isFinite(state.fanSpeed)) {
      this.show(Characteristic.RotationSpeed, state.fanSpeed * 25);
    }
  }

  /**
   * The scheduled pass, and the only thing here that reads the cloud on a timer: one reading, used
   * both to tell HomeKit what the room is doing and to let AUTO act on it.
   *
   * @returns {Promise<void>} Resolves once the pass is done.
   */
  async poll() {
    try {
      this.lastState = await this.device.read();
      this.report(this.lastState);

      if (this.isActive && this.inAuto) {
        await this.applyAuto(this.lastState);
      }
    } catch (error) {
      this.log.debug('%s: could not reach the hub: %s', this.accessory.displayName, error.message);
    }
  }

  /** @returns {void} Drops anything waiting, for a Homebridge that is shutting down. */
  stop() {
    clearTimeout(this.bandTimer);
    clearTimeout(this.fanTimer);
  }
}
