# cfspeedtest

[한국어](README.ko.md) · [Source on GitHub](https://github.com/ejeonghun/cfspeedtest) · [Service and privacy notice](DISCLAIMER.md)

An independent, unofficial Cloudflare HTTP speed test CLI. **Node.js 22+**, native ESM, zero npm dependencies. Not affiliated with, sponsored, endorsed, or supported by Cloudflare.

## Quick start

### From source

With Node.js 22+ and npm installed, run from the checkout root:

```sh
npm install -g .
cfspeedtest --quick
```

Without a global installation:

```sh
node bin/cfspeedtest.js --quick
```

### From npm

For npm releases:

The npm package is `@wjdgns4019/cfspeedtest`; the CLI command remains `cfspeedtest`.

```sh
npm install -g @wjdgns4019/cfspeedtest
cfspeedtest
```

Or run a shorter test without a separate global install: `npx --yes @wjdgns4019/cfspeedtest --quick`.
The primary command is `cfspeedtest`; `cloudflare-speedtestcli` remains a legacy alias. No build step is required.

**Real traffic, not a demo:** nominal main payload is **18.1 MB** with `--quick`, **315.8 MB** by default, or **1.2658 GB** with `--full`. Metadata, side pings, retries, and HTTP/network overhead can add traffic and charges. Review the [service and privacy notice](DISCLAIMER.md) before use, especially on metered networks.

## Screenshot

<img src="https://raw.githubusercontent.com/ejeonghun/cfspeedtest/main/docs/images/cfspeedtest-result.png" alt="Actual cfspeedtest quick-test CLI output with download, upload, HTTP ping, jitter, server, AS, provider, and approximate location" width="800">

Actual CLI output from one quick test, rendered as a terminal-style image. The command shown uses a 60-second timeout and a 20,000,000-byte HTTP-body budget. Results and IP-estimated location vary; this is not a universal performance benchmark.

## Options

```sh
cfspeedtest --help
cfspeedtest --quick --json
cfspeedtest --quick --verbose
cfspeedtest --quick --timeout 120 --max-bytes 20000000
cfspeedtest --quick --no-provider-lookup
```

| Option | Meaning |
| --- | --- |
| `--quick` | Shorter, CLI-defined schedule; 18,100,000 nominal main payload bytes. |
| `--full` | Original upstream HTTP schedule, including large requests. Mutually exclusive with `--quick`. |
| `--json` | One full JSON object on success, including warnings and provider provenance; no progress output. |
| `--verbose` | Detailed results, loaded metrics, payload usage, warnings, and notices. Does not change the schedule. |
| `--timeout <seconds>` | Overall deadline; default 300 seconds, maximum 3600. |
| `--max-bytes <integer>` | Positive HTTP-body byte budget; default 1,300,000,000. Not a wire-traffic or billing cap. |
| `--color auto\|always\|never` | TTY-only color; honors `NO_COLOR` and `TERM=dumb`. Even `always` adds no ANSI to piped stdout. |
| `--no-provider-lookup` | Disable external IANA/RIR/referral ASN lookups, not Cloudflare requests. |
| `--help`, `--version` | Show usage or version without a speed test. |

## Results and traffic

Default output has eight concise rows: download/upload Mbps, HTTP ping/jitter, Cloudflare server colo, AS, provider, and approximate IP location. Interactive terminals show a colored, nine-row in-place live display. Pipes and JSON have no progress output. Nonfatal warnings are quiet by default; `--verbose` shows them. Fatal errors are always reported.

Successful JSON stdout is one complete object; stderr is empty unless `--verbose` adds notices or warnings. On failure, JSON stdout is empty, errors go to stderr, and the exit status is nonzero. Loaded latency/jitter and payload details remain in JSON even when omitted from the concise display.

| Profile | Nominal main download | Nominal main upload | Total |
| --- | ---: | ---: | ---: |
| `--quick` | — | — | 18.1 MB |
| Default | 169 MB | 146.8 MB | 315.8 MB |
| `--full` | 969 MB | 296.8 MB | 1,265.8 MB |

MB/GB are decimal. Adaptive completion can reduce payload. Metadata, registry response bodies, side pings, and retries also count toward the body budget; protocol overhead does not. Estimated payload is **not** exact billed traffic.

The default retains upstream order and latency phases but omits bandwidth steps above **25 MB per request**. This is a software choice, **not a Cloudflare service limit**; it may affect very fast links. `--full` includes 100/250 MB downloads and 50 MB uploads, which can fail on some networks. Denied requests are not silently split, replaced, or bypassed.

## Method and limitations

Substantial algorithms and schedules are adapted from MIT-licensed **@cloudflare/speedtest 1.14.1**, commit [`323da2ea5697ab4953f2c90c931125ac35d019d8`](https://github.com/cloudflare/speedtest/tree/323da2ea5697ab4953f2c90c931125ac35d019d8): server-time adjustment, p50 latency, p90 bandwidth, chronological consecutive-difference jitter, duration filters, and loaded-measurement semantics.

Native Node HTTPS HTTP/1.1 keep-alive approximates browser timing; website configuration and result parity are not guaranteed. HTTP ping is not ICMP. Results describe the current path to Cloudflare, not all Internet performance or a contractual ISP speed. No browser or WebRTC/TURN packet-loss test runs: packet loss is always `null`, **not 0%**. Quick-mode loaded metrics can be `null` because samples miss the 250 ms duration filter.

Provider is an organization/AS-description label with a registered AS name or identifier fallback, **not a verified retail ISP identity**. JSON `network.providerSource` records its source; for registry results this is the actual registry URL. Location is an approximate IP-based estimate, not GPS.

## Network and privacy

The CLI uses Cloudflare `GET /meta` (optional, nonfatal), `GET /__down`, and `POST /__up` on `https://speed.cloudflare.com`. Permitted download response headers can recover ASN/city/country/colo when metadata is unavailable. It does not submit `__results`, separate telemetry, or result reports. Cloudflare still receives ordinary requests, source IP, and request metadata.

If provider is missing and a valid ASN is known, one bounded lookup per run uses [IANA ASN bootstrap](https://data.iana.org/rdap/asn.json), an official RIR RDAP service, and up to two allowlisted referrals, including explicit KRNIC delegation. Limits: four GETs total, five seconds total, 128 KiB per response; bodies count toward the budget. It queries the public ASN, not IP/city/coordinates. All contacted services nevertheless see the connection's source IP and may log requests under their own policies.

The CLI does not persist IP addresses, coordinates, personal RDAP contacts, or full registry responses. This is not a promise of anonymity or service-side log deletion. Disable external registry access with `--no-provider-lookup`. See the [complete notice](DISCLAIMER.md) for service terms and lookup details.

## Troubleshooting

- **Command unavailable:** check Node.js 22+, your npm global executable path, and installation. Source installation is also available using the checkout instructions above.
- **HTTP 403 / large-request failure:** try the default or `--quick` schedule instead of `--full`; do not bypass a refusal. Large-request availability varies by network and is not a fixed, verified server cap.
- **Missing provider/location:** metadata or registry access may be unavailable; this is nonfatal. `--verbose` or `--json` exposes diagnostics.
- **Timeout or body budget reached:** the run fails rather than claiming completion. Review network conditions and data costs before raising limits.

## License and contributing

MIT: [LICENSE](LICENSE). Preserve upstream attribution and license text in [NOTICE](NOTICE) and [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

The license covers software, **not service access or trademarks**. Use authorized networks, comply with applicable terms/laws/rate limits, and avoid aggressive repetition or refusal bypasses. Services and measurements are best-effort, with no accuracy or availability guarantee; MIT warranty/liability exclusions apply subject to applicable law. See [DISCLAIMER.md](DISCLAIMER.md).

Contributions: [CONTRIBUTING.md](https://github.com/ejeonghun/cfspeedtest/blob/main/CONTRIBUTING.md). Use Node.js 22+ and `npm ci`, `npm test`, `npm run check`. Local/default tests and the CI Node.js 22/24 unit matrix are offline. After both matrix jobs pass, one separate Node.js 22 CI job installs the candidate package from that checkout and runs `cfspeedtest --quick --json --timeout 60 --max-bytes 20000000` exactly once on the GitHub runner, not the developer's PC. It requires successful completion, positive finite download/upload speeds and duration, nonnegative finite HTTP latency/jitter, and bounded byte counts; optional metadata can be unavailable. Actual values vary with the runner connection, and service denial, timeout, or network failure fails CI honestly. The quick profile has 18.1 MB nominal main payload with a 20 MB response/upload body budget; protocol overhead adds traffic. Review service terms and costs, and do not loop live measurements. Stale runs are cancelled; result JSON and stderr diagnostics are retained for three days.
