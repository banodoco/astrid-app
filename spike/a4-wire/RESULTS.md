# Local diagnostic results

Base `e72d541de1d65bee74707ca1ae9c2d429ee2f721`; CPU only; exclusive host lease granted and released. Synthetic loopback fixture only; no product traffic. `node spike/a4-wire/probe.cjs` initially failed before launch because the default Playwright browser cache lacked `chromium_headless_shell-1223`; no test results resulted. The successful invocation used `PLAYWRIGHT_BROWSERS_PATH=/workspace/r12-a4-fix.env/browsers node spike/a4-wire/probe.cjs`. Playwright 1.60 uses local Chromium revision 1223. A second run set `A4_SAME_SITE=1` and a third used the same setting with an insecure Lax cookie. Both produced identical stdout to the hosted-style run below. These same-site variants differ from the real hosted/loopback site relationship.

```json
{
  "rawPostBody": true,
  "browserAddedOrigin": true,
  "httpOnlyCookie": false,
  "pagehideSeen": true,
  "pagehideSentinel": true,
  "deliveredPrefix": true,
  "relaySawSuffix": false,
  "holdComplete": false,
  "holdBrowserTerminal": ["request", "failed"],
  "relayClosed": true,
  "serverNeverSeen": true,
  "neverObserved": ["request", "failed"],
  "syntheticSeenByBrowser": true,
  "syntheticSeenByTap": false,
  "redirectHopSeen": true,
  "partialFailClosed": true
}
```

The page received the prefix before navigation. The browser reported failure, the client side closed, and the relay did not receive the held suffix attempted by the origin afterward. This is not evidence that a transmitted suffix was not delivered to the page: the origin's `end()` after cancellation is only an attempted write, not proof the server successfully sent or the relay received those bytes. A sent-but-not-page-received sentinel remains unproved. The pagehide sentinel was a custom request header, with a separate body sentinel; the boolean asserts the former only. The relay captured the full single request's raw header block and body as received; browser-added Origin and body sentinel appeared. The HttpOnly cookie did not appear in these attempts; full browser-added/HttpOnly visibility remains unproved. The fixture did not independently establish why the browser omitted it.

The route-fulfilled response reached the browser without any tap record. The aborted pre-dispatch request produced browser request/failed events without reaching the server. The fixture redirect crossed two relay requests, but no general correlation with browser events is implemented or proven; cross-origin/redirect bypass remains a coverage hazard. The deliberately destroyed partial response failed the conservative framing parser, as did the held stream. Browser cancellation occurred during navigation; other cancel/close interleavings and actual Runtime behavior remain unproved. There is no proof of completeness for arbitrary HTTP framing, TLS, WebSockets, concurrent requests, cached/service-worker responses or all API destinations. The prototype's own framing restrictions reject such ambiguity rather than passing it.

**Decision:** no equivalence or strengthening demonstrated. A TCP relay can supplement the scan for bytes it actually observes; it does not by itself replace browser capture, genuine terminal events, full headers/body, DOM/storage/cookies/outbox checks, or establish what the page received. Preserve the current release check and fail closed. Real journey qualification, a full correlation design, HttpOnly coverage, and a server-sent-but-page-not-received counterexample remain outstanding. No owner decision or release-check change is implied.
