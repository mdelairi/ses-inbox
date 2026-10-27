import { createRemoteJWKSet, jwtVerify } from 'jose';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { timeoutDuration: 5000 });
export async function verifyGoogleToken(value, audience, keys = googleKeys) {
  const { payload } = await jwtVerify(value, keys, { audience, issuer: ['https://accounts.google.com', 'accounts.google.com'], algorithms: ['RS256'], requiredClaims: ['sub', 'email', 'email_verified', 'nonce', 'iat', 'exp'], maxTokenAge: '10m', clockTolerance: 5 });
  if (payload.azp && payload.azp !== audience) throw new Error('InvalidAuthorizedParty');
  return payload;
}
