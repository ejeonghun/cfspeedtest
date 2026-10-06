# cfspeedtest

[English](README.md) · [GitHub 소스](https://github.com/ejeonghun/cfspeedtest) · [서비스·개인정보 안내](DISCLAIMER.ko.md)

독립적인 비공식 Cloudflare HTTP 속도 측정 CLI입니다. **Node.js 22 이상**, 네이티브 ESM, npm 의존성 0개를 사용합니다. Cloudflare와 제휴 관계가 없으며 후원·보증·지원을 받지 않습니다.

## 빠른 시작

### 소스에서 실행

Node.js 22 이상과 npm을 설치한 뒤 체크아웃 루트 디렉터리에서 실행합니다.

```sh
npm install -g .
cfspeedtest --quick
```

전역 설치 없이 실행하려면:

```sh
node bin/cfspeedtest.js --quick
```

### npm에서 설치

npm 배포본을 설치하려면:

npm 패키지 이름은 `@wjdgns4019/cfspeedtest`이며, CLI 명령은 `cfspeedtest`로 유지됩니다.

```sh
npm install -g @wjdgns4019/cfspeedtest
cfspeedtest
```

별도 전역 설치 없이 짧게 측정하려면 `npx --yes @wjdgns4019/cfspeedtest --quick`을 사용합니다.
기본 명령은 `cfspeedtest`이며, 기존 `cloudflare-speedtestcli` 명령도 별칭으로 유지됩니다. 빌드 단계는 필요하지 않습니다.

**데모가 아닌 실제 트래픽입니다:** 주요 페이로드 예정량은 `--quick` **18.1 MB**, 기본 **315.8 MB**, `--full` **1.2658 GB**입니다. 메타데이터·보조 핑·재시도·HTTP/네트워크 오버헤드로 트래픽과 요금이 추가될 수 있습니다. 특히 종량제 연결에서는 사용 전 [서비스·개인정보 안내](DISCLAIMER.ko.md)를 확인하세요.

## 실행 결과

<img src="https://raw.githubusercontent.com/ejeonghun/cfspeedtest/main/docs/images/cfspeedtest-result.png" alt="다운로드, 업로드, HTTP ping, 지터, 서버, AS, 사업자, 대략적인 위치를 보여 주는 실제 cfspeedtest 빠른 측정 CLI 출력" width="800">

빠른 측정 1회의 실제 CLI 출력을 터미널 스타일 이미지로 렌더링했습니다. 표시된 명령은 60초 제한 시간과 20,000,000바이트 HTTP 본문 예산을 사용합니다. 측정 결과와 IP 기반 추정 위치는 달라질 수 있으며, 보편적인 성능 벤치마크가 아닙니다.

## 옵션

```sh
cfspeedtest --help
cfspeedtest --quick --json
cfspeedtest --quick --verbose
cfspeedtest --quick --timeout 120 --max-bytes 20000000
cfspeedtest --quick --no-provider-lookup
```

| 옵션 | 설명 |
| --- | --- |
| `--quick` | CLI 자체의 짧은 일정. 주요 페이로드 예정량 18,100,000바이트. |
| `--full` | 대형 요청을 포함한 원본 HTTP 일정. `--quick`과 함께 사용할 수 없습니다. |
| `--json` | 성공 시 경고·사업자 출처를 포함한 전체 JSON 객체 하나를 출력하며 진행 출력은 없습니다. |
| `--verbose` | 상세 결과, 부하 중 지표, 페이로드 사용량, 경고·안내를 표시합니다. 일정은 바꾸지 않습니다. |
| `--timeout <seconds>` | 전체 제한 시간. 기본 300초, 최대 3600초. |
| `--max-bytes <integer>` | 양의 정수 HTTP 본문 바이트 예산. 기본 1,300,000,000. 실제 회선 트래픽·요금 상한이 아닙니다. |
| `--color auto\|always\|never` | TTY 전용 색상. `NO_COLOR`, `TERM=dumb`을 따르며 `always`여도 파이프 stdout에 ANSI를 넣지 않습니다. |
| `--no-provider-lookup` | 외부 IANA/RIR·위임 서버 ASN 조회를 끕니다. Cloudflare 요청은 유지합니다. |
| `--help`, `--version` | 속도 측정 없이 도움말 또는 버전을 표시합니다. |

## 결과와 전송량

기본 출력은 다운로드·업로드 Mbps, HTTP ping·지터, Cloudflare 서버 colo, AS, 사업자, 대략적인 IP 위치의 간결한 8개 행입니다. 대화형 터미널에서는 색상을 사용한 9개 행의 실시간 표시가 같은 자리에서 갱신됩니다. 파이프와 JSON에는 진행 출력이 없습니다. 비치명적 경고는 기본적으로 숨기며 `--verbose`에서 표시합니다. 치명적 오류는 항상 표시합니다.

성공한 JSON stdout은 완전한 객체 하나이며, `--verbose`로 안내·경고를 켜지 않으면 stderr는 비어 있습니다. 실패 시 JSON stdout은 비어 있고 오류는 stderr로 출력하며 종료 코드는 0이 아닙니다. 간결한 화면에서 생략된 부하 중 지연 시간·지터와 페이로드 정보도 JSON에는 남습니다.

| 프로필 | 주요 다운로드 예정량 | 주요 업로드 예정량 | 합계 |
| --- | ---: | ---: | ---: |
| `--quick` | — | — | 18.1 MB |
| 기본 | 169 MB | 146.8 MB | 315.8 MB |
| `--full` | 969 MB | 296.8 MB | 1,265.8 MB |

MB/GB는 십진 단위입니다. 적응형 조기 완료로 페이로드가 줄어들 수 있습니다. 메타데이터·레지스트리 응답 본문·보조 핑·재시도도 본문 예산에 포함하지만 프로토콜 오버헤드는 제외합니다. 예상 페이로드는 **정확한 과금 트래픽이 아닙니다**.

기본 일정은 원본 순서와 지연 시간 측정 단계를 유지하되 **요청당 25 MB**보다 큰 대역폭 단계를 제외합니다. 이는 소프트웨어의 선택이며 **Cloudflare 서비스 제한이 아닙니다**. 매우 빠른 회선의 측정에 영향을 줄 수 있습니다. `--full`은 100/250 MB 다운로드와 50 MB 업로드를 포함하며 일부 네트워크에서 실패할 수 있습니다. 거부된 요청을 묵시적으로 분할·대체·우회하지 않습니다.

## 측정 방식과 한계

주요 알고리즘과 일정은 MIT 라이선스의 **@cloudflare/speedtest 1.14.1**, 커밋 [`323da2ea5697ab4953f2c90c931125ac35d019d8`](https://github.com/cloudflare/speedtest/tree/323da2ea5697ab4953f2c90c931125ac35d019d8)을 기반으로 합니다. 서버 시간 보정, p50 지연 시간, p90 대역폭, 시간순 연속 표본 차이 지터, 지속 시간 필터, 부하 중 측정 의미를 적용했습니다.

네이티브 Node HTTPS HTTP/1.1 keep-alive로 브라우저 타이밍을 근사하며, 웹사이트 설정이나 결과와의 일치를 보장하지 않습니다. HTTP ping은 ICMP가 아닙니다. 결과는 현재 Cloudflare까지의 경로를 측정하며 전체 인터넷 성능이나 ISP 계약 속도를 나타내지 않습니다. 브라우저 또는 WebRTC/TURN 패킷 손실 테스트는 실행하지 않습니다. 패킷 손실은 항상 `null`이며 **0%가 아닙니다**. 빠른 일정에서는 250 ms 지속 시간 필터를 만족하지 못해 부하 중 지표가 `null`일 수 있습니다.

사업자는 조직명·AS 설명을 표시하고 등록된 AS 이름·식별자를 대체값으로 사용하며, **검증된 소매 ISP의 신원이 아닙니다**. JSON `network.providerSource`에 출처를 기록하며 레지스트리 결과에는 실제 레지스트리 URL을 사용합니다. 위치는 대략적인 IP 기반 추정이지 GPS가 아닙니다.

## 네트워크와 개인정보

CLI는 `https://speed.cloudflare.com`의 `GET /meta`(선택적이며 실패해도 계속 진행), `GET /__down`, `POST /__up`을 사용합니다. 메타데이터가 없으면 허용된 다운로드 응답 헤더에서 ASN·도시·국가·colo를 얻을 수 있습니다. `__results`, 별도 텔레메트리 또는 결과 보고를 제출하지 않습니다. 다만 Cloudflare는 일반 요청, 출발지 IP, 요청 메타데이터를 받습니다.

사업자가 없고 유효한 ASN을 아는 경우 실행당 한 번의 제한된 조회로 [IANA ASN 부트스트랩](https://data.iana.org/rdap/asn.json), 공식 RIR RDAP 서비스, 명시적인 KRNIC 위임을 포함한 허용 목록의 위임 서버 최대 두 곳을 사용합니다. GET 총 4회, 전체 5초, 응답당 128 KiB로 제한하며 본문은 예산에 포함합니다. 공개 ASN만 조회하고 IP·도시·좌표를 질의로 보내지 않습니다. 하지만 접속하는 모든 서비스는 연결의 출발지 IP를 볼 수 있으며 각자의 정책에 따라 요청을 기록할 수 있습니다.

CLI는 IP 주소·좌표·개인 RDAP 연락처·전체 레지스트리 응답을 영구 저장하지 않습니다. 익명성이나 서비스 측 로그 삭제를 약속하는 것은 아닙니다. 외부 레지스트리 접근은 `--no-provider-lookup`으로 끌 수 있습니다. 서비스 약관과 조회 상세 사항은 [전체 안내](DISCLAIMER.ko.md)를 확인하세요.

## 문제 해결

- **명령을 찾을 수 없음:** Node.js 22 이상, npm 전역 실행 파일 경로, 설치 상태를 확인하세요. 위의 체크아웃 안내에 따라 소스에서 설치할 수도 있습니다.
- **HTTP 403 / 대형 요청 실패:** `--full` 대신 기본 또는 `--quick` 일정을 사용하세요. 거부를 우회하지 마세요. 대형 요청의 가용성은 네트워크마다 다르며 검증된 고정 서버 상한이 아닙니다.
- **사업자·위치 누락:** 메타데이터나 레지스트리에 접근할 수 없을 수 있으며 치명적 오류가 아닙니다. `--verbose` 또는 `--json`으로 진단을 확인하세요.
- **시간·본문 예산 초과:** 정상 완료로 표시하지 않고 실패합니다. 제한을 높이기 전에 네트워크 상태와 데이터 요금을 확인하세요.

## 라이선스와 기여

MIT: [LICENSE](LICENSE). [NOTICE](NOTICE), [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)의 원본 출처와 라이선스 전문을 보존하세요.

라이선스는 소프트웨어에 적용되며 **서비스 접근 권한이나 상표 권리를 부여하지 않습니다**. 허가받은 네트워크를 사용하고 적용되는 약관·법률·요청 제한을 지키며 과도한 반복이나 거부 우회를 피하세요. 서비스와 측정은 최선 노력 방식이며 정확성·가용성을 보장하지 않습니다. MIT의 보증·책임 배제는 적용 법률이 허용하는 범위에서 적용됩니다. [DISCLAIMER.ko.md](DISCLAIMER.ko.md)를 확인하세요.

기여 안내: [CONTRIBUTING.md](https://github.com/ejeonghun/cfspeedtest/blob/main/CONTRIBUTING.md). Node.js 22 이상에서 `npm ci`, `npm test`, `npm run check`를 사용합니다. 기본 테스트는 오프라인이며, 실제 테스트는 트래픽을 발생시키므로 반복 실행이나 일반 CI에서 실행하지 마세요.
