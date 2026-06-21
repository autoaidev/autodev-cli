/**
 * Shared types for the RDP subsystem.
 */

export interface RdpInfo {
  name: string;
  width: number;
  height: number;
  colorDepth: number;
}

export interface RdpRect {
  x: number;
  y: number;
  w: number;
  h: number;
  data: Buffer; // raw RGBA bytes
}

/** Options for starting an RDP session. */
export interface RdpConnectOptions {
  host: string;
  port?: number;       // default 3389
  username?: string;
  password?: string;
  domain?: string;
  width?: number;      // default 1024
  height?: number;     // default 768
  colorDepth?: number; // 8 | 15 | 16 | 24 | 32; default 24
}
