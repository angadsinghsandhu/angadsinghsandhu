export interface GitHubEnv {
  PRIVATE_ORIGIN: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_OWNER_ID: string;
}

export const callbackPath = "/account/github/callback/";
export const logoutPath = "/account/sign-out/";
const oauthCookie = "__Host-portfolio-oauth";
const sessionCookie = "__Host-portfolio-session";
const oauthLifetime = 600;
const sessionLifetime = 8 * 3600;
const encoder = new TextEncoder();
const encodedRandom = /^[A-Za-z0-9_-]{43}$/u;

function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function random() {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

function cookie(name: string, value = "", maxAge = 0) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function readCookie(request: Request, name: string) {
  const prefix = `${name}=`;
  const matches = request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix));
  return matches?.length === 1 ? matches[0]!.slice(prefix.length) : null;
}

function secretKey(env: GitHubEnv) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(env.GITHUB_CLIENT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function now() {
  return Math.floor(Date.now() / 1000);
}

async function signedValue(
  env: GitHubEnv,
  name: string,
  value: string,
  lifetime: number,
) {
  const payload = `${value}.${now() + lifetime}`;
  const tag = await crypto.subtle.sign(
    "HMAC",
    await secretKey(env),
    encoder.encode(`${name}:${payload}`),
  );
  return `${payload}.${encode(new Uint8Array(tag))}`;
}

async function readSignedValue(request: Request, env: GitHubEnv, name: string) {
  if (!env.GITHUB_CLIENT_SECRET) return null;
  const raw = readCookie(request, name);
  if (!raw || raw.length > 200) return null;
  const parts = raw.split(".");
  const [value, expiry, signature] = parts;
  if (
    parts.length !== 3 ||
    !value ||
    !expiry ||
    !signature ||
    !encodedRandom.test(signature) ||
    !/^\d{1,10}$/u.test(expiry) ||
    Number(expiry) <= now()
  )
    return null;
  const tag = Uint8Array.from(
    atob(signature.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );
  return encode(tag) === signature &&
    (await crypto.subtle.verify(
      "HMAC",
      await secretKey(env),
      tag,
      encoder.encode(`${name}:${value}.${expiry}`),
    ))
    ? value
    : null;
}

function authResponse(
  status: number,
  body: string | null,
  location?: string,
  cookies: string[] = [],
) {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  if (location) headers.set("Location", location);
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(body, { status, headers });
}

function configured(env: GitHubEnv) {
  return Boolean(
    env.GITHUB_CLIENT_ID &&
    env.GITHUB_CLIENT_SECRET &&
    /^[1-9]\d*$/u.test(env.GITHUB_OWNER_ID),
  );
}

export async function githubLogin(env: GitHubEnv) {
  if (!configured(env)) return authResponse(503, "Sign-in is unavailable.");
  const state = random();
  const verifier = random();
  const challenge = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier),
  );
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: env.PRIVATE_ORIGIN + callbackPath,
    state,
    code_challenge: encode(new Uint8Array(challenge)),
    code_challenge_method: "S256",
  }).toString();
  return authResponse(303, null, url.href, [
    cookie(
      oauthCookie,
      await signedValue(
        env,
        oauthCookie,
        `${state}~${verifier}`,
        oauthLifetime,
      ),
      oauthLifetime,
    ),
  ]);
}

export async function githubCallback(request: Request, env: GitHubEnv) {
  if (!configured(env)) return authResponse(503, "Sign-in is unavailable.");
  const clear = [cookie(oauthCookie)];
  const params = new URL(request.url).searchParams;
  const [state, verifier] = (
    (await readSignedValue(request, env, oauthCookie)) ?? ""
  ).split("~");
  const code = params.get("code");
  if (
    !state ||
    !verifier ||
    params.getAll("state").length !== 1 ||
    params.get("state") !== state
  )
    return authResponse(400, "Sign-in state expired or did not match.");

  if (
    params.getAll("code").length !== 1 ||
    !code ||
    code.length > 512 ||
    params.has("error")
  )
    return authResponse(
      400,
      "Sign-in could not be completed. Reopen /account/ to try again.",
      undefined,
      clear,
    );

  try {
    const token = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        redirect_uri: env.PRIVATE_ORIGIN + callbackPath,
        code,
        code_verifier: verifier,
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    const grant = token.ok
      ? ((await token.json()) as {
          access_token?: unknown;
          token_type?: unknown;
          scope?: unknown;
        })
      : null;
    if (
      typeof grant?.access_token !== "string" ||
      !grant.access_token ||
      grant.token_type !== "bearer" ||
      grant.scope !== ""
    )
      return authResponse(
        403,
        "Sign-in authorization was rejected.",
        undefined,
        clear,
      );

    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${grant.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "angadsandhu.dev private progress",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok)
      return authResponse(
        503,
        "Identity verification is unavailable.",
        undefined,
        clear,
      );
    const user = (await response.json()) as { id?: unknown } | null;
    if (
      typeof user?.id !== "number" ||
      !Number.isSafeInteger(user.id) ||
      String(user.id) !== env.GITHUB_OWNER_ID
    )
      return authResponse(
        403,
        "This GitHub account cannot access private progress.",
        undefined,
        clear,
      );

    const session = await signedValue(
      env,
      sessionCookie,
      env.GITHUB_OWNER_ID,
      sessionLifetime,
    );
    return authResponse(303, null, "/account/", [
      ...clear,
      cookie(sessionCookie, session, sessionLifetime),
    ]);
  } catch {
    return authResponse(
      503,
      "Identity verification is unavailable.",
      undefined,
      clear,
    );
  }
}

export async function verifySession(request: Request, env: GitHubEnv) {
  if (!configured(env)) return null;
  const owner = await readSignedValue(request, env, sessionCookie);
  return owner === env.GITHUB_OWNER_ID ? owner : null;
}

export function githubLogout() {
  return authResponse(303, null, "/practice/leetcode/", [
    cookie(sessionCookie),
    cookie(oauthCookie),
  ]);
}
