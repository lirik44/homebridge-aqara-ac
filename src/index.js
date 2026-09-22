import AqaraACPlatform, { PLATFORM_NAME, PLUGIN_NAME } from './platform.js';

/**
 * @param {object} api The Homebridge API.
 * @returns {void}
 */
export default function register(api) {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, AqaraACPlatform);
}
