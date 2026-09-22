// The infrared air conditioner as one object, hiding where its pieces live: the hub's own
// thermometer answers as a resource, everything that commands the air conditioner is a trait on
// endpoint 3 of that same hub, and the two are read and written by different calls. See
// PROTOCOL.md for how this was worked out.

/** Traits on the air conditioner endpoint. All of these were confirmed to take a write. */
export const TRAIT = {
  /** Inverted, and it reads like a bug: 0 switches the air conditioner ON, 1 off. */
  power: '3.132.32920',
  mode: '3.141.32947',
  targetTemperature: '3.141.32948',
  fanSpeed: '3.142.32950',
  /** The whole state as one word, P<power>_M<mode>_T<temp>_S<fan>_D<swing>. Read only. */
  state: '3.132.32922',
};

/** Resources on the hub, which is where the room's own readings are. */
export const RESOURCE = {
  /** Hundredths of a degree. */
  temperature: '0.1.85',
  /** Hundredths of a percent. */
  humidity: '0.2.85',
};

export const MODE = { cool: 0, heat: 1, auto: 2, fan: 3, dry: 4 };

/** What the hub answers with for power, which is the other way round from what anyone expects. */
const POWER_ON = '0';
const POWER_OFF = '1';

export default class AqaraAirConditioner {
  /**
   * @param {object} cloud An {@link AqaraCloud}, already able to sign.
   * @param {string} did The hub the remote was matched onto.
   * @param {Function} getToken Returns a current session token, refreshing it if need be.
   */
  constructor(cloud, did, getToken) {
    this.cloud = cloud;
    this.did = did;
    this.getToken = getToken;

    // Infrared is one way: the hub never hears the air conditioner answer, so its idea of the
    // state drifts and has been seen to fall back to "off" on its own. What this plugin last
    // commanded is the better answer, so it is kept and preferred.
    this.commanded = {};

    // One request at a time. Several traits arriving at once confuse the hub, and a command
    // overtaking the read that follows it would report the state it had before.
    this.queue = Promise.resolve();
  }

  /**
   * @param {Function} work What to do once the queue reaches it.
   * @returns {Promise<*>} Whatever the work returned.
   */
  serialise(work) {
    const run = this.queue.then(work, work);
    // Keep the chain alive whatever happens, or one rejection stops every later command.
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Everything worth knowing in one round trip each way.
   *
   * @returns {Promise<{power: boolean, mode: number, targetTemperature: number, fanSpeed: number,
   *   roomTemperature: number|undefined, roomHumidity: number|undefined, word: string|undefined}>}
   *   What the air conditioner and the room are doing.
   */
  async read() {
    return this.serialise(async () => {
      const token = await this.getToken();

      const [traits, resources] = await Promise.all([
        this.cloud.readTraits(token, this.did, [
          TRAIT.power, TRAIT.mode, TRAIT.targetTemperature, TRAIT.fanSpeed, TRAIT.state,
        ]),
        this.cloud.readResources(token, this.did, [RESOURCE.temperature, RESOURCE.humidity]),
      ]);

      const value = path => traits.find(trait => trait.path === path)?.value;
      const hundredths = raw => (raw === undefined ? undefined : Number(raw) / 100);

      return {
        // The hub's own answer, which is only ever what it believes.
        power: value(TRAIT.power) === POWER_ON,
        mode: Number(value(TRAIT.mode)),
        targetTemperature: Number(value(TRAIT.targetTemperature)),
        fanSpeed: Number(value(TRAIT.fanSpeed)),
        word: value(TRAIT.state),
        roomTemperature: hundredths(resources[RESOURCE.temperature]),
        roomHumidity: hundredths(resources[RESOURCE.humidity]),
      };
    });
  }

  /**
   * @param {string} path Which trait.
   * @param {string|number} value What to set it to.
   * @returns {Promise<void>} Resolves once the hub has taken it.
   */
  async write(path, value) {
    return this.serialise(async () => {
      const token = await this.getToken();
      const body = `{"deviceId": ${JSON.stringify(this.did)}, "traits": [{"path": ${JSON.stringify(path)}, "value": ${JSON.stringify(String(value))}}]}`;

      await this.cloud.signedRequest('POST', `${this.cloud.area.server}/app/v1.0/lumi/app/qlink/trait/write`, {
        signSource: body, body, token,
      });

      this.commanded[path] = String(value);
    });
  }

  /**
   * Switching the air conditioner on or off.
   *
   * The hub only sends an infrared frame when the value it holds actually changes. Writing "off"
   * to a hub that already believes it is off does nothing at all - it answers Success and stays
   * silent - and since its belief drifts, that is how a running air conditioner ends up ignoring
   * every attempt to stop it.
   *
   * Going through the other value first to force a frame is NOT the answer, however tempting: to
   * switch the air conditioner off it would have to switch it on, and the off that follows a second
   * later arrives while the unit is still waking and is ignored. Pressing off then starts the air
   * conditioner, which is worse than the silence it was meant to cure.
   *
   * Instead the hub's belief is kept in step with ours as we go - see {@link hasDrifted} - so that
   * by the time anyone asks for off, the hub holds on, and one write is a real change.
   *
   * @param {boolean} on Whether the air conditioner should run.
   * @returns {Promise<void>} Resolves once it has been told.
   */
  async setPower(on) {
    return this.write(TRAIT.power, on ? POWER_ON : POWER_OFF);
  }

  /**
   * @returns {Promise<string|undefined>} What the hub currently holds for power, raw.
   */
  async readPower() {
    return this.serialise(async () => {
      const [trait] = await this.cloud.readTraits(await this.getToken(), this.did, [TRAIT.power]);
      return trait?.value;
    });
  }

  /**
   * Whether the hub's idea of the power differs from what this plugin last commanded. While they
   * disagree, a command that matches the hub's belief goes out as silence.
   *
   * @param {object} state What {@link read} returned.
   * @returns {boolean} Whether the two have drifted apart.
   */
  hasDrifted(state) {
    const commanded = this.commanded[TRAIT.power];
    return commanded !== undefined && state.power !== (commanded === POWER_ON);
  }

  /**
   * @param {number} mode One of {@link MODE}.
   * @returns {Promise<void>} Resolves once it has been told.
   */
  async setMode(mode) {
    return this.write(TRAIT.mode, mode);
  }

  /**
   * @param {number} celsius Between 16 and 32, which is what the trait declares.
   * @returns {Promise<void>} Resolves once it has been told.
   */
  async setTargetTemperature(celsius) {
    const clamped = Math.min(32, Math.max(16, Math.round(celsius)));
    return this.write(TRAIT.targetTemperature, clamped);
  }

  /**
   * @param {number} speed Between 1 and 4.
   * @returns {Promise<void>} Resolves once it has been told.
   */
  async setFanSpeed(speed) {
    const clamped = Math.min(4, Math.max(1, Math.round(speed)));
    return this.write(TRAIT.fanSpeed, clamped);
  }

  /**
   * Whether the air conditioner is running, preferring what this plugin last commanded over what
   * the hub says - the hub's answer is a guess about a device that cannot answer for itself.
   *
   * @param {object} state What {@link read} returned.
   * @returns {boolean} Whether it is on.
   */
  isRunning(state) {
    const commanded = this.commanded[TRAIT.power];
    return commanded === undefined ? state.power : commanded === POWER_ON;
  }
}
