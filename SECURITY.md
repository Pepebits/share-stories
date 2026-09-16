# Security

## Reporting a vulnerability

Please do not open a public issue for anything that could be a security
problem. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository. You should hear back
within a week.

Include what you found, how to reproduce it, and what you think an attacker
could do with it. A fix is far easier when the report shows the path, not just
the destination.

## What is in scope

Anything that lets someone other than the operator:

- read or use the Telegram session, the Instagram token, or the contents of
  `.env` and `data/`;
- publish to the Instagram account, or publish media that was not one of the
  monitored peers' stories;
- reach the media server's URLs other than through the single-use link handed
  to Meta, or reach media after that link was revoked;
- widen a story's audience beyond what `TELEGRAM_STORY_SCOPES` allows.

Out of scope: rate limiting or policy decisions made by Telegram or Meta,
vulnerabilities in dependencies that Dependabot already tracks (a PR is more
useful than a report), and anything that requires an attacker to already have
root on the machine running the bridge.

## What the operator should know

The bridge holds two credentials that no software design can make safe if the
host itself is compromised:

| Credential | Grants |
|---|---|
| `data/telegram-session.txt` | **The whole Telegram account.** Every private message, and sending as you. There is no read-only scope. |
| `data/instagram-token.json` | Publishing to the Instagram account, for up to 60 days |

If either may have leaked: revoke the Telegram session from
**Settings → Devices** first, since it is the one that cannot be scoped, then
mint a new Instagram token and paste it into `.env`. Both take a minute.

The published image contains no credentials; `.dockerignore` excludes `.env`
and `data/`. It runs read-only, as a non-root user, with all capabilities
dropped. CI scans it with Trivy for `HIGH` and `CRITICAL` findings on every
push, and `pnpm audit --prod` runs as part of `pnpm run verify`.

## Supported versions

Only the latest release on Docker Hub and GitHub Container Registry receives
fixes. There are no long-term support branches.
