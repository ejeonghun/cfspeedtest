# Service, privacy, and legal notice

[한국어](DISCLAIMER.ko.md) · [README](README.md)

This notice describes cfspeedtest's behavior and limitations. It is not legal advice, a service-level agreement, or a guarantee of permission to use any external service. Seek qualified advice if your intended use needs legal review.

## Independent software; separate service rights

cfspeedtest is independent and unofficial. It is not affiliated with, sponsored, endorsed, or supported by Cloudflare. Cloudflare and other names/marks belong to their respective owners; no trademark clearance or right to use them is implied.

The project is MIT-licensed under [LICENSE](LICENSE). Substantial HTTP measurement algorithms and schedules are adapted from **@cloudflare/speedtest 1.14.1**, commit `323da2ea5697ab4953f2c90c931125ac35d019d8`. Preserve the Cloudflare copyright and full upstream MIT text in [NOTICE](NOTICE) and [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

Those licenses cover software, **not** Cloudflare/IANA/RIR/KRNIC services, trademarks, service availability, or access permissions. Open source does not imply unlimited access, exemption from service terms, or assured compliance with them.

## Responsible use and traffic

You are responsible for applicable laws, service terms, network authorization, data charges, and fair use. Do not flood services, aggressively repeat or schedule tests, bypass access refusals or rate limits, or attempt unauthorized access. A public endpoint is not a guaranteed public API. Registry operators have their own notices, policies, and rate limits; there is no uniform service license or availability promise.

Relevant Cloudflare references, checked on **2026-10-06**:

- [Website and Online Services Terms](https://www.cloudflare.com/website-terms/) — effective 2025-08-01; includes prohibited uses in §7 and addresses public website/online-service use.
- [Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/) — updated 2025-09-12; account/subscription-oriented terms that may be relevant depending on use.
- [Privacy Policy](https://www.cloudflare.com/privacypolicy/) — effective 2025-11-04.

These references do not establish which agreement governs every speed-test request or guarantee that a particular use is permitted. Review current terms for your circumstances. Do not assume privacy promises for Cloudflare DNS resolver products apply to this CLI.

Tests transfer real data. Nominal main payload is 18,100,000 bytes (`--quick`), 315,800,000 bytes (default: 169,000,000 down + 146,800,000 up), or 1,265,800,000 bytes (`--full`: 969,000,000 down + 296,800,000 up). Adaptive completion may reduce payload; metadata, registry replies, side pings, retries, and protocol/network overhead add traffic. Payload estimates are not exact billed wire traffic. The default 1,300,000,000-byte HTTP-body budget includes ancillary and retry bodies but excludes protocol overhead; it is not a billing cap.

The default omits bandwidth requests above 25 MB, a software-selected cap rather than a verified Cloudflare limit. Large `--full` requests can return HTTP 403 on some networks; this does not establish a universal size limit. The CLI does not split or replace denied requests, use authentication proxies, or bypass refusals.

## Measurement limitations

Availability, compatibility, accuracy, and continued endpoint behavior are best-effort, with no guarantee or SLA. Results measure the current path to Cloudflare, not every Internet destination, overall ISP performance, a verified retail ISP identity, or contractual subscription speed.

Native HTTPS HTTP/1.1 timing approximates browser Resource Timing. Routing, timing, proxies, and browser protocol differences can affect results; the live website's profile and exact result parity are not guaranteed. HTTP ping is not ICMP. No browser or WebRTC/TURN packet-loss test runs, so packet loss is `null`, never a measured 0%. Quick loaded metrics can be `null` when samples miss the 250 ms duration filter. IP geolocation is approximate, not a physical/GPS location.

## Requests and privacy

Cloudflare traffic uses HTTPS at `speed.cloudflare.com`: optional `GET /meta`, measurement/side-ping `GET /__down`, and upload `POST /__up`. Metadata failure, including HTTP 403, is nonfatal. Ordinary permitted download headers can supply ASN, city, country, and colo; this is not an access workaround. There is no separate `__results` submission, telemetry report, result-post logging, or TURN traffic. This describes the CLI, not the upstream browser product's collection behavior. Cloudflare still receives source IP and ordinary request metadata.

When provider is missing and a valid ASN is known, an optional lookup is enabled by default:

- Fetch the static [IANA ASN RDAP bootstrap](https://data.iana.org/rdap/asn.json), then `/autnum/<ASN>` from the selected official APNIC, ARIN, RIPE NCC, LACNIC, or AFRINIC RDAP service.
- Follow at most two explicitly allowlisted official referrals, including KRNIC delegation. No arbitrary hosts/subdomains, credentials, explicit ports, queries, or fragments are allowed; referrals must use HTTPS and the same ASN path.
- At most one lookup per run, four GETs total, no retries, a five-second total lookup deadline within the overall deadline, and 128 KiB per response. Bodies count toward the payload budget; lookup does not run during active bandwidth measurement. Failure is nonfatal.
- Query only a public ASN, not IP/city/coordinates. IANA receives no ASN query; the registry/referral receives the ASN path. This is not an IP-location service, RIPEstat query, hardcoded brand map, or Cloudflare refusal bypass.

Provider uses Cloudflare's organization label if present. Otherwise it prefers a unique explicitly structured RDAP registrant organization, then a source-specific, single declared KRNIC AS description from the exact same-AS URL, with registered AS name/identifier as fallback. Conflicting registrant organizations fall back to the registered name. It does not infer a brand from arbitrary remarks or personal contacts. JSON `network.providerSource` preserves provenance, including the actual registry URL when used.

Use `--no-provider-lookup` to disable every external bootstrap, RIR, and referral request; Cloudflare traffic continues. **All contacted HTTPS services see the connection's source IP**, even when it is not query data, and may retain logs governed by their own policies. This is not anonymity or a promise of log deletion.

The CLI does not persist IP addresses, coordinates, personal RDAP contacts, or full registry responses. The lookup retains ASN/provider label/source in memory, not personal registry contact data. Saved terminal or JSON output and any surrounding logging are under your control.

## Warranty and liability

The MIT license provides the software **“AS IS”**, without warranty, including merchantability, fitness for a particular purpose, and noninfringement, and excludes author/copyright-holder liability as stated in the license. These provisions apply subject to applicable law; this notice does not claim that all liability can always be excluded or create additional enforceable waivers. No service operator's obligations are changed by this notice.
