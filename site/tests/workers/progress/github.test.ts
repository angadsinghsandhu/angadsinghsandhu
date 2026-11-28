import { afterEach, describe, expect, it, vi } from "vitest";
import {
  githubCallback,
  githubLogin,
  verifySession,
} from "../../../workers/progress/github.ts";

const origin = "https://portfolio.example";
const env = {
  PRIVATE_ORIGIN: origin,
  GITHUB_CLIENT_ID: "app-id",
  GITHUB_CLIENT_SECRET: "example-secret-value",
  GITHUB_OWNER_ID: "55819847",
};

async function begin() {
  const response = await githubLogin(env);
  const authorize = new URL(response.headers.get("Location")!);
  const cookie = response.headers.get("Set-Cookie")!;
  const callback = new URL("/account/github/callback/", origin);
  callback.searchParams.set("code", "example-code");
  callback.searchParams.set("state", authorize.searchParams.get("state")!);
  return { response, authorize, cookie, callback };
}

function mockGitHub(id = 55819847, scope = "") {
  const provider = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        access_token: "mock-provider-token",
        token_type: "bearer",
        scope,
      }),
    )
    .mockResolvedValueOnce(Response.json({ id }));
  vi.stubGlobal("fetch", provider);
  return provider;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GitHub owner sign-in", () => {
  it("binds the OAuth callback to the originating browser with PKCE and minimal scope", async () => {
    const { response, authorize, cookie, callback } = await begin();
    expect(response.status).toBe(303);
    expect(authorize.origin + authorize.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorize.searchParams.get("scope")).toBeNull();
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      origin + "/account/github/callback/",
    );
    expect(cookie).toMatch(
      /^__Host-portfolio-oauth=.*; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/u,
    );
    const provider = mockGitHub();
    const result = await githubCallback(
      new Request(callback, { headers: { Cookie: cookie.split(";", 1)[0]! } }),
      env,
    );
    expect(result.status).toBe(303);
    expect(result.headers.get("Location")).toBe("/account/");
    expect(provider.mock.calls.map(([url]) => url)).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
    ]);
    const exchange = provider.mock.calls[0]![1]!.body as URLSearchParams;
    const challenge = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(exchange.get("code_verifier")!),
    );
    expect(Buffer.from(challenge).toString("base64url")).toBe(
      authorize.searchParams.get("code_challenge"),
    );
    expect(
      provider.mock.calls.every(([, init]) => init?.redirect === "manual"),
    ).toBe(true);
    const cookies = result.headers.getSetCookie();
    expect(cookies.join(" ")).not.toContain("mock-provider-token");
    expect(cookies[0]).toContain("Max-Age=0");
    const session = cookies[1]!.split(";", 1)[0]!;
    const withSession = (value: string) =>
      new Request(origin, { headers: { Cookie: value } });
    expect(await verifySession(withSession(session), env)).toBe("55819847");
    expect(await verifySession(withSession(session + "a"), env)).toBeNull();
    expect(
      await verifySession(withSession(`${session}; ${session}`), env),
    ).toBeNull();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000 + 1000);
    expect(await verifySession(withSession(session), env)).toBeNull();
  });

  it("rejects missing, mismatched, duplicate, or expired OAuth state before contacting GitHub", async () => {
    vi.useFakeTimers();
    const { callback, cookie } = await begin();
    const provider = mockGitHub();
    expect((await githubCallback(new Request(callback), env)).status).toBe(400);
    const bad = new URL(callback);
    bad.searchParams.append("state", "mismatch");
    const headers = { Cookie: cookie.split(";", 1)[0]! };
    expect(
      (await githubCallback(new Request(bad, { headers }), env)).status,
    ).toBe(400);
    vi.setSystemTime(Date.now() + 601_000);
    expect(
      (await githubCallback(new Request(callback, { headers }), env)).status,
    ).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it("keeps the newer login cookie when an older tab returns", async () => {
    const old = await begin();
    const latest = await begin();
    const provider = mockGitHub();
    const headers = { Cookie: latest.cookie.split(";", 1)[0]! };
    const stale = await githubCallback(
      new Request(old.callback, { headers }),
      env,
    );
    expect(stale.status).toBe(400);
    expect(stale.headers.getSetCookie()).toEqual([]);
    expect(provider).not.toHaveBeenCalled();
    expect(
      (await githubCallback(new Request(latest.callback, { headers }), env))
        .status,
    ).toBe(303);
  });

  it("rejects a token endpoint redirect without making another request", async () => {
    const { callback, cookie } = await begin();
    const provider = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.redirect("https://other.example/"));
    vi.stubGlobal("fetch", provider);
    const result = await githubCallback(
      new Request(callback, { headers: { Cookie: cookie.split(";", 1)[0]! } }),
      env,
    );
    expect(result.status).toBe(403);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]![1]?.redirect).toBe("manual");
  });

  it.each([
    [123, ""],
    [55819847, "repo"],
  ])("rejects unauthorized identity or scopes (%j, %s)", async (id, scope) => {
    const { callback, cookie } = await begin();
    mockGitHub(id, scope);
    const result = await githubCallback(
      new Request(callback, { headers: { Cookie: cookie.split(";", 1)[0]! } }),
      env,
    );
    expect(result.status).toBe(403);
    expect(result.headers.getSetCookie().join(" ")).not.toContain(
      "__Host-portfolio-session",
    );
  });
});
