# Original C3/C4 trace observations

Read-only extraction from the two original run 44557257081 Playwright traces, recorded by Playwright 1.60.0 (trace format 8). Source meaning is bound to editor commit `67428177b24989e230537ffe363aaa45b60bbd63`.

## C3 decoder marker samples

`data-preview-decoded-frame`, `data-preview-media-src`, and `data-preview-presented-frame` are literal DOM attributes on the hidden media span. Immutable `ReadinessVideo.tsx` sets the readiness flag and presented timeline frame in `onVideoFrame`. The separate `data-astrid-preview-frame-ready` attribute is set after observing a decoded marker and a requestAnimationFrame callback; it is an aggregate preview-readiness flag, not a frame counter or save-owner readiness.

| Snapshot UTC | Native trace timestamp | Snapshot | Decoded marker | Presented frame | Literal slider in same snapshot |
|---|---:|---|---|---:|---|
| 2026-11-19T16:03:24.172Z | 31319.316 | `before@call@23` | false | not present | not materialized |
| 2026-11-19T16:03:24.385Z | 31521.53 | `before@call@25` | true | 0 | not materialized |
| 2026-11-19T16:03:26.257Z | 33393.465 | `before@call@39` | true | 1 | 1 |
| 2026-11-19T16:03:26.452Z | 33589.327 | `after@call@39` | true | 4 | 4 |
| 2026-11-19T16:03:26.750Z | 33886.133 | `before@call@41` | true | 15 | 17 |
| 2026-11-19T16:03:26.799Z | 33941.184 | `after@call@41` | true | 20 | 20 |
| 2026-11-19T16:03:27.331Z | 34493.305 | `input@call@45` | true | 35 | 35 |
| 2026-11-19T16:03:27.549Z | 34684.853 | `after@call@45` | true | 38 | 38 |

The sampled presented frames are **0, 1, 4, 15, 20, 35, 38**. These are repeated decoder-marker observations at distinct timeline positions, not a complete per-video-frame log or a pixel-motion measurement. The actual slider `getAttribute` calls returned **0, 0, 1, 17, 20**; a later snapshot can already show a different value from the earlier attribute read. The native proof result records slider 0→20.

## C4 original actions and field observations

| Call | Method / argument | Native monotonic start → end | Recorded call error |
|---|---|---|---|
| `call@23` | `fill` P61 copied-realm edit | 31681.304 → 32090.897 | none |
| `call@25` | `press` Enter | 32113.798 → 32375.099 | none |
| `call@27` | `blur`  | 32381.131 → 32424.303 | none |

All three actions target `internal:role=textbox[name="Track name"i] >> nth=0`. Each has a recorded after event without a call error.

| Snapshot UTC | Snapshot | Input property marker | HTML value attribute | Target call |
|---|---|---|---|---|
| 2026-11-19T16:04:34.952Z | `after@call@17` | `V1` | `V1` | `call@17` |
| 2026-11-19T16:04:35.610Z | `input@call@23` | `V1` | `V1` | `call@23` |
| 2026-11-19T16:04:36.022Z | `input@call@25` | `V1` | `V1` | `call@25` |
| 2026-11-19T16:04:36.163Z | `after@call@27` | `V1` | `V1` | `call@27` |
| 2026-11-19T16:05:36.068Z | `after@call@273` | `V1` | `V1` | `call@27` |

The fill input-stage snapshot, Enter input-stage snapshot, and after-blur snapshot each materialize **V1** for both `__playwright_value_` and `value`. The after-fill fragment does not materialize a Track name input; this extraction does not resolve compressed references or infer its value. A transient value between sampled snapshots is unknown. No event/capture/save-owner cause is assigned.

C4 has a decoded marker `false` at **2026-11-19T16:04:35.456Z**, then `true` / presented frame **0** and aggregate preview-ready `true` at **2026-11-19T16:04:35.846Z**. This is preview decoder evidence, not save-owner readiness.

## Request inventory

| Trace | Requests | GET | POST | PUT | Non-inspect timeline write candidates |
|---|---:|---:|---:|---:|---:|
| C3 | 2142 | 2129 | 12 | 1 | 0 |
| C4 | 2405 | 2356 | 48 | 1 | 0 |

C4 non-GET routes: Runtime handshake POST **25**; Astrid handshake POST **1**; project-selection PUT **1**; timeline `/inspect` POST **21**, all with body `{"limit":1}`; local-update-status POST **1**. There is **no timeline PUT/PATCH/DELETE or non-inspect timeline POST** in the recorded inventory. All **62** C4 APIRequestContext fetch calls are GET. The JSON retains every non-GET request with its original timestamp/path/status/body hash and all timeline requests; inspect calls are not silently dropped.

## Provenance and limits

The JSON includes both original ZIP hashes, inner trace/network hashes, exact source blob/SHA256 receipts, all literal relevant nodes with JSON paths and timestamps, each action’s input/log/after records, and complete selected network inventories. Snapshot UTC times are observation times; no exact decoder-callback/event timestamp is invented. This extraction does not reconstruct compressed unchanged DOM fragments or infer readiness/capture/commit events that were not recorded.

- C3 `play-1795104173942-trace.zip` SHA256 `9a62a73e38394d092c142f16dc243d4de21a7b65cb6fb51045fbf76921893267`.
- C4 `edit-1795104244447-trace.zip` SHA256 `8aa082fb490e651db8b2c84a45491783a0e7c3441343e98efe45652549cf61d8`.
- `src/tools/video-editor/compositions/ReadinessVideo.tsx` at `67428177b24989e230537ffe363aaa45b60bbd63`: Git blob `640d54211e54dc75087e2d95ab227f15d43bf5b0`, SHA256 `81b2318713bea64d9f1315fd24180312384f3c14db753d02c3025efc2475c0c3`.
- `src/tools/video-editor/components/PreviewPanel/RemotionPreview.tsx` at `67428177b24989e230537ffe363aaa45b60bbd63`: Git blob `a3da8a914bdac8fbf7f39afb3af323827fa8d5dd`, SHA256 `767412c9e8723a655a91ed31ff8a563fe78c0665e37390c7751d45a983a6e727`.
