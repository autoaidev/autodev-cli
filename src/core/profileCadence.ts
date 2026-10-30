// ---------------------------------------------------------------------------
// Profile/pillars cadence — decide how OFTEN the heavy AutoDev profile (the
// `<!-- AUTODEV:section:* -->` pillars assembled into `.autodev/PROGRAM.md` and
// inlined by writeCombinedFile when `includeProfile` is true) is re-sent into an
// agent's context.
//
// WHY THIS EXISTS
//   The profile is large (tens of KB, dozens of pillars). On a PERSISTENT or
//   RESUMED session (grok-acp, or any provider with resumeSession on) the model
//   carries its context forward across turns, so the pillars stay loaded from the
//   turn they were last injected — re-sending them every turn is pure waste and
//   makes users report "it sends the whole profile on every message". On a
//   STATELESS turn (fresh context each turn, no resume) the agent genuinely needs
//   the protocol every turn, so it must NOT be throttled there.
//
//   So: throttle ONLY when the context persists this turn; otherwise send every
//   turn. The cadence counter is PERSISTED to `.autodev/.profile-turns` so the
//   every-N cadence survives the agent's real execution model — including a
//   per-turn-SPAWN provider where each turn is a fresh process (an in-memory
//   counter would reset to 1 every spawn and re-dump the profile every turn), and
//   a loop RESTART that resumes the same persistent session (an in-memory counter
//   would reset to turn 1 and re-dump the profile on every restart).
//
// This module is intentionally tiny + pure so it can be unit-tested directly.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';

/** Default re-send cadence (turns) when `profileEveryNTasks` is not set. */
export const DEFAULT_PROFILE_EVERY_N = 50;

/** File that persists the turn counter, under `<root>/.autodev/`. */
export const PROFILE_TURNS_FILE = '.autodev/.profile-turns';

/** Sentinel meaning "the profile has NEVER been delivered for this workspace". */
export const PROFILE_NEVER = -1;

export interface ProfileCadenceInput {
  /**
   * Turns since the profile was last injected, persisted across restarts.
   * `PROFILE_NEVER` (-1) means it has never been delivered yet.
   */
  turnsSinceProfile: number;
  /** `settings.profileEveryNTasks` (default 50). <= 0 disables the periodic refresh. */
  profileInterval: number;
  /**
   * Does the model's context carry over INTO this turn (a persistent / resumed
   * session)? Mirrors the loop's `wantResume` signal. When false the turn is
   * stateless and the profile is sent EVERY turn.
   */
  contextPersists: boolean;
  /**
   * Force a (re)inclusion this turn regardless of the counter — e.g. a fresh
   * session was just started (session reset) so the carried context is gone.
   */
  forceInclude?: boolean;
}

export interface ProfileCadenceResult {
  /** Whether to inline the full profile in THIS dispatch. */
  includeProfile: boolean;
  /** The new `turnsSinceProfile` value to persist AFTER this turn. */
  turnsSinceProfile: number;
}

/**
 * Pure cadence decision. Given the persisted counter + the context-persistence
 * signal, decide whether to inline the profile this turn and what counter to
 * persist next.
 *
 * Counting mirrors the original in-memory gate: after an inclusion the counter
 * becomes 1, then advances 1,2,…,interval; when it reaches `interval` the profile
 * is re-included and the counter resets — so inclusions are exactly `interval`
 * turns apart.
 */
export function decideProfileInclusion(input: ProfileCadenceInput): ProfileCadenceResult {
  const { turnsSinceProfile, profileInterval, contextPersists, forceInclude } = input;

  let includeProfile: boolean;
  if (forceInclude) {
    // A fresh session was just established — its context does NOT have the pillars.
    includeProfile = true;
  } else if (!contextPersists) {
    // Stateless turn: the model gets a fresh context, so it needs the protocol
    // every turn. Never throttle here (that would leave it protocol-less 49/50).
    includeProfile = true;
  } else {
    // Persistent / resumed: the pillars are still in context from the last
    // injection. Include only when never delivered yet, or every `interval` turns.
    includeProfile = turnsSinceProfile < 0
      || (profileInterval > 0 && turnsSinceProfile >= profileInterval);
  }

  // Advance / reset the persisted counter. After an inclusion the next turn starts
  // the count at 1; otherwise increment (treating the NEVER sentinel as 0).
  const base = turnsSinceProfile < 0 ? 0 : turnsSinceProfile;
  const next = includeProfile ? 1 : base + 1;
  return { includeProfile, turnsSinceProfile: next };
}

/**
 * Read the persisted turn counter for `root`. Returns `PROFILE_NEVER` when the
 * file is absent/unreadable (so a brand-new workspace includes the profile on its
 * first persistent turn). Never throws.
 */
export function loadProfileTurns(root: string): number {
  try {
    const raw = fs.readFileSync(path.join(root, PROFILE_TURNS_FILE), 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : PROFILE_NEVER;
  } catch {
    return PROFILE_NEVER;
  }
}

/** Persist the turn counter for `root`. Best-effort; never throws. */
export function saveProfileTurns(root: string, turnsSinceProfile: number): void {
  try {
    const p = path.join(root, PROFILE_TURNS_FILE);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(turnsSinceProfile), 'utf8');
  } catch { /* best effort — the cadence just falls back to in-memory behaviour */ }
}

/**
 * Force the NEXT persistent turn to re-include the profile (counter → NEVER).
 * Called when a fresh session is about to start (session reset) so the new
 * context gets the pillars. Best-effort; never throws.
 */
export function resetProfileTurns(root: string): void {
  saveProfileTurns(root, PROFILE_NEVER);
}
