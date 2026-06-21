/**
 * RDP subsystem barrel — re-exports everything consumers need.
 */

export { RdpBridge }   from './bridge';
export { RdpSession }  from './session';
export { RDP_SCANCODE, RDP_DEFAULT_PORT } from './constants';
export type { RdpRect, RdpInfo, RdpConnectOptions } from './types';
