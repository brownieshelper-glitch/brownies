// A YouTube that has live broadcasts and one encoder stream, for the tests of lib/youtubelive.mjs and of the
// watcher: what is asked is recorded, a broadcast that is made waits ("ready") and goes on air by itself after
// `startsAfter` looks at it (Infinity: never, it has to be pushed), a push moves it one step.
export function fakeYouTubeLive({ signal = true, live = null, waiting = [], ended = [], startsAfter = 1 } = {}) {
  const yt = {
    configured: true, calls: [], made: [], bound: [], moved: [], looks: {}, n: 0,
    streams: [{ id: "stream-idle", snippet: { title: "old key" }, status: { streamStatus: "inactive" } }, { id: "stream-1", snippet: { title: "Default stream key" }, status: { streamStatus: signal ? "active" : "inactive", healthStatus: { status: "good" } } }],
    all: [...(live ? [{ ...live, status: { lifeCycleStatus: "live", privacyStatus: "public", ...live.status } }] : []), ...waiting, ...ended],
    startsAfter,
    api: async (method, url, { body = null } = {}) => {
      const u = new URL(url), path = u.pathname.split("/v3/")[1], q = u.searchParams;
      yt.calls.push([method, path, u.search]);
      if (method === "GET" && path === "liveStreams") return { json: { items: yt.streams } };
      if (method === "GET" && path === "liveBroadcasts") {
        if (q.get("id")) {
          const b = yt.all.find((x) => x.id === q.get("id"));
          if (b) { yt.looks[b.id] = (yt.looks[b.id] || 0) + 1; if (b.status.lifeCycleStatus === "ready" && b.contentDetails?.enableAutoStart && yt.looks[b.id] >= yt.startsAfter) b.status.lifeCycleStatus = "live"; }
          return { json: { items: b ? [b] : [] } };
        }
        const want = { active: ["live"], upcoming: ["created", "ready", "testing"], completed: ["complete"] }[q.get("broadcastStatus")] || [];
        return { json: { items: yt.all.filter((x) => want.includes(x.status.lifeCycleStatus)) } };
      }
      if (method === "PUT" && path === "liveBroadcasts") {
        const b = yt.all.find((x) => x.id === body.id);
        yt.updated = [...(yt.updated || []), body];
        b.contentDetails = { ...body.contentDetails, boundStreamId: b.contentDetails?.boundStreamId }; // what is left out is lost, as on YouTube
        return { json: b };
      }
      if (method === "POST" && path === "liveBroadcasts") {
        const b = { id: `made-${++yt.n}`, snippet: { ...body.snippet, liveChatId: `chat-${yt.n}` }, status: { ...body.status, lifeCycleStatus: "created" }, contentDetails: { ...body.contentDetails } };
        yt.all.push(b); yt.made.push(body);
        return { json: b };
      }
      if (method === "POST" && path === "liveBroadcasts/bind") {
        const b = yt.all.find((x) => x.id === q.get("id"));
        b.contentDetails.boundStreamId = q.get("streamId"); b.status.lifeCycleStatus = "ready"; yt.bound.push([b.id, q.get("streamId")]);
        return { json: b };
      }
      if (method === "POST" && path === "liveBroadcasts/transition") {
        const b = yt.all.find((x) => x.id === q.get("id")), to = q.get("broadcastStatus");
        yt.moved.push([b.id, to]);
        if (to === "live" && b.contentDetails?.monitorStream?.enableMonitorStream && b.status.lifeCycleStatus !== "testing") throw Object.assign(new Error("YouTube answered 403 invalidTransition"), { status: 403, reason: "invalidTransition" });
        b.status.lifeCycleStatus = to;
        return { json: b };
      }
      throw new Error(`no fake for ${method} ${path}`);
    },
  };
  return yt;
}
export const ended = (id, title, endedAt, extra = {}) => ({ id, snippet: { title, description: `${title}, the words`, actualStartTime: "2026-10-13T00:05:32Z", actualEndTime: endedAt, liveChatId: null }, status: { lifeCycleStatus: "complete", privacyStatus: "public" }, contentDetails: { boundStreamId: "stream-1" }, ...extra });
