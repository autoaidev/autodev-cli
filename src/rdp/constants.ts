/**
 * RDP / T.128 protocol constants.
 */

// ── Default connection parameters ─────────────────────────────────────────

export const RDP_DEFAULT_PORT        = 3389;
export const RDP_DEFAULT_WIDTH       = 1024;
export const RDP_DEFAULT_HEIGHT      = 768;
export const RDP_DEFAULT_COLOR_DEPTH = 24;

// ── X.224 PDU types ───────────────────────────────────────────────────────

export const X224_TPDU_CONNECTION_REQUEST = 0xe0;
export const X224_TPDU_CONNECTION_CONFIRM = 0xd0;
export const X224_TPDU_DATA              = 0xf0;

// ── MCS PDU types (T.125) ─────────────────────────────────────────────────

export const MCS_CONNECT_INITIAL      = 0x7f65;
export const MCS_CONNECT_RESPONSE     = 0x7f66;
export const MCS_ERECT_DOMAIN_REQUEST = 0x04;
export const MCS_ATTACH_USER_REQUEST  = 0x28;
export const MCS_ATTACH_USER_CONFIRM  = 0x2e; // (11 << 2) | 2  — "initiator present" bit set
export const MCS_CHANNEL_JOIN_REQUEST = 0x38;
export const MCS_CHANNEL_JOIN_CONFIRM = 0x3e; // (15 << 2) | 2  — "channelId present" bit set
export const MCS_SEND_DATA_REQUEST    = 0x64;
export const MCS_SEND_DATA_INDICATION = 0x68;

// ── RDP well-known MCS channel IDs ────────────────────────────────────────

export const MCS_CHANNEL_GLOBAL  = 1003; // MCS Global Channel
export const MCS_CHANNEL_USER    = 1007; // Dynamically assigned; placeholder
export const MCS_CHANNEL_CLIPRDR = 1004; // Clipboard redirection
export const MCS_CHANNEL_RDPSND  = 1005; // Sound

// ── RDP PDU types (Share Control Header) ──────────────────────────────────

export const PDUTYPE_DEMANDACTIVEPDU  = 0x11;
export const PDUTYPE_CONFIRMACTIVEPDU = 0x13;
export const PDUTYPE_DATAPDU          = 0x17;
export const PDUTYPE_DEACTIVATEALLPDU = 0x16;
export const PDUTYPE_SERVER_REDIR_PKT = 0x1a;

// ── RDP Data PDU sub-types ────────────────────────────────────────────────

export const PDUTYPE2_UPDATE              = 0x02;
export const PDUTYPE2_CONTROL             = 0x14;
export const PDUTYPE2_POINTER             = 0x1b;
export const PDUTYPE2_INPUT               = 0x1c;
export const PDUTYPE2_SYNCHRONIZE         = 0x1f;
export const PDUTYPE2_REFRESH_RECT        = 0x21;
export const PDUTYPE2_SUPPRESS_OUTPUT     = 0x23;
export const PDUTYPE2_FONTLIST            = 0x27;
export const PDUTYPE2_FONTMAP             = 0x28;
export const PDUTYPE2_SET_KEYBOARD_INDICATORS = 0x2e;
export const PDUTYPE2_BITMAPCACHEERROR    = 0x33;
export const PDUTYPE2_SET_KEYBOARD_IME    = 0x39;
export const PDUTYPE2_SHUTDOWN_REQUEST    = 0x24;
export const PDUTYPE2_SHUTDOWN_DENIED     = 0x25;

// ── RDP Update types ──────────────────────────────────────────────────────

export const UPDATE_ORDERS  = 0x0000;
export const UPDATE_BITMAP  = 0x0001;
export const UPDATE_PALETTE = 0x0002;
export const UPDATE_POINTER = 0x0003;

// ── RDP Security flags ────────────────────────────────────────────────────

export const SEC_EXCHANGE_PKT   = 0x0001;
export const SEC_ENCRYPT        = 0x0008;
export const SEC_LOGON_INFO     = 0x0040;
export const SEC_LICENSE_PKT    = 0x0080;
export const SEC_REDIRECTION_PKT = 0x0400;

// ── RDP encryption methods ────────────────────────────────────────────────

export const ENCRYPTION_METHOD_NONE   = 0x00000000;
export const ENCRYPTION_METHOD_40BIT  = 0x00000001;
export const ENCRYPTION_METHOD_128BIT = 0x00000002;
export const ENCRYPTION_METHOD_56BIT  = 0x00000008;
export const ENCRYPTION_METHOD_FIPS   = 0x00000010;

// ── RDP encryption levels ─────────────────────────────────────────────────

export const ENCRYPTION_LEVEL_NONE              = 0x00000000;
export const ENCRYPTION_LEVEL_LOW               = 0x00000001;
export const ENCRYPTION_LEVEL_CLIENT_COMPATIBLE = 0x00000002;
export const ENCRYPTION_LEVEL_HIGH              = 0x00000003;
export const ENCRYPTION_LEVEL_FIPS              = 0x00000004;

// ── Negotiation protocol flags (RDP Negotiation Request) ──────────────────

export const PROTOCOL_RDP       = 0x00000000;
export const PROTOCOL_SSL       = 0x00000001;
export const PROTOCOL_HYBRID    = 0x00000002; // CredSSP / NLA
export const PROTOCOL_RDSTLS    = 0x00000004;
export const PROTOCOL_HYBRID_EX = 0x00000008;

// ── Input event types ─────────────────────────────────────────────────────

export const INPUT_EVENT_SYNC     = 0x0000;
export const INPUT_EVENT_SCANCODE = 0x0004;
export const INPUT_EVENT_UNICODE  = 0x0005;
export const INPUT_EVENT_MOUSE    = 0x8001;
export const INPUT_EVENT_MOUSEX   = 0x8002;

// ── Mouse button flags ────────────────────────────────────────────────────

export const PTRFLAGS_DOWN      = 0x8000;
export const PTRFLAGS_BUTTON1   = 0x1000; // left
export const PTRFLAGS_BUTTON2   = 0x2000; // right
export const PTRFLAGS_BUTTON3   = 0x4000; // middle
export const PTRFLAGS_MOVE      = 0x0800;
export const PTRFLAGS_WHEEL     = 0x0200;
export const PTRFLAGS_WHEEL_NEG = 0x0100;

// ── Keyboard scancode flags ───────────────────────────────────────────────

export const KBDFLAGS_EXTENDED  = 0x0100;
export const KBDFLAGS_DOWN      = 0x0000;
export const KBDFLAGS_RELEASE   = 0x8000;

// ── Bitmap compression flags ──────────────────────────────────────────────

export const BITMAP_COMPRESSION     = 0x0001;
export const NO_BITMAP_COMPRESSION_HDR = 0x0400;

// ── Virtual scancode → RDP scancode map (JS keyCode → RDP scan) ──────────

export const RDP_SCANCODE: Record<number, number> = {
  8:   0x0e, // Backspace
  9:   0x0f, // Tab
  13:  0x1c, // Enter
  16:  0x2a, // Shift (left)
  17:  0x1d, // Ctrl (left)
  18:  0x38, // Alt (left)
  19:  0x45, // Pause
  20:  0x3a, // CapsLock
  27:  0x01, // Escape
  32:  0x39, // Space
  33:  0x49, // PageUp
  34:  0x51, // PageDown
  35:  0x4f, // End
  36:  0x47, // Home
  37:  0x4b, // ArrowLeft
  38:  0x48, // ArrowUp
  39:  0x4d, // ArrowRight
  40:  0x50, // ArrowDown
  45:  0x52, // Insert
  46:  0x53, // Delete
  48:  0x0b, // 0
  49:  0x02, // 1
  50:  0x03, // 2
  51:  0x04, // 3
  52:  0x05, // 4
  53:  0x06, // 5
  54:  0x07, // 6
  55:  0x08, // 7
  56:  0x09, // 8
  57:  0x0a, // 9
  65:  0x1e, // A
  66:  0x30, // B
  67:  0x2e, // C
  68:  0x20, // D
  69:  0x12, // E
  70:  0x21, // F
  71:  0x22, // G
  72:  0x23, // H
  73:  0x17, // I
  74:  0x24, // J
  75:  0x25, // K
  76:  0x26, // L
  77:  0x32, // M
  78:  0x31, // N
  79:  0x18, // O
  80:  0x19, // P
  81:  0x10, // Q
  82:  0x13, // R
  83:  0x1f, // S
  84:  0x14, // T
  85:  0x16, // U
  86:  0x2f, // V
  87:  0x11, // W
  88:  0x2d, // X
  89:  0x15, // Y
  90:  0x2c, // Z
  91:  0x5b, // Meta/Win (left)  — extended
  112: 0x3b, // F1
  113: 0x3c, // F2
  114: 0x3d, // F3
  115: 0x3e, // F4
  116: 0x3f, // F5
  117: 0x40, // F6
  118: 0x41, // F7
  119: 0x42, // F8
  120: 0x43, // F9
  121: 0x44, // F10
  122: 0x57, // F11
  123: 0x58, // F12
  144: 0x45, // NumLock
  145: 0x46, // ScrollLock
};

/** Keys that require the EXTENDED flag in the RDP scancode event. */
export const RDP_EXTENDED_KEYS = new Set<number>([
  33, 34, 35, 36, 37, 38, 39, 40, 45, 46, // nav cluster
  91,  // Win key
]);
