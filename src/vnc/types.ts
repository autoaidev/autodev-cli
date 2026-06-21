/**
 * Shared types for the VNC subsystem.
 */

export interface VncRect {
  x: number; y: number; w: number; h: number;
  encoding: 'Raw' | 'CopyRect';
  data: Buffer; // raw BGRA bytes for Raw; 4 bytes (srcX uint16, srcY uint16) for CopyRect
}

export interface VncInfo {
  name: string;
  width: number;
  height: number;
}
