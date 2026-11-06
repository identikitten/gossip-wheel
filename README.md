# Spin the Gossip Wheel — deployment build

Install dependencies with `npm install` and start with `npm start`. Open `/` on the kiosk and `/controller.html` on visitors’ phones. Both must reach the same server over the network.

To test each of the 12 wedges sequentially, run `SEQUENTIAL_TEST=1 npm start` instead. Do not set SEQUENTIAL_TEST for the exhibition.

The 12 visual wedges include two Random Gossip wedges, each weighted 8.5% (17% total). Jackpot remains 0.1%; refund remains 1%. All probabilities total 100%.

Murmurs and Whispers is visual only: 15px falling b/s/h characters start 650ms after the wheel finishes and fade out. The controller attempts a vibration pattern on Jackpot when the browser supports `navigator.vibrate`. This typically works on Android, not iOS; it may also be restricted by browser settings and user gesture policies. The kiosk has no visitor-facing diagnostics.

Important before a public deployment: configure HTTPS for visitor access, a persistent writable storage location for submissions.jsonl, answers.jsonl and prize-state.json, and a stable kiosk connection. Server restarts reset the in-memory queue and active visitor sessions. Gossip submissions require moderation before being publicly included. The current build does not include a moderation dashboard or production-grade abuse protection; review those operational requirements before public exposure.


## Spinning wheel sound

The exhibition Mac plays `public/spin-tick.mp3` at each 30-degree wedge boundary, using the wheel's rendered rotation (including deceleration). Open the kiosk page and click **Enable sound** once after every page reload. Browsers require this interaction before playing audio. The button disappears when audio is enabled. Sound is local to the kiosk, not the phones.

To replace the click, replace `public/spin-tick.mp3` with a short MP3. The source file was supplied by the artist; verify permission to play it publicly.


### Exhibition audio and jackpot reveal

On the exhibition Mac, click **Enable sound** once after loading the wheel.
`public/spin-tick.mp3` plays in short ticks as the wheel turns; `public/jackpot-win.wav` plays once after a Jackpot stops. The sound plays on the Mac, not visitor phones. The Jackpot phone background fades to soft red and its result panel pulses briefly; supported Android phones also vibrate. iPhone Safari does not support web vibration.

To test the Jackpot locally, run `SEQUENTIAL_TEST=1 npm start` and advance through the sequence. Do not enable sequential testing in production.
