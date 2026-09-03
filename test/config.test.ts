import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicBaseUrl } from '../src/config.js';

describe('validatePublicBaseUrl', () => {
  it('accepts a public HTTPS origin and returns it normalized', () => {
    assert.equal(
      validatePublicBaseUrl('https://stories.example.com'),
      'https://stories.example.com'
    );
  });

  it('rejects a string that is not a URL', () => {
    assert.throws(() => validatePublicBaseUrl('not a url'), /not a valid URL/);
  });

  for (const unreachable of [
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://10.0.0.1',
    'http://192.168.1.1',
    'http://172.16.0.1',
    'http://[::1]',
    'http://169.254.1.1',
    'http://100.64.0.1',
    'http://[fc00::1]',
    'http://[fe80::1]',
  ]) {
    it(`rejects ${unreachable}`, () => {
      assert.throws(() => validatePublicBaseUrl(unreachable), /cannot reach/);
    });
  }

  for (const reachable of [
    'http://100.63.0.1',
    'http://100.128.0.1',
    'https://fdstories.example.com',
    'https://fcbarcelona.com',
  ]) {
    it(`accepts ${reachable}`, () => {
      assert.equal(validatePublicBaseUrl(reachable), reachable);
    });
  }
});
