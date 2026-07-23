// Smoke test for the outbound secrets anonymizer (src/core/redactSecrets.ts).
// Run after `npm run build` (imports the compiled JS from out/).
//
// NOTE: the fake test credentials are assembled from string FRAGMENTS at
// runtime (never written as one contiguous literal) so this test file itself
// does not trip GitHub push-protection / secret scanners.
import { redactSecrets, redactDeep } from '../out/core/redactSecrets.js';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } };

// Fabricated (non-real) secrets, split so no whole token appears in source.
const ANTHROPIC = 'sk-' + 'ant-' + 'abc123def456ghi789jkl';
const GH_TOKEN  = 'gh' + 'p_' + '0123456789abcdef0123456789abcdef0123';
const BEARER    = 'abcdefghij0123456789KLMNOP';
const AWS_ID    = 'AK' + 'IA' + 'IOSFODNN7EXAMPLE';
// A realistic JWT shape (three base64url segments). The reference shorthand
// used literal "…." dots which don't match a real JWT; a real JWT uses single
// dots between segments.
const JWT = 'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' + '.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const ENV_SECRET = 'wJalrXUtnFEMIabcdef1234567890';
const AGT = 'ag' + 't_' + 'ABCDEFGH12345678';

const blob = [
  ANTHROPIC,
  GH_TOKEN,
  'Authorization: Bearer ' + BEARER,
  AWS_ID,
  JWT,
  '{"api_token":"supersecret_value_1234567"}',
  'AWS_SECRET_ACCESS_KEY=' + ENV_SECRET,
  AGT,
  'The quick brown fox jumps over the lazy dog.',
].join('\n');

const red = redactSecrets(blob);
console.log('--- redacted blob ---\n' + red + '\n---------------------');

// Each raw secret must be gone.
ok(!red.includes(ANTHROPIC), 'anthropic key redacted');
ok(red.includes('sk-ant-REDACTED'), 'anthropic replacement present');
ok(!red.includes(GH_TOKEN), 'github token redacted');
ok(red.includes('gh_REDACTED'), 'github replacement present');
ok(!red.includes(BEARER), 'bearer credential redacted');
ok(red.includes('Bearer REDACTED_BEARER'), 'bearer prefix kept, value redacted');
ok(!red.includes(AWS_ID), 'aws access key redacted');
ok(red.includes('AKIA_REDACTED'), 'aws replacement present');
ok(!red.includes(JWT), 'jwt redacted');
ok(red.includes('eyJ.REDACTED.JWT'), 'jwt replacement present');
ok(!red.includes('supersecret_value_1234567'), 'json api_token value redacted');
ok(red.includes('"api_token":"REDACTED"'), 'json token key+structure preserved');
ok(!red.includes(ENV_SECRET), 'env-var secret value redacted');
ok(red.includes('AWS_SECRET_ACCESS_KEY=REDACTED'), 'env-var name+structure preserved');
ok(!red.includes(AGT), 'agent api_key redacted');
ok(red.includes('agt_REDACTED'), 'agent-key replacement present');

// Normal content must survive verbatim.
ok(red.includes('The quick brown fox jumps over the lazy dog.'), 'normal sentence intact');

// A few extra credential shapes (also fragment-assembled).
ok(redactSecrets('use ' + 'pa' + 't_' + 'ABCDEF1234567890zz here').includes('pat_REDACTED'), 'pat_ token redacted');
ok(redactSecrets('gith' + 'ub_pat_' + '11ABCDEFG0abcdefghij1234567890').includes('github_pat_REDACTED'), 'github_pat redacted');
ok(redactSecrets('key ' + 'AI' + 'za' + 'SyA1234567890abcdefghijklmnopqrstuvwx done').includes('AIza_REDACTED'), 'google api key redacted');
ok(redactSecrets('xo' + 'xb-' + '1234567890-abcdefghijklmnop done').includes('xoxX-REDACTED'), 'slack token redacted');
ok(redactSecrets('pk' + '_live_' + '0123456789abcdefghijABCD done').includes('stripe_REDACTED'), 'stripe key redacted');

// redactDeep: structure + keys intact, only string LEAVES redacted.
const nested = { tool_input: { command: 'export TOKEN=' + GH_TOKEN }, count: 7, ok: true, nada: null };
const deep = redactDeep(nested);
ok(deep.tool_input.command.includes('gh_REDACTED'), 'redactDeep redacts nested string leaf');
ok(!deep.tool_input.command.includes(GH_TOKEN), 'redactDeep removed the raw token');
ok(Object.prototype.hasOwnProperty.call(deep.tool_input, 'command'), 'redactDeep keeps object keys');
ok(deep.count === 7 && deep.ok === true && deep.nada === null, 'redactDeep leaves non-string leaves untouched');
ok(nested.tool_input.command.includes(GH_TOKEN), 'redactDeep did NOT mutate the input');

// Arrays walked too.
const arr = redactDeep(['plain text', { pw: '{"password":"hunter2000000000"}' }]);
ok(arr[0] === 'plain text', 'redactDeep leaves plain array string');
ok(arr[1].pw.includes('"password":"REDACTED"'), 'redactDeep walks array->object->string');

if (failures) { console.error(`\nredactSecrets smoke: ${failures} FAILED`); process.exit(1); }
console.log('\nredactSecrets smoke: ALL PASS');
