# P10 owner sign-in on the free tier

Use a dedicated GitHub OAuth app with no requested scopes. Match the numeric GitHub account ID `55819847` for `angadsinghsandhu`. Reuse the existing progress Worker, D1 database and API. Activation requires confirmation of the account-level Workers Free plan with hard usage limits. Zero Trust requires terms the owner declined. Local-only storage would lose cross-device sync.

- [x] Exercise the OAuth flow in Worker tests first. Cover state and PKCE, rejection of the wrong account or broader scopes, signed session expiry, alternate ingress, same-origin logout, and private API denial.
- [x] Replace Access JWT validation with OAuth callback and a short-lived, host-only signed session. Preserve the API schema, optimistic writes, export and D1 migration.
- [ ] Review and verify the frozen tree. Open the PR and register the dedicated OAuth app with the fixed canonical callback. Keep the client secret in the Worker secret store.
- [ ] Verify Workers Free and the empty progress table before routing the Worker fail closed. Prove hosted denial, sign-in, sync, export and logout. Expose the public controls only after the Worker passes hosted checks.
