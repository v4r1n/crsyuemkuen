import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Experimental module mocks are confined to this test worker, never production.
test('actual OAuth callback diagnostics preserve denial, OTP handoff and secret-safe output',()=>{
  const env={...process.env,AUTH_DIAGNOSTICS:'false'};
  // A nested runner must not inherit the parent's binary test IPC mode.
  delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--test','--test-reporter=spec',
    fileURLToPath(new URL('../fixtures/oauth-diagnostics.mjs',import.meta.url))],
    {encoding:'utf8',env,timeout:60000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/tests 14\b/);
  assert.match(result.stdout,/fail 0\b/);
});
