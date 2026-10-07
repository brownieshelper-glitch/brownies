/* Shared by the Bakery pages (bakery.html, bake.html): the Bakery API behind the gateway's domain (/bake/*), a
   face of its own for every baked brownie, drawn from its name, times in plain words, and sample answers for
   ?demo=1 or ?demo=form on a local machine. Exposes window.Baked. */
(() => {
  const B = window.Brownies;
  const M = window.Mascot;
  const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

  // ---- a look for every baked brownie: size, drips, bite, mouth, gaze and cheeks follow from the name, and
  // it carries no tool, since the tools belong to the team ----
  const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };
  const pick = (h, n, arr) => arr[(h >>> (n * 4)) % arr.length];
  function look(name) {
    const h = hash(String(name).toLowerCase());
    return {
      id: name, name: cap(name),
      w: pick(h, 0, [164, 176, 188, 200, 212]), h: pick(h, 1, [156, 168, 182, 196, 210]),
      drips: pick(h, 2, [[18, 36, 20], [26, 14, 44], [16, 30, 20, 34], [22, 44, 26, 14], [30, 18, 36, 12, 28]]),
      bite: pick(h, 3, ["tr", "tl", null, "tr"]), mouth: pick(h, 4, ["smile", "grin", "o", "open"]),
      look: [pick(h, 5, [-6, -3, 0, 4, 6]), pick(h, 6, [-2, 0, 2, 4])], blush: (h >>> 28) % 2 === 0, prop: null,
    };
  }
  const face = (name) => (M ? M.face(look(name)) : "");

  // ---- words for times and hours ----
  const hourLabel = (h) => `${h}:00`;
  const zoneName = (tz) => (tz || "UTC").split("/").pop().replace(/_/g, " ");
  const when = (iso) => (iso ? B.ago(new Date(iso).getTime()) : "");
  const jobLine = (t) => `${t.title}${t.hours && t.hours.length ? `, at ${t.hours.map(hourLabel).join(" and ")}` : ""}`;

  // ---- the API ----
  const demoKind = B.local ? new URLSearchParams(location.search).get("demo") : null;
  const demo = demoKind ? demoApi(demoKind) : null;
  async function api(S, path, { method = "GET", body = null, token = null } = {}) {
    if (demo) return demo(path, { method, body, token });
    if (!S.gateway) return { ok: false, status: 0, body: null };
    const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
    try {
      const r = await fetch(S.gateway + "/bake" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      let j = null; try { j = await r.json(); } catch (_) {}
      return { ok: r.ok, status: r.status, body: j };
    } catch (_) { return { ok: false, status: 0, body: null }; }
  }

  // ---- sample answers, for a look at the pages with no server behind them ----
  function demoApi(kind) {
    const t0 = Date.now(), H = 3600e3;
    const holder = "0x8e45bA3c0dFc0F9A6B2d2b4E5C1a7F0b9D3e2C11";
    const other = "0x2c769cDE285eb0d3c7130F9F0f14932106384095";
    const menu = [
      { id: "watch", title: "Daily watch", tool: "feed", hours: [9], text: "Look at the live figures you are given about the coin, the gateway and the brownies, and write a short plain update for your holder." },
      { id: "digest", title: "Evening digest", tool: "draft", hours: [20], text: "Write a short digest of what the brownies did today and what people asked, for a holder who checks in once a day." },
      { id: "posts", title: "Post ideas", tool: "draft", hours: [11], text: "Draft three short posts about Brownies for X, in the project's voice, from the facts only. Your holder posts them." },
      { id: "faq", title: "Questions people ask", tool: "feed", hours: [17], text: "Pick the three questions people asked most this week about Brownies and answer each in two or three plain sentences." },
      { id: "note", title: "Weekly note", tool: "feed", hours: [8], text: "Read the latest research note and the facts, and write what a holder should know this week, in a few lines." },
    ];
    const models = [
      { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", provider: "Anthropic", in: 1, out: 5 }, { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", provider: "Anthropic", in: 2, out: 10 }, { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", provider: "Anthropic", in: 4, out: 20 },
      { id: "openai/gpt-5.5", name: "GPT-5.5", provider: "OpenAI", in: 5, out: 30 }, { id: "openai/gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "OpenAI", in: 0.75, out: 4.5 },
      { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "Google", in: 0.75, out: 3.75 }, { id: "x-ai/grok-4.7", name: "Grok 4.7", provider: "xAI", in: 2, out: 6 }, { id: "deepseek/deepseek-v3.2", name: "DeepSeek V3.2", provider: "DeepSeek", in: 0.28, out: 0.42 },
    ];
    const info = { on: true, live: true, minHold: 10000, maxPerWallet: 1, maxTotal: 50, total: 3, room: 47, maxCapUsd: 50, liveMaxCapUsd: 50, trialCapUsd: 1, defaultCapUsd: 1, asksPerDay: 3, models, tools: ["feed", "draft"], menu, timezone: "Europe/Rome", chainId: 1 };
    const feedOf = (name, lines) => lines.map(([hoursAgo, task, title, text]) => ({ at: t0 - hoursAgo * H, task, title, text, kind: "note" })).concat([]).sort((a, b) => b.at - a.at);
    const sage = {
      name: "sage", title: "Sage", role: "watches the coin for me and explains what moved, in plain words", personality: "calm, a little dry, likes short sentences", holder, holderShort: B.short(holder),
      since: new Date(t0 - 9 * 24 * H).toISOString(), outputs: 14, lastJob: { at: t0 - 2 * H, job: "note" }, telegram: false,
      tasks: [{ id: "watch", title: "Daily watch", tool: "feed", hours: [9] }, { id: "faq", title: "Questions people ask", tool: "feed", hours: [17] }],
      feed: feedOf("sage", [[2, "watch", "Daily watch", "Quiet day. Eleven trades since yesterday, the pool holds a little more than it did. The Kitchen shows nine jobs done, most of them answers from Crumb. Nothing moved that needs your attention."], [26, "watch", "Daily watch", "Trading picked up in the evening: thirty-one trades, three times yesterday. The team vault released its daily share this morning. Nib's note is about a competitor on Solana."], [33, "faq", "Questions people ask", "People asked how a tip reaches a brownie, whether staking has a lock, and where the tax goes. A tip is SUGAR sent to the brownie's key through the vault. Staking has no lock. The tax splits 35, 35 and 30."]]),
    };
    const pepper = {
      name: "pepper", title: "Pepper", role: "drafts my posts about Brownies so I only have to paste them", personality: "bubbly, loves a good pun, never mean", holder: other, holderShort: B.short(other),
      since: new Date(t0 - 4 * 24 * H).toISOString(), outputs: 5, lastJob: { at: t0 - 5 * H, job: "deal" }, telegram: true,
      tasks: [{ id: "posts", title: "Post ideas", tool: "draft", hours: [11] }],
      feed: feedOf("pepper", [[5, "posts", "Post ideas", "Three for today. One: Four brownies, one coin, zero coffee breaks. Two: Every trade pays for AI, and the Kitchen shows the receipt. Three: Ask Crumb anything in the group, it answers before you finish typing."]]),
    };
    const rook = {
      name: "rook", title: "Rook", role: "reads the research notes and tells me what matters this week", personality: "serious, careful with numbers, no jokes", holder: "0x9C355950bd5634eF2b2935d356075C7c19b2386a", holderShort: B.short("0x9C355950bd5634eF2b2935d356075C7c19b2386a"),
      since: new Date(t0 - 30 * 60e3).toISOString(), outputs: 0, lastJob: null, telegram: false,
      tasks: [{ id: "note", title: "Weekly note", tool: "feed", hours: [8] }, { id: "digest", title: "Evening digest", tool: "draft", hours: [21] }],
      feed: [],
    };
    const full = (b) => ({ ...b, wallet: "0x8F0ff1c2B99dC7573Db5De59bc8e8Dd40FD22E9d", payFrom: b.holder, model: "anthropic/claude-haiku-4.5", capUsd: 0.5, spentTodayUsd: 0.0312, callsToday: 2, asksLeft: 2, fund: { how: "grant", grantee: "0x8F0ff1c2B99dC7573Db5De59bc8e8Dd40FD22E9d", daily_usd: 0.5, header: "X-Brownies-Pay-From: " + b.holder } });
    const state = { shelf: [sage, pepper, rook], mine: kind === "form" ? [] : [full(sage)], grant: kind === "form" ? null : { daily_usd: "0.500000", room_today_usd: "0.468800", spent_today_usd: "0.031200" } };
    window.__bakeDemo = state;
    return async (path, { method, body }) => {
      const ok = (b) => ({ ok: true, status: 200, body: b });
      if (path === "/info") return ok({ ...info, total: state.shelf.length, room: info.maxTotal - state.shelf.length });
      if (path === "/feed") return ok({ brownies: state.shelf });
      if (path === "/nonce") return ok({ nonce: "0".repeat(32), message: "Brownies bakery login <nonce>" });
      if (path === "/login") return ok({ token: "d".repeat(64), expiresAt: t0 + 24 * H, wallet: holder });
      if (path === "/logout") return ok({ ok: true });
      if (path === "/mine") return ok({ wallet: holder, brownies: state.mine, canBake: state.mine.length === 0, why: state.mine.length ? "one brownie per wallet for now" : "", hold: 24500, trial: false });
      if (path === "/create") {
        const name = String(body.name || "").toLowerCase();
        if (!/^[a-z][a-z0-9]{2,15}$/.test(name)) return { ok: false, status: 400, body: { error: "the name must be 3 to 16 letters or digits, starting with a letter" } };
        const tasks = (body.tasks || []).map((t, i) => t.menu ? { ...menu.find((m) => m.id === t.menu), hours: t.hours && t.hours.length ? t.hours : menu.find((m) => m.id === t.menu).hours } : { id: `task${i + 1}`, title: t.title, tool: t.tool || "feed", hours: t.hours || [10] }).map((t) => ({ id: t.id, title: t.title, tool: t.tool, hours: t.hours }));
        if (!tasks.length) return { ok: false, status: 400, body: { error: "a recruit needs at least one task" } };
        const b = full({ name, title: cap(name), role: body.role, personality: body.personality || null, holder, holderShort: B.short(holder), since: new Date().toISOString(), outputs: 0, lastJob: null, telegram: false, tasks, feed: [] });
        b.capUsd = Math.min(info.maxCapUsd, Number(body.dailyCapUsd) || info.defaultCapUsd); b.fund.daily_usd = b.capUsd; b.spentTodayUsd = 0; b.callsToday = 0; b.asksLeft = 3; b.model = models.some((m) => m.id === body.model) ? body.model : models[0].id;
        state.mine = [b]; state.shelf.unshift(b); state.grant = null;
        return ok(b);
      }
      if (path === "/ask") { const b = state.mine[0]; if (!b) return { ok: false, status: 400, body: { error: "that is not one of your brownies" } }; b.asksLeft = Math.max(0, b.asksLeft - 1); setTimeout(() => { b.feed.unshift({ at: Date.now(), task: "ask", title: String(body.text).slice(0, 60), text: "Done. " + String(body.text), kind: "note" }); b.outputs++; }, 800); return ok({ started: true, left: b.asksLeft }); }
      if (path === "/link") { const b = state.mine[0]; if (!b) return { ok: false, status: 400, body: { error: "that is not one of your brownies" } }; return ok({ code: "123456", bot: "@feedthebrownies_bot", url: "https://t.me/feedthebrownies_bot?start=link_123456", expiresAt: Date.now() + 600e3, name: b.name }); }
      if (path === "/unlink") { const b = state.mine[0]; if (b) b.telegram = false; return ok({ unlinked: true }); }
      if (path === "/retire") { const b = state.mine[0]; state.mine = []; state.shelf = state.shelf.filter((x) => x !== b && x.name !== b?.name); return ok({ retired: true }); }
      return { ok: false, status: 404, body: { error: "no such route" } };
    };
  }
  /// the gateway's grant calls in demo mode, so the fund step can be seen without a chain
  async function demoGrant(action, daily) {
    const s = window.__bakeDemo;
    if (action === "set") s.grant = { daily_usd: Number(daily).toFixed(6), room_today_usd: Number(daily).toFixed(6), spent_today_usd: "0.000000" };
    if (action === "revoke") s.grant = null;
    return s.grant;
  }

  window.Baked = { api, face, look, cap, when, hourLabel, zoneName, jobLine, demo: Boolean(demo), demoKind, demoGrant };
})();
