type AccessConfig = {
  issuer: string;
  audience: string;
  ownerSubject: string;
};

const maxTokenLength = 16 * 1024;
const maxKeySetBytes = 64 * 1024;
const signingAlgorithm = "RSASSA-PKCS1-v1_5";
const teamIssuer =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const base64url = /^[A-Za-z0-9_-]+$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function decode(segment: string) {
  return Uint8Array.from(
    atob(segment.replace(/-/g, "+").replace(/_/g, "/")),
    (char) => char.charCodeAt(0),
  );
}

async function readKeySet(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const bytes = new Uint8Array(maxKeySetBytes);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(decoder.decode(bytes.subarray(0, length)));
      if (value.length > bytes.length - length) {
        void reader.cancel().catch(() => {});
        return null;
      }
      bytes.set(value, length);
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function verifyAccess(
  request: Request,
  config: AccessConfig,
  fetchKeys: typeof fetch = (input, init) => fetch(input, init),
  nowMs: number = Date.now(),
): Promise<string | null> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  const { issuer, audience, ownerSubject } = config;
  if (
    !token ||
    token.length > maxTokenLength ||
    !teamIssuer.test(issuer) ||
    !audience ||
    !ownerSubject ||
    !Number.isFinite(nowMs)
  )
    return null;

  try {
    const [protectedHeader, payload, signature, extra] = token.split(".");
    if (
      extra !== undefined ||
      !protectedHeader ||
      !payload ||
      !signature ||
      ![protectedHeader, payload, signature].every((part) =>
        base64url.test(part),
      )
    )
      return null;
    const header = record(JSON.parse(decoder.decode(decode(protectedHeader))));
    const claims = record(JSON.parse(decoder.decode(decode(payload))));
    if (
      header?.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      !header.kid ||
      "crit" in header ||
      "b64" in header ||
      claims?.iss !== issuer ||
      claims.sub !== ownerSubject
    )
      return null;

    const { aud, exp, nbf } = claims;
    const now = nowMs / 1000;
    if (
      (aud !== audience &&
        !(
          Array.isArray(aud) &&
          aud.every((value) => typeof value === "string") &&
          aud.includes(audience)
        )) ||
      typeof exp !== "number" ||
      !Number.isFinite(exp) ||
      exp <= now ||
      (nbf !== undefined &&
        (typeof nbf !== "number" || !Number.isFinite(nbf) || nbf > now))
    )
      return null;

    const signatureBytes = decode(signature);
    if (signatureBytes.length < 256 || signatureBytes.length > 512) return null;
    const response = await fetchKeys(new URL("/cdn-cgi/access/certs", issuer), {
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    const keys = record(await readKeySet(response))?.keys;
    if (!Array.isArray(keys)) return null;
    const matching = keys.map(record).filter((key) => key?.kid === header.kid);
    if (matching.length !== 1) return null;
    const key = matching[0];
    if (
      key?.kty !== "RSA" ||
      (key.alg !== undefined && key.alg !== "RS256") ||
      (key.use !== undefined && key.use !== "sig") ||
      typeof key.n !== "string" ||
      key.n.length > 683 ||
      !base64url.test(key.n) ||
      typeof key.e !== "string" ||
      key.e.length > 8 ||
      !base64url.test(key.e) ||
      "d" in key
    )
      return null;
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: signingAlgorithm, hash: "SHA-256" },
      false,
      ["verify"],
    );
    const { modulusLength } = publicKey.algorithm as RsaKeyAlgorithm;
    if (modulusLength < 2048 || modulusLength > 4096) return null;
    const verified = await crypto.subtle.verify(
      signingAlgorithm,
      publicKey,
      signatureBytes,
      new TextEncoder().encode(`${protectedHeader}.${payload}`),
    );
    return verified ? ownerSubject : null;
  } catch {
    return null;
  }
}
