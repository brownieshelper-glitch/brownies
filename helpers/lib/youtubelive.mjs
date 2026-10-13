// The channel's live broadcast on YouTube, through the Data API v3 and the project's client (lib/youtube.mjs):
// is one on air, and starting one on the video the encoder is already sending. On 2026-10-13 the connection to
// YouTube broke for a moment, YouTube ended the broadcast and never began another, although the kitchen cam was
// sending again twelve minutes later: on YouTube a new broadcast is only made when somebody opens the Studio.
// So the watcher (helpers/ember.mjs) asks here whether the channel is on air, and makes the broadcast itself
// when it is not: public, with the title of the last one, started by itself (auto-start) and NOT ended by a
// short break (auto-stop off), which is what a stream that runs all day needs.
// The stream key is never read: of the encoder's stream only its id, name and state are asked for.
const API = "https://www.googleapis.com/youtube/v3";

/// What each call costs of the 10,000 units a day the project has.
export const YT_LIVE_COST = { look: 1, insert: 50, bind: 50, transition: 50, keepOpen: 51 };
export const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

const shape = (b) => b ? {
  id: b.id, title: b.snippet?.title || "", description: b.snippet?.description || "", chatId: b.snippet?.liveChatId || null,
  life: b.status?.lifeCycleStatus || "", privacy: b.status?.privacyStatus || "",
  streamId: b.contentDetails?.boundStreamId || null, monitor: Boolean(b.contentDetails?.monitorStream?.enableMonitorStream),
  autoStart: Boolean(b.contentDetails?.enableAutoStart), autoStop: Boolean(b.contentDetails?.enableAutoStop),
  startedAt: b.snippet?.actualStartTime || null, endedAt: b.snippet?.actualEndTime || null, url: watchUrl(b.id),
} : null;
const list = async (youtube, query) => ((await youtube.api("GET", `${API}/liveBroadcasts?part=snippet,status,contentDetails&broadcastType=all&${query}`)).json?.items || []).map(shape);

/// The broadcast that is on air now, or null. One unit.
export async function onAir(youtube) { return (await list(youtube, "broadcastStatus=active&maxResults=5"))[0] || null; }
/// The broadcasts that wait to start (made in the Studio, or by an earlier try here).
export async function waiting(youtube) { return list(youtube, "broadcastStatus=upcoming&maxResults=10"); }
/// The broadcast that ended last, for its title and words.
export async function lastEnded(youtube) {
  const all = await list(youtube, "broadcastStatus=completed&maxResults=10");
  return all.sort((a, b) => String(b.endedAt || b.startedAt || "").localeCompare(String(a.endedAt || a.startedAt || "")))[0] || null;
}
/// One broadcast by its id.
export async function broadcast(youtube, id) { return (await list(youtube, `id=${encodeURIComponent(id)}`))[0] || null; }

/// The encoder's stream YouTube is receiving video on: { id, title, health } or null when nothing arrives.
export async function arriving(youtube) {
  const { json } = await youtube.api("GET", `${API}/liveStreams?part=id,snippet,status&mine=true&maxResults=50`);
  const s = (json?.items || []).find((x) => x?.status?.streamStatus === "active");
  return s ? { id: s.id, title: s.snippet?.title || "", health: s.status?.healthStatus?.status || "" } : null;
}

/// A broadcast started from the Studio's own page ends at the first short break (auto-stop). This switches that
/// off on a broadcast, also one that is on air (YouTube took it on 2026-10-13): its own settings are sent back
/// with that one changed, because what is left out goes back to YouTube's default. Returns true when it is off.
export async function keepOpen(youtube, id) {
  const { json } = await youtube.api("GET", `${API}/liveBroadcasts?part=id,contentDetails&id=${encodeURIComponent(id)}`);
  const now = json?.items?.[0]?.contentDetails;
  if (!now) return false;
  if (now.enableAutoStop === false) return true;
  const { boundStreamId, boundStreamLastUpdateTimeMs, ...keep } = now; // the two YouTube writes itself
  if (keep.monitorStream) { const { embedHtml, ...monitor } = keep.monitorStream; keep.monitorStream = monitor; }
  const r = await youtube.api("PUT", `${API}/liveBroadcasts?part=id,contentDetails`, { body: { id, contentDetails: { ...keep, enableAutoStop: false } } });
  return r.json?.contentDetails?.enableAutoStop === false;
}

/// What a broadcast that runs all day is made with.
export function broadcastBody({ title, description = "", privacy = "public", now = Date.now() } = {}) {
  return {
    snippet: { title: String(title || "Live").slice(0, 100), description: String(description || "").slice(0, 5000), scheduledStartTime: new Date(now).toISOString() },
    status: { privacyStatus: ["public", "unlisted", "private"].includes(privacy) ? privacy : "public", selfDeclaredMadeForKids: false },
    contentDetails: { enableAutoStart: true, enableAutoStop: false, enableDvr: true, latencyPreference: "low", monitorStream: { enableMonitorStream: false, broadcastStreamDelayMs: 0 } },
  };
}

const move = (youtube, id, to) => youtube.api("POST", `${API}/liveBroadcasts/transition?part=id,status&broadcastStatus=${to}&id=${encodeURIComponent(id)}`);

/// Puts the channel on air with the video that is arriving. A broadcast that already waits on that stream is
/// used (never a second one beside it); otherwise one is made like the last and tied to the stream. It then
/// starts by itself, and is started from here when it has not after a few looks.
/// Returns { ok, id, url, title, made, life } or { ok: false, why: "no-signal" | "not-live", ... }.
export async function goLive(youtube, { title = "", description = "", fallbackTitle = "Live", privacy = "public", now = Date.now(), wait = (ms) => new Promise((r) => setTimeout(r, ms)), looks = 8, everyMs = 10_000, log = () => {} } = {}) {
  const stream = await arriving(youtube);
  if (!stream) return { ok: false, why: "no-signal" };
  let b = (await waiting(youtube)).find((x) => x.streamId === stream.id) || null;
  let made = false;
  if (!b) {
    let like = null;
    if (!title) { try { like = await lastEnded(youtube); } catch (e) { log(`[youtube] the last broadcast could not be read: ${e.message}`); } }
    const body = broadcastBody({ title: title || like?.title || fallbackTitle, description: description || like?.description || "", privacy: like?.privacy || privacy, now });
    const r = await youtube.api("POST", `${API}/liveBroadcasts?part=snippet,status,contentDetails`, { body });
    if (!r.json?.id) throw Object.assign(new Error("YouTube made no broadcast"), { status: 502 });
    await youtube.api("POST", `${API}/liveBroadcasts/bind?part=id,contentDetails&id=${encodeURIComponent(r.json.id)}&streamId=${encodeURIComponent(stream.id)}`);
    b = { ...shape(r.json), streamId: stream.id };
    made = true;
    log(`[youtube] a broadcast was made and tied to the stream: ${b.url}`);
  }
  let life = b.life, pushed = "", trouble = "";
  for (let i = 0; i < looks; i++) {
    await wait(everyMs);
    const s = await broadcast(youtube, b.id);
    if (!s) { trouble = "the broadcast is gone"; break; }
    life = s.life;
    if (life === "live") return { ok: true, id: b.id, url: b.url, title: s.title || b.title, made, life };
    // auto-start is given one look; then the step is taken from here (a monitored broadcast goes through "testing")
    const next = life === "testing" ? "live" : life === "ready" && i >= 1 ? (s.monitor ? "testing" : "live") : "";
    if (next && pushed !== `${life}>${next}`) {
      pushed = `${life}>${next}`;
      try { await move(youtube, b.id, next); } catch (e) { if (!/redundantTransition/i.test(`${e.reason} ${e.message}`)) { trouble = e.message; log(`[youtube] ${b.id} to ${next}: ${e.message}`); } }
    }
  }
  return { ok: false, why: "not-live", id: b.id, url: b.url, title: b.title, made, life, trouble };
}
