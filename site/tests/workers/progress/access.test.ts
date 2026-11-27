import { beforeAll, describe, expect, it, vi } from "vitest";
import { verifyAccess } from "../../../workers/progress/access.ts";

const config = {
  issuer: "https://example-team.cloudflareaccess.com",
  audience: "portfolio-progress",
  ownerSubject: "owner-id",
};
const now = 1_800_000_000;
const claims = {
  iss: config.issuer,
  aud: ["other", config.audience],
  sub: config.ownerSubject,
  exp: now + 60,
  nbf: now,
};
const header = { alg: "RS256", kid: "fixture-key" };
let keyPair: CryptoKeyPair;
let jwk: JsonWebKey & typeof header;

beforeAll(async () => {
  keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  jwk = {
    ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)),
    ...header,
    use: "sig",
  };
});

function tokenRequest(assertion: string) {
  return new Request("https://portfolio.example/api/progress", {
    headers: { "Cf-Access-Jwt-Assertion": assertion },
  });
}

async function token(
  payload: object = claims,
  protectedHeader: object = header,
) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode(protectedHeader)}.${encode(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}

const validKeys = () =>
  vi.fn<typeof fetch>(async () => Response.json({ keys: [jwk] }));

describe("Access owner assertion", () => {
  it("verifies the signature and returns the exact owner subject", async () => {
    const fetchKeys = validKeys();
    expect(
      await verifyAccess(
        tokenRequest(await token()),
        config,
        fetchKeys,
        now * 1000,
      ),
    ).toBe("owner-id");
    expect(fetchKeys).toHaveBeenCalledOnce();
    const [url, options] = fetchKeys.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://example-team.cloudflareaccess.com/cdn-cgi/access/certs",
    );
    expect(options?.redirect).toBe("error");
    expect(options?.headers).toBeUndefined();
  });

  it("does not trust the cookie, authorization bearer or identity headers", async () => {
    const fetchKeys = validKeys();
    const assertion = await token();
    const request = new Request("https://portfolio.example/api/progress", {
      headers: {
        Cookie: `CF_Authorization=${assertion}`,
        Authorization: `Bearer ${assertion}`,
        "Cf-Access-Authenticated-User-Email": "owner@example.test",
        "X-Owner-Subject": config.ownerSubject,
      },
    });
    expect(
      await verifyAccess(request, config, fetchKeys, now * 1000),
    ).toBeNull();
    expect(fetchKeys).not.toHaveBeenCalled();
  });

  it.each([
    ["missing expiry", { exp: undefined }],
    ["expired", { exp: now }],
    ["string expiry", { exp: String(now + 60) }],
    ["future not-before", { nbf: now + 1 }],
    ["invalid not-before", { nbf: null }],
    ["wrong issuer", { iss: "https://other.cloudflareaccess.com" }],
    ["wrong audience", { aud: [`prefix-${config.audience}`] }],
    ["mixed audience types", { aud: [config.audience, null] }],
    ["wrong subject", { sub: "OWNER-ID" }],
    ["missing subject", { sub: undefined }],
  ])("rejects a signed assertion with %s", async (_, override) => {
    const fetchKeys = validKeys();
    expect(
      await verifyAccess(
        tokenRequest(await token({ ...claims, ...override })),
        config,
        fetchKeys,
        now * 1000,
      ),
    ).toBeNull();
    expect(fetchKeys).not.toHaveBeenCalled();
  });

  it("accepts the exact single audience with no optional not-before", async () => {
    expect(
      await verifyAccess(
        tokenRequest(
          await token({ ...claims, aud: config.audience, nbf: undefined }),
        ),
        config,
        validKeys(),
        now * 1000,
      ),
    ).toBe(config.ownerSubject);
  });

  it.each([
    { alg: "HS256", kid: header.kid },
    { alg: header.alg, kid: "missing-key" },
    { alg: header.alg },
    { ...header, crit: ["unsupported"], unsupported: true },
  ])(
    "rejects unsupported protected headers or an unknown key ID (%j)",
    async (protectedHeader) => {
      expect(
        await verifyAccess(
          tokenRequest(await token(claims, protectedHeader)),
          config,
          validKeys(),
          now * 1000,
        ),
      ).toBeNull();
    },
  );

  it("rejects a bogus signature", async () => {
    const [protectedHeader, payload] = (await token()).split(".");
    const bogus = Buffer.alloc(256).toString("base64url");
    expect(
      await verifyAccess(
        tokenRequest(`${protectedHeader}.${payload}.${bogus}`),
        config,
        validKeys(),
        now * 1000,
      ),
    ).toBeNull();
  });

  it.each(["malformed", "a.".repeat(9000), "x.y.z="])(
    "rejects invalid token syntax before fetching",
    async (assertion) => {
      const fetchKeys = validKeys();
      expect(
        await verifyAccess(
          tokenRequest(assertion),
          config,
          fetchKeys,
          now * 1000,
        ),
      ).toBeNull();
      expect(fetchKeys).not.toHaveBeenCalled();
    },
  );

  it("rejects a configured issuer outside the Access team domain", async () => {
    const issuer = "https://example-team.cloudflareaccess.com.example.test";
    const fetchKeys = validKeys();
    expect(
      await verifyAccess(
        tokenRequest(await token({ ...claims, iss: issuer })),
        { ...config, issuer },
        fetchKeys,
        now * 1000,
      ),
    ).toBeNull();
    expect(fetchKeys).not.toHaveBeenCalled();
  });

  it.each([
    () => {
      throw new Error("network unavailable");
    },
    () => new Response(null, { status: 503 }),
    () => Response.json({ keys: [jwk, jwk] }),
    () => Response.json({ keys: [{ ...jwk, kty: "oct" }] }),
    () => Response.json({ keys: [jwk], padding: "x".repeat(70_000) }),
    () => new Response("invalid JSON"),
  ])(
    "fails closed when the certificate response cannot be used",
    async (respond) => {
      const fetchKeys = vi.fn<typeof fetch>(async () => respond());
      expect(
        await verifyAccess(
          tokenRequest(await token()),
          config,
          fetchKeys,
          now * 1000,
        ),
      ).toBeNull();
    },
  );
});
