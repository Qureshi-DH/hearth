---
sidebar_position: 2
title: Remote access
---

Your family's phones have to reach the server from wherever they are. This page
covers the ways to arrange that, and which one to pick.

## Read this first: Hearth is not a photo server

Most self-hosted guides rank a VPN as the best option, because most self-hosted
apps are things you open deliberately. You are at a coffee shop, you want a
photo, you connect and fetch it.

Hearth is not used that way. Phones upload location continuously, in the
background, mostly while nobody is looking at the screen. That inverts the usual
advice:

- **A VPN that drops is a hole in the map.** Every minute the tunnel is down is a
  minute nobody can see where your child is. Phone VPN clients drop constantly:
  moving between Wi-Fi and cellular, low-power mode, the OS reclaiming memory.
- **A VPN is a second thing to keep alive on every phone.** Hearth already asks
  for background location and battery exemption. Adding an always-on tunnel to
  that list costs battery and gives the OS another process to kill.
- **Everyone has to install it.** Including the family members who are not going
  to debug a tunnel.

So the ranking below is close to the reverse of what you will read elsewhere,
and the reason is that this app has to work when nobody is paying attention.

## Never expose plain HTTP

Whatever you choose, do not forward port 4000 to the internet as it is.
Location data, session tokens and nudges would cross the network in the clear,
readable by every network between the phone and your house.

The apps enforce a good deal of this for you. A production Android build refuses
cleartext HTTP outright, and a production iOS build allows it only to private
address ranges. See [the mobile app page](../developer/mobile.md) for the full table. If you find
yourself reaching for `HEARTH_ALLOW_HTTP=1` to get around a connection problem,
stop and fix the transport instead.

## The options

| Option              | Works in the background | Family setup     | Hides your home IP | Difficulty |
| ------------------- | ----------------------- | ---------------- | ------------------ | ---------- |
| Reverse proxy + TLS | Reliable                | Nothing to do    | No                 | Moderate   |
| Cloudflare Tunnel   | Reliable                | Nothing to do    | Yes                | Moderate   |
| Tailscale           | Usually                 | An app per phone | Yes                | Low        |
| Classic VPN         | Unreliable              | An app per phone | Yes                | High       |

### Reverse proxy with TLS, on a domain you own

**Recommended for most people.** A reverse proxy terminates HTTPS and forwards
to the API. Phones use a normal `https://` address and nothing else has to run
on them.

You need a domain name, ports 80 and 443 reachable, and dynamic DNS if your home
address changes. [Self-hosting](self-hosting.md) has working Caddy, nginx and
Traefik configurations. Caddy is three lines and gets its own certificate.

What you are accepting: your API is reachable from the internet, so it needs to
hold up on its own. Keep the server updated, keep `REGISTRATION_MODE` at
`invite` or `closed` so strangers cannot sign up, and use a real
`ADMIN_PASSWORD`. Your home IP address is visible to anyone who resolves the
name, which for most families is not a meaningful exposure, but it is worth
knowing.

### Cloudflare Tunnel

A daemon on your server makes an outbound connection to Cloudflare, and
Cloudflare publishes a hostname that reaches it. No ports forwarded, no dynamic
DNS, and your home address is never published.

Two honest caveats. Your family's location data passes through Cloudflare's
network, which sits awkwardly beside the reason you are self-hosting at all.
And Cloudflare's free plan is intended for serving websites rather than
proxying arbitrary application traffic, so read their current terms before you
rely on it for something that matters.

Websockets work over Tunnel, which Hearth needs for the live map.

### Tailscale

Tailscale joins your server and your phones to one private network, with no
ports forwarded and no domain to buy. It is the easiest thing on this page to
set up, and it genuinely does keep the API off the public internet.

The cost is one app on every family phone, each needing an account, and a
tunnel that has to stay up for location to keep flowing. Tailscale reconnects
far more reliably than a hand-rolled VPN, so this is a reasonable choice for a
technical household. It is a poor choice if you are setting phones up for people
who will not notice when something has quietly stopped.

If you go this way, use a [Tailscale
MagicDNS](https://tailscale.com/kb/1081/magicdns) name and serve HTTPS with
`tailscale cert`, so the apps get a real certificate rather than an IP address.

### Classic VPN, WireGuard or OpenVPN

The most private option and the worst fit for this app. Everything under
"Hearth is not a photo server" applies most strongly here: an always-on
site-to-site tunnel from a phone is exactly the thing modern mobile operating
systems are most willing to tear down.

Choose it if you already run a VPN your family is already on, and accept that
gaps in location history will follow the tunnel's uptime rather than the app's.

## What Hearth needs from whichever you choose

**Websockets must pass through.** The live map, nudges and SOS all arrive over
a websocket at `/api/v1/ws`. A proxy that buffers or strips upgrade headers will
leave the map looking frozen while everything else works. Caddy and Traefik do
this correctly with no configuration. For nginx see the config in
[self-hosting](self-hosting.md).

**`PUBLIC_URL` must be the address phones actually use.** It is what invite
links and avatar URLs are built from. If phones connect to
`https://hearth.example.com` then that is the value, not `http://localhost:4000`
and not the container's address.

**Set `TRUST_PROXY=true` when you run behind a proxy.** Otherwise every request
appears to come from the proxy, and the rate limiter treats your whole family as
one client. Only set it when a proxy really is in front, because it makes the
server believe a header any client can send.

**Long-lived connections need a generous timeout.** Phones hold a websocket
open. A proxy that closes idle connections after 30 seconds will cause a
reconnect loop.

## Checking it works

From outside your network, on cellular data with Wi-Fi off:

```bash
curl https://hearth.example.com/readyz
```

You want `{"ok":true}`. Then confirm the certificate is real, which is what the
apps require:

```bash
curl -sS https://hearth.example.com/readyz > /dev/null && echo "certificate accepted"
```

A self-signed certificate will fail here, and it will fail in the apps too.

Then open the app on a phone that is not at home, and check that its own dot
moves on the map. That exercises the whole path: HTTPS in, the websocket, and
background upload out.

## If phones stop updating away from home

Work down this list.

1. **Does `curl https://your-server/readyz` work from cellular?** If not, the
   problem is the transport, not Hearth.
2. **Is the certificate valid and unexpired?** Both platforms refuse a bad one
   in the background with no visible error.
3. **Does the map go stale only for one phone?** Then it is that device, not the
   server. Check _You, Tracking status_ in the app, which reports the permission
   state and how long ago the last upload succeeded.
4. **Is everything stale at once, but the app works when you open it?** That is
   usually the websocket being closed by a proxy timeout, or upgrade headers
   being stripped.
5. **Does it recover the moment you open the app?** Then location is being
   collected but not uploaded in the background. Look at battery optimisation on
   Android and Background App Refresh on iOS, both covered in the app's
   Permissions screen.
