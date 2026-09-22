// HomeKit's AUTO mode, for an air conditioner that has no thermostat of its own.
//
// Sensibo can hand this to their cloud - Climate React watches the room and switches the unit on
// and off. Aqara has nothing of the kind: Privacy Mode is a sleep curve on a clock, not a loop on
// a sensor. So the loop lives here, fed by the hub's own thermometer.
//
// The shape is the one the Sensibo fork settled on: the band says WHEN the air conditioner runs,
// and a separate setpoint says how hard it works while it does. Switching the unit off between
// cycles rather than leaving it idling is the point - it is what stops the fan.

/** What the controller decides to do, and nothing more: applying it is the caller's job. */
export const ACTION = {
  /** Run the air conditioner, at the configured setpoint. */
  COOL: 'cool',
  /** Switch it off and let the room drift back up. */
  OFF: 'off',
  /** Leave it as it is. */
  HOLD: 'hold',
};

/**
 * A band with hysteresis. Crossing the top switches the air conditioner on and it stays on until
 * the room reaches the bottom - not until it drops back below the top, which would leave the unit
 * cycling on the width of the sensor's noise.
 */
export default class AutoController {
  /**
   * @param {object} [options] How the band behaves.
   * @param {number} [options.deadband] How far past a threshold the room must go before the
   *   controller acts, in degrees. Guards against a sensor that jitters on the boundary.
   */
  constructor({ deadband = 0.2 } = {}) {
    this.deadband = deadband;
    this.running = false;
  }

  /**
   * Takes the controller's own idea of whether the air conditioner is running from the device, for
   * a restart or for someone pressing the remote.
   *
   * @param {boolean} running Whether it is on.
   * @returns {void}
   */
  sync(running) {
    this.running = running === true;
  }

  /**
   * @param {number} temperature What the room reads now.
   * @param {{low: number, high: number}} band The range HomeKit is asking for.
   * @returns {string} One of {@link ACTION}.
   */
  decide(temperature, band) {
    if (!Number.isFinite(temperature)) {
      // A reading we do not have is not a reason to switch anything: hold what is already running.
      return ACTION.HOLD;
    }

    const { low, high } = normaliseBand(band);

    if (!this.running && temperature > high + this.deadband) {
      this.running = true;
      return ACTION.COOL;
    }

    if (this.running && temperature < low - this.deadband) {
      this.running = false;
      return ACTION.OFF;
    }

    return ACTION.HOLD;
  }

  /**
   * What HomeKit should show while the controller is in charge: an air conditioner that is off
   * because the room is cool enough is idle, not off - the accessory is still working.
   *
   * @returns {'cooling'|'idle'} What it is doing.
   */
  get activity() {
    return this.running ? 'cooling' : 'idle';
  }
}

/**
 * HomeKit lets the two ends of the range meet, and a band of no width makes the air conditioner
 * switch on and off at the same reading. One degree apart is the narrowest that behaves.
 *
 * @param {{low: number, high: number}} band What HomeKit asked for.
 * @returns {{low: number, high: number}} A band with room in it.
 */
export function normaliseBand({ low, high }) {
  if (!(high > low)) {
    return { low, high: low + 1 };
  }

  return { low, high };
}
