# Security policy

Hearth handles about the most sensitive personal data there is. It knows where
people are, all the time. Please report vulnerabilities responsibly.

## Reporting

Email the maintainers (see the repository's GitHub profile) or open a
**private** security advisory on GitHub. Don't file a public issue for anything
exploitable. You should hear back within a few days.

## Scope

Everything under `server/` counts: authentication, authorisation, the privacy
projection in `services/presence.ts`, input validation, injection, and rate
limiting. In `apps/mobile/`, it's token storage, deep-link handling, and
anything else that could leak a position to a party the user didn't choose.
Docker images and compose files too.

Vulnerabilities in third-party services you choose to configure (Expo push,
ntfy, tile hosts) are out of scope, and so is denial of service against your
own instance.

## Design commitments

- Refresh tokens are stored hashed and rotated on every use.
- Passwords are hashed with scrypt (N=2¹⁵) and compared in constant time.
- Every authorisation decision is made against the database per request. Role
  and membership are never trusted from the JWT.
- Location visibility always passes through one projection function, so
  "paused" and "approximate" cannot be bypassed by an alternate endpoint.
- Push payloads never contain coordinates.

## Supported versions

The `main` branch and the latest tagged release.
