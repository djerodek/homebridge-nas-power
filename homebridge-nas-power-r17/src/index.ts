import { API } from 'homebridge';
import { NasPowerPlatform, PLATFORM_NAME, PLUGIN_NAME } from './platform';

export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, NasPowerPlatform);
};
