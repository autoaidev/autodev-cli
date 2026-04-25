// ANSI color logger — no external dependencies

const R  = '\x1b[0m';
const B  = '\x1b[1m';
const GR = '\x1b[32m';  // green
const YE = '\x1b[33m';  // yellow
const CY = '\x1b[36m';  // cyan
const RE = '\x1b[31m';  // red
const GY = '\x1b[90m';  // gray
const MA = '\x1b[35m';  // magenta

function ts(): string {
  return `${GY}[${new Date().toLocaleTimeString()}]${R}`;
}

export const log = {
  info:    (msg: string) => console.log(`${ts()} ${CY}${msg}${R}`),
  success: (msg: string) => console.log(`${ts()} ${GR}${msg}${R}`),
  warn:    (msg: string) => console.log(`${ts()} ${YE}${msg}${R}`),
  error:   (msg: string) => console.error(`${ts()} ${RE}${B}${msg}${R}`),
  task:    (msg: string) => console.log(`${ts()} ${B}${GR}${msg}${R}`),
  plain:   (msg: string) => console.log(`${ts()} ${msg}`),
  gray:    (msg: string) => console.log(`${ts()} ${GY}${msg}${R}`),
  section: (msg: string) => console.log(`\n${B}${MA}${msg}${R}\n`),

  /** Routes based on message prefix (matches what taskLoop emits). */
  auto: (msg: string): void => {
    if      (msg.startsWith('▶'))  { log.task(msg); }
    else if (msg.match(/✓|✅/))    { log.success(msg); }
    else if (msg.match(/⚠|⏳/))    { log.warn(msg); }
    else if (msg.match(/✗|❌|🚫/)) { log.error(msg); }
    else if (msg.match(/^\[/))     { log.gray(msg); }  // debug-style [tag]
    else                           { log.plain(msg); }
  },
};
