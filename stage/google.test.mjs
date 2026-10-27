import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { verifyGoogleToken } from './google.mjs';
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey); jwk.kid = 'test-key'; jwk.alg = 'RS256';
const keys = createLocalJWKSet({ keys: [jwk] });
const now = Math.floor(Date.now() / 1000);
async function signed(overrides = {}, signingKey = privateKey) {
  return new SignJWT({ iss: 'https://accounts.google.com', aud: 'stage-client', sub: 'google-owner', email: 'owner@example.net', email_verified: true, nonce: 'login-nonce', iat: now, exp: now + 3600, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(signingKey);
}
test('real RSA signature and Google claims verify through the maintained verifier', async () => {
  assert.equal((await verifyGoogleToken(await signed(), 'stage-client', keys)).sub, 'google-owner');
});
test('tampered signature, wrong audience, wrong issuer, and expired token are rejected', async () => {
  const { privateKey: wrongKey } = await generateKeyPair('RS256');
  await assert.rejects(verifyGoogleToken(await signed({}, wrongKey), 'stage-client', keys));
  for (const claims of [{ aud: 'another-client' }, { iss: 'https://attacker.example' }, { exp: now - 100 }, { iat: now - 1000 }, { azp: 'another-client' }]) await assert.rejects(verifyGoogleToken(await signed(claims), 'stage-client', keys));
});
test('required nonce, subject and verified-email claims cannot be omitted', async () => {
  for (const name of ['nonce', 'sub', 'email', 'email_verified', 'exp', 'iat']) {
    const claims = { [name]: undefined };
    await assert.rejects(verifyGoogleToken(await signed(claims), 'stage-client', keys));
  }
});
