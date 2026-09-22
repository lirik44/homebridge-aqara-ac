import { AqaraCloud } from './cloud/client.js';
import AqaraAirConditioner from './cloud/ac.js';
import AirConditionerAccessory from './homekit/accessory.js';

export const PLUGIN_NAME = 'homebridge-aqara-ac';
export const PLATFORM_NAME = 'AqaraAC';

/** How often to look at the room, when the config does not say. */
const DEFAULT_REFRESH_SECONDS = 60;

/** A session is good for a long while; this is only a floor on how often it is renewed. */
const TOKEN_LIFETIME_MS = 6 * 60 * 60 * 1000;

export default class AqaraACPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config ?? {};
    this.api = api;
    this.accessories = [];
    this.timer = null;
    this.session = null;

    if (!this.config.email || !this.config.password) {
      this.log.error('No Aqara account configured - set email and password. Doing nothing.');
      return;
    }

    this.cloud = new AqaraCloud({ region: this.config.region ?? 'RU' });

    this.api.on('didFinishLaunching', () => this.start().catch((error) => {
      this.log.error('Could not set up the air conditioner: %s', error.message);
    }));

    this.api.on('shutdown', () => this.stop());
  }

  /**
   * Homebridge hands back what it restored from its cache before launching.
   *
   * @param {object} accessory A cached accessory.
   * @returns {void}
   */
  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  /**
   * A session token, logging in again when there is none or it has aged out.
   *
   * @returns {Promise<string>} The token.
   */
  async token() {
    if (this.session && Date.now() - this.session.at < TOKEN_LIFETIME_MS) {
      return this.session.token;
    }

    const { token, userId } = await this.cloud.login(this.config.email, this.config.password);
    this.session = { token, at: Date.now() };
    this.log.debug('Logged in to the Aqara %s cloud as %s', this.cloud.region, userId);

    return token;
  }

  /**
   * Finds the hub whose remote was matched to an air conditioner. A matched remote is not a device
   * of its own - it is an endpoint on the hub - so this asks each hub what endpoints it shows.
   *
   * @returns {Promise<{did: string, name: string}>} The hub, and what the app calls the remote.
   */
  async findAirConditioner() {
    const token = await this.token();

    if (this.config.hubDid) {
      return { did: this.config.hubDid, name: this.config.name ?? 'Air Conditioner' };
    }

    const devices = await this.cloud.listDevices(token);
    const hubs = devices.filter(device => /gateway|hub/i.test(device.model ?? ''));

    for (const hub of hubs) {
      const endpoints = await this.cloud.panels(token, hub.did);
      const ac = endpoints.find(endpoint => /aircondition/i.test(endpoint.deviceTypes ?? ''));

      if (ac) {
        this.log.info('Found "%s" on %s (%s)', ac.endpointName, hub.deviceName, hub.did);
        return { did: hub.did, name: this.config.name ?? ac.endpointName ?? 'Air Conditioner' };
      }
    }

    throw new Error(`No air conditioner found behind any of the ${hubs.length} hub(s) on the account`);
  }

  /**
   * Publishes the accessory and starts watching the room.
   *
   * @returns {Promise<void>} Resolves once it is running.
   */
  async start() {
    const { did, name } = await this.findAirConditioner();
    const device = new AqaraAirConditioner(this.cloud, did, () => this.token());

    // Changing the suffix hands HomeKit an accessory it has never seen, which is the only way to
    // make it re-read a characteristic's bounds: it caches those and only looks again when the
    // accessory itself changes, so narrowing the dial otherwise has no visible effect. The old one
    // is unregistered below as stale, so nothing is left behind.
    const suffix = this.config.accessoryIdSuffix;
    const uuid = this.api.hap.uuid.generate(`aqara-ac-${did}${suffix ? `-${suffix}` : ''}`);
    let accessory = this.accessories.find(cached => cached.UUID === uuid);

    if (accessory) {
      accessory.displayName = name;
      this.api.updatePlatformAccessories([accessory]);
    } else {
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info('Added %s', name);
    }

    // Anything else in the cache is from an earlier configuration and answers nothing now.
    const stale = this.accessories.filter(cached => cached.UUID !== uuid);
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info('Removed %s accessory(ies) no longer configured', stale.length);
    }

    this.handler = new AirConditionerAccessory(this, accessory, device);

    // Take the first reading before the timer, so HomeKit is not left with a blank tile.
    await this.handler.poll();

    const seconds = Math.max(15, this.config.refreshSeconds ?? DEFAULT_REFRESH_SECONDS);
    this.timer = setInterval(() => this.handler.poll(), seconds * 1000);
    this.log.info('Watching the room every %s seconds', seconds);
  }

  /** @returns {void} Stops the timer, for a Homebridge that is shutting down. */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
