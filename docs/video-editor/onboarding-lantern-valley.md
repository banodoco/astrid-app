# Lantern Valley onboarding example

The editor tour replays the completed Lantern Valley project without creating a runtime project or running a model. Its timeline starts empty and adds the 14-second Three.js motion-guide video, four Qwen reference frames, then the H3 result. The tour does not load the 3D world: step 1 is an ordinary muted media clip of the guide render. The public homepage Light Study is a separate example.


A fresh **Try Astrid** visit opens the existing “Welcome to Astrid” tour before any Runtime connection or workspace discovery. The browser-only host uses the shared editor provider, in-memory timeline operations, public service hooks and no extensions (nothing in the tour renders a live scene). Live workspace services, persistence and export are disabled. The pictures the tour shows next are fetched and decoded one per idle moment, so they never land on a card move or a chat frame: the guide's first frame from the start, the four stills once step 1 has landed, the H3 clip's first frame from step 2. The tour's one `<video>` element buffers the guide clip from the start and the H3 clip once the stills are on screen. These are the small playback derivatives (about 3 MB for the whole tour on a phone, against 17 MB of originals), and none of it is required: a landing never waits for a download.

Done, Skip and Escape all end the tour the same way and persist the next phase before unmounting it. Where that leads depends on the device. **On a computer (hosted build)** it is “How do you want to run Astrid?” (`choose`): use the hosted version (Continue, or Install and continue) or run Astrid on your computer (Set up with your agent). Hosted goes straight to the connection screen (`connection`), whose cards explain that Runtime runs on your machine and carry the permission, install and copy-instructions help. Local goes to “Have your agent set it up” (`local`), whose Continue also leads to connection. **On a phone or tablet** (`detectInstallScenario()` is `mobile`: iPhone/iPad, Android, an iPad or Android asking for the desktop site, or a phone-sized touch-only device) there is no choice and nothing to set up: Done and Skip go straight to the connection screen's phone card, “Open Astrid on your computer”, with “Send the link to your computer”. **On a local build** there is no choice either: the tour leads to local setup, then connection. Every screen is an editor card; Back always returns to the screen the person came from (the tour's last card from the choice, from a phone's card and from a local build's local setup). Only after connection does the starter handoff discover the workspace, reuse an existing project, or create a real “My first project” with its canonical timeline. It opens that saved selection without another automatic tour. Failed setup offers Try again and Open editor; no temporary browser ID is presented as a saved project. Settings keeps explicit tour replay and appearance preferences.

Browser progress lives in `astrid:welcome-v1` (`tour`, `choose`, `local`, `connection`, `complete`); a stored `setup` from the retired setup page migrates on read to `local` (local build or local run mode) or `connection`, and a phone with a stale `choose`/`local` resumes at `connection`. Reload during the tour restarts the demo; reload on any later screen stays on it. Starting the demo does not mark it completed or write a Runtime tour record. Existing connected/setup/tour/last-project flags bypass new welcome. A project/timeline/`entry=editor` link opens the editor directly and marks welcome complete: its Runtime gate connects (on a phone it shows the phone card) and the destination is kept. Installer `?connect=1` resumes connection (local setup on a local build or when local was chosen). Starter creation uses the durable pending intent in `astrid:onboarding:pending-project-v1`, stable Runtime idempotency keys and discovery on retry, so an unknown response or partial timeline creation can recover without another project. The obsolete brightness/text-case setup wizard, the bare “Set up Astrid” page and the editor auto-start trigger are retired.

The portable release is `public/astrid/onboarding/lantern-valley-14s-v1/`. Every file is immutable and named by its SHA-256. The eleven originals are the self-contained prepared world, four source captures, four Qwen PNGs, the motion-guide MP4, and the native H3 MP4; the demo timeline's asset registry names these. Sixteen playback derivatives sit beside them, each recorded with `derivedFrom`: what the tour actually shows and plays.

| derivative | from | what | size |
|---|---|---|---|
| `guide540` / `guide720` | guide (3.9 MB) | H.264 Main 960×540 / 1280×720, 30 fps, no audio, index first | 0.67 / 1.48 MB |
| `video540` / `video768` | H3 video (3.6 MB) | H.264 Main 960×548 / 1344×768, 24 fps, cut to 14 s, no audio, index first | 1.10 / 2.42 MB |
| `videoPoster`, `frame1Display`, `still1-4Display` | first H3 frame, first capture, stills | WebP at source size (posters, the stills in the preview, card visuals, gallery tiles) | 16-171 KB (PNGs: 0.9-2.0 MB) |
| `videoThumb`, `frame1Thumb`, `still1-4Thumb` | same | 320 px WebP (timeline clip thumbnails) | 1-4 KB |

`node scripts/onboarding/build-derivatives.mjs` builds any missing derivative with ffmpeg and records it in both manifests (`--check` verifies the recorded ones); it never touches an original. Phones (and browsers asking to save data) play the 540p renditions, larger screens the source-size ones. `manifest.json` records sizes, digests and media dimensions. The source manifest at `src/tools/video-editor/tour/asset-manifest.json` must match it. The ordinary app build copies these public files into `dist`; deployment uses the app's existing same-origin static hosting. No external bucket, workspace media endpoint, signed URL, provider credential or local filesystem path is required.

The world file is kept in the release but the tour no longer loads it. The guide is exactly 14 seconds at 1280×720, 30 fps. The Qwen frames are 1376×768 and were generated through WaveSpeed. Their capture times are 0, 6.5, 10 and 419/30 (13.9667) seconds; their one-second timeline placements start at 0, 6.5, 10 and 13. The fourth image is the corrected natural-town version, with digest `e2f106ce2e53434487e24da748ddac7eb28aee43afe2b6f768efbd901622d31f`. H3's native 1344×768, 24 fps output lasts 14.375 seconds; the tour trims it to 14 seconds and mutes it. Card previews stop at 14 seconds and hold their final frame.

**The picture is the tour's own, not the editor player's.** While the tour runs, the editor's preview player renders the composition's ground and no clips (`RemotionPreview`), so it fetches and decodes nothing; the timeline rows, clips and thumbnails are the real editor's. Over the preview surface `EditorTourTimelineDriver` layers a plain muted, inline `<video>` (one element for the whole run, `tour/timeline/tourPicture.ts`) and plain `<img>`s, and the playhead and timecode follow that picture through the preview's own time report. The earlier design played the clips through the editor's WebCodecs pipeline and waited, with no timeout, for it to report a decoded frame; on a browser without `AudioDecoder` (the files had an AAC track) or `VideoDecoder` that report never came and the poster stayed forever, and where the player's `AudioContext` could not resume outside a user gesture the picture froze on its first frame. The demo no longer depends on any of that:

- Steps 1 and 3: the clip's first frame shows at once as a poster; the video plays from 0 and the step reports ready at the first presented frame of the playing video, or when `play()` is refused, or after 2.5 seconds. Then the poster stays, and gives way if the video starts late. The tour never stalls on media.
- The element is muted, `playsinline`, has no `autoplay` attribute and plays files with no audio track. Every tap and key press of the tour primes it inside the user gesture (play, then pause at the start), so a browser that refuses muted autoplay still accepts the later start, and a refused start is retried on the next press.
- Step 2 walks its four stills for 1.2 seconds each and holds the town frame; leaving or skipping cancels the walk.
- The video keeps playing under the cards that follow (to its end, then holds its last frame), except behind a phone's full-screen chat. Back never restarts it. With reduced motion nothing plays and no video is fetched: the poster is the whole presentation.

Tour changes remain in memory and are discarded when the tour ends.

Verify the source assets and production output:

```sh
node scripts/onboarding/verify-assets.mjs public
node scripts/onboarding/build-derivatives.mjs --check
npm run build:hosted
node scripts/onboarding/verify-assets.mjs dist
npx vitest run --config config/testing/vitest.config.ts src/tools/video-editor/tour src/app src/tools/video-editor/pages
```

After publishing the app, verify anonymous downloads against the deployment:

```sh
node scripts/onboarding/verify-assets.mjs https://astrid.haus/
```

Keep these hashed files immutable. Publish a new version directory and update both manifests when replacing the example. The verifier confirms every distributed byte, source/distributed manifest agreement, and the absence of machine-specific paths or remote script dependencies in the portable world. Tests also cover staged timeline construction, that the released world file still imports through the authoring contract into empty storage, and that the tour mounts no scene iframe and requests no world.
