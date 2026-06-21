/**
 * RFB protocol constants and X11 keysym mappings.
 */

// ── Encoding types ─────────────────────────────────────────────────────────

export const ENC_RAW      = 0;
export const ENC_COPYRECT = 1;
export const ENC_HEXTILE  = 5;  // parsed but not yet sent to browser
export const ENC_CURSOR   = -239; // RFB pseudo-encoding: cursor shape

// ── X11 keysym translations (JS keyCode → X11 keysym) ─────────────────────

export const KEYSYM: Record<number, number> = {
  8:  0xff08, // BackSpace
  9:  0xff09, // Tab
  13: 0xff0d, // Return
  27: 0xff1b, // Escape
  35: 0xff57, // End
  36: 0xff50, // Home
  37: 0xff51, // Left
  38: 0xff52, // Up
  39: 0xff53, // Right
  40: 0xff54, // Down
  45: 0xff63, // Insert
  46: 0xffff, // Delete
  112: 0xffbe, 113: 0xffbf, 114: 0xffc0, 115: 0xffc1, // F1–F4
  116: 0xffc2, 117: 0xffc3, 118: 0xffc4, 119: 0xffc5, // F5–F8
  120: 0xffc6, 121: 0xffc7, 122: 0xffc8, 123: 0xffc9, // F9–F12
  16: 0xffe1, // Shift
  17: 0xffe3, // Ctrl
  18: 0xffe9, // Alt
  91: 0xffeb, // Meta/Super
};
