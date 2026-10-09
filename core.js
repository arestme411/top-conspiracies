/* Top Conspiracies core: live fetchers + categorization/relevance/dedupe (port of fetch.py).
 * Works in the Android WebView (HTTP via native bridge) and in Node (for testing).
 * http(url, headers) must return Promise<{status:number, text:string}>.
 */
(function (root) {
  "use strict";
  var C = root.TC_CONFIG || (typeof require !== "undefined" ? (require("./config.js"), global.TC_CONFIG) : null);
  var RELEVANT = new RegExp(C.RELEVANT, "i"), LEGAL = new RegExp(C.LEGAL, "i"), STRONG = new RegExp(C.STRONG, "i");
  var DAY = 864e5;

  function decode(s) {
    if (!s) return "";
    return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(+d); })
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  function stripHtml(s, n) {
    n = n || 320;
    if (!s) return "";
    s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
    s = decode(s).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
  function tag(block, name) {
    var m = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">").exec(block);
    return m ? m[1] : "";
  }
  function attr(block, name, a) {
    var m = new RegExp("<" + name + "\\s[^>]*?" + a + "=\"([^\"]*)\"").exec(block);
    return m ? decode(m[1]) : "";
  }
  function blocks(xml, name) {
    var out = [], re = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "g"), m;
    while ((m = re.exec(xml))) out.push(m[1]);
    return out;
  }
  function pdate(s) { var t = Date.parse((s || "").trim()); return isNaN(t) ? null : t; }
  function iso(t) { return t == null ? null : new Date(t).toISOString(); }
  function qs(o) { return Object.keys(o).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(o[k]); }).join("&"); }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  async function get(http, url, ua, retries) {
    retries = retries == null ? 2 : retries;
    for (var a = 0; ; a++) {
      var r;
      try { r = await http(url, { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9" }); }
      catch (e) { r = { status: 0, text: "", error: String(e) }; }
      if (r.status >= 200 && r.status < 300) return r.text;
      if (a >= retries || (r.status >= 400 && r.status < 500 && r.status !== 429)) throw new Error("HTTP " + r.status + (r.error ? " " + r.error : ""));
      await sleep((r.status === 429 ? 6000 : 2000) + a * 4000);
    }
  }

  // ---------------- fetchers ----------------
  async function fetchReddit(http, sub, sort, now) {
    var url = "https://www.reddit.com/r/" + sub + "/" + sort + "/.rss?limit=100" + (sort === "top" ? "&t=day" : "");
    var xml = await get(http, url, C.REDDIT_UA);
    var ents = blocks(xml, "entry"), n = ents.length || 1, out = [];
    ents.forEach(function (e, i) {
      var content = decode(tag(e, "content"));
      var md = /<div class="md">([\s\S]*?)<\/div>/.exec(content);
      var img = attr(e, "media:thumbnail", "url");
      if (!img) { var im = /<img src="([^"]+)"/.exec(content); img = im ? decode(im[1]) : ""; }
      var t = pdate(tag(e, "published") || tag(e, "updated"));
      if (t && now - t > 3 * DAY && sort === "hot") return;
      out.push({
        title: decode(tag(e, "title")).trim(), url: attr(e, "link", "href"), source: "r/" + sub, platform: "Reddit",
        author: decode(tag(tag(e, "author"), "name")).trim(), snippet: stripHtml(md ? md[1] : ""), img: img,
        time: iso(t), rank: i + 1, pop: Math.round(1000 * (1 - i / n)) / 10 + (sort === "top" ? 15 : 0), sub: sub.toLowerCase()
      });
    });
    return out;
  }
  async function fetchGoogle(http, q, now) {
    var url = "https://news.google.com/rss/search?" + qs({ q: q + " when:1d", hl: "en-US", gl: "US", ceid: "US:en" });
    var xml = await get(http, url, C.BROWSER_UA);
    return blocks(xml, "item").map(function (it) {
      var title = decode(tag(it, "title")).trim(), src = decode(tag(it, "source")).trim() || "Google News";
      if (title.endsWith(" - " + src)) title = title.slice(0, -(src.length + 3));
      return { title: title, url: decode(tag(it, "link")).trim(), source: src, platform: "News", snippet: "", img: "",
        time: iso(pdate(tag(it, "pubDate")) || now), pop: 30 };
    });
  }
  async function fetchBing(http, q, now) {
    var url = "https://www.bing.com/news/search?" + qs({ q: q, format: "rss", qft: 'interval="7"' });
    var xml = await get(http, url, C.BROWSER_UA), out = [];
    blocks(xml, "item").forEach(function (it) {
      var link = decode(tag(it, "link")).trim();
      var m = /[?&]url=([^&]+)/.exec(link); if (m) link = decodeURIComponent(m[1]);
      var t = pdate(tag(it, "pubDate"));
      if (t && now - t > 2 * DAY) return;
      var src = decode(tag(it, "News:Source")).trim();
      if (!src) { try { src = new URL(link).host.replace("www.", ""); } catch (e) { src = "Bing News"; } }
      out.push({ title: decode(decode(tag(it, "title"))).trim(), url: link, source: src, platform: "News",
        snippet: stripHtml(decode(tag(it, "description"))), img: decode(tag(it, "News:Image")).trim(), time: iso(t || now), pop: 30 });
    });
    return out;
  }
  function walkKey(o, key, out) {
    if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) walkKey(o[i], key, out); }
    else if (o && typeof o === "object") { if (o[key]) out.push(o[key]); for (var k in o) walkKey(o[k], key, out); }
    return out;
  }
  function views(t) { var m = /([\d,\.]+)\s*([KMB]?)/.exec(t || ""); if (!m) return 0; return Math.round(parseFloat(m[1].replace(/,/g, "")) * ({ "": 1, K: 1e3, M: 1e6, B: 1e9 })[m[2]]); }
  function relTime(t, now) {
    var m = /(\d+)\s*(second|minute|min|hour|day|week|month|year|mo|h|d|w|m|y|s)\b/.exec(t || ""); if (!m) return null;
    var sec = { second: 1, minute: 60, min: 60, hour: 3600, h: 3600, day: 86400, d: 86400, week: 604800, w: 604800, month: 2592000, mo: 2592000, m: 60, s: 1, year: 31536000, y: 31536000 }[m[2]];
    return now - (+m[1]) * sec * 1000;
  }
  async function fetchYouTube(http, q, now) {
    var html = await get(http, "https://www.youtube.com/results?" + qs({ search_query: q, sp: "EgIIAg==" }), C.BROWSER_UA);
    var m = /var ytInitialData = (\{[\s\S]*?\});<\/script>/.exec(html);
    if (!m) return [];
    var out = [];
    walkKey(JSON.parse(m[1]), "videoRenderer", []).forEach(function (v) {
      var vid = v.videoId, title = ((v.title || {}).runs || []).map(function (r) { return r.text || ""; }).join("");
      if (!vid || !title) return;
      var t = relTime((v.publishedTimeText || {}).simpleText, now);
      if (t == null || now - t > 3 * DAY) return;
      var ch = (((v.ownerText || {}).runs || [])[0] || {}).text || "YouTube";
      var vw = views((v.viewCountText || {}).simpleText), snip = "";
      (v.detailedMetadataSnippets || []).forEach(function (d) { snip = ((d.snippetText || {}).runs || []).map(function (r) { return r.text || ""; }).join(""); });
      out.push({ title: title, url: "https://www.youtube.com/watch?v=" + vid, source: ch, platform: "YouTube", snippet: snip.slice(0, 320),
        img: "https://i.ytimg.com/vi/" + vid + "/mqdefault.jpg", time: iso(t), views: vw, pop: vw ? Math.min(160, 25 + 18 * (String(vw).length - 2)) : 20 });
    });
    return out;
  }
  async function fetchBluesky(http, q, now) {
    var since = new Date(now - DAY).toISOString().replace(/\.\d+Z$/, "Z");
    var d = JSON.parse(await get(http, "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?" + qs({ q: q, sort: "top", since: since, limit: 100, lang: "en" }), C.BROWSER_UA));
    var out = [];
    (d.posts || []).forEach(function (p) {
      var text = ((p.record || {}).text || "").trim(); if (text.length < 25) return;
      var likes = p.likeCount || 0, rp = p.repostCount || 0, eng = likes + 2 * rp + (p.replyCount || 0);
      out.push({ title: text.split("\n")[0].slice(0, 160), snippet: text.slice(0, 320), url: "https://bsky.app/profile/" + p.author.handle + "/post/" + p.uri.split("/").pop(),
        source: "@" + p.author.handle, platform: "Bluesky", img: "", likes: likes, reposts: rp, comments: p.replyCount || 0,
        time: (p.record || {}).createdAt || p.indexedAt, pop: eng ? Math.min(150, 15 + 12 * String(eng).length) : 10 });
    });
    return out;
  }
  async function fetchMastodon(http, tagName, now) {
    var d = JSON.parse(await get(http, "https://mastodon.social/api/v1/timelines/tag/" + tagName + "?limit=40", C.BROWSER_UA)), out = [];
    d.forEach(function (p) {
      if (p.reblog) return;
      var text = stripHtml(p.content, 400); if (text.length < 25) return;
      var t = pdate(p.created_at); if (t && now - t > 3 * DAY) return;
      var eng = (p.favourites_count || 0) + 2 * (p.reblogs_count || 0);
      out.push({ title: text.slice(0, 160), snippet: text.slice(0, 320), url: p.url || p.uri, source: "@" + p.account.acct, platform: "Mastodon", img: "",
        likes: p.favourites_count || 0, comments: p.replies_count || 0, time: iso(t), pop: eng < 20 ? 10 + 5 * eng : 110 });
    });
    return out;
  }
  async function fetchLemmy(http, q, now) {
    var d = JSON.parse(await get(http, "https://lemmy.world/api/v3/search?" + qs({ q: q, type_: "Posts", sort: "TopDay", limit: 50 }), C.BROWSER_UA)), out = [];
    (d.posts || []).forEach(function (pv) {
      var p = pv.post, c = pv.counts || {}, t = pdate(p.published);
      if (t && now - t > 3 * DAY) return;
      out.push({ title: p.name, snippet: stripHtml(p.body || ""), url: p.ap_id || p.url, source: "!" + ((pv.community || {}).name || "lemmy"), platform: "Lemmy",
        img: p.thumbnail_url || "", score: c.score, comments: c.comments, time: iso(t), pop: Math.min(120, 15 + 2 * (c.score || 0)) });
    });
    return out;
  }
  // Optional remote X feed: JSON list of {title,url,author,likes,created_at,text} (or {posts:[...]}).
  async function fetchXUrl(http, url, now) {
    var d = JSON.parse(await get(http, url, C.BROWSER_UA, 1)); if (!Array.isArray(d)) d = d.posts || d.items || [];
    return d.filter(function (x) { return x.url && (x.text || x.title); }).map(function (x) {
      var text = (x.text || x.title).trim(), likes = +x.likes || 0, a = (x.author || "").replace(/^@/, "");
      return { title: (x.title || text.split("\n")[0]).slice(0, 180), snippet: text.slice(0, 320), url: x.url, source: a ? "@" + a : "X", platform: "X",
        img: x.img || "", likes: likes, comments: x.replies, reposts: x.reposts, time: iso(pdate(x.created_at) || now), pop: likes ? Math.min(200, 20 + 18 * String(likes).length) : 20 };
    });
  }

  // ---------------- rules ----------------
  // Pre-compile one matcher per category (short/padded keywords as whole words, others as substrings).
  var CAT_RX = Object.keys(C.CATEGORIES).map(function (cat) {
    var parts = C.CATEGORIES[cat].map(function (kw) {
      var k = kw.toLowerCase(), e = k.trim().replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
      return (k.trim() !== k || k.length <= 3) ? "(?:^|[^a-z0-9])" + e + "(?![a-z0-9])" : e;
    });
    return [cat, new RegExp(parts.join("|"))];
  });
  function categorize(it) {
    var t = (" " + (it.title || "") + " " + (it.snippet || "") + " ").toLowerCase().replace(/[^a-z0-9\/\.\-' ]/g, " "), out = [];
    CAT_RX.forEach(function (cr) { if (cr[1].test(t)) out.push(cr[0]); });
    var h = C.HINTS[(it.sub || "").toLowerCase()]; if (h && out.indexOf(h) < 0) out.push(h);
    return out.length ? out : ["Other"];
  }
  function relevant(it) {
    if (it.platform === "Reddit" || it.platform === "X") return true;
    var text = it.title + " " + (it.snippet || "");
    if (!RELEVANT.test(text)) return false;
    if (LEGAL.test(text) && !/conspiracy theor/i.test(text)) return STRONG.test(text.replace(/conspiracy/gi, ""));
    return true;
  }
  function urlKey(u) {
    try {
      var x = new URL(u), keep = [];
      x.searchParams.forEach(function (v, k) { if (k.indexOf("utm_") !== 0 && ["ref", "oc", "hl", "gl", "ceid"].indexOf(k) < 0) keep.push(encodeURIComponent(k) + "=" + encodeURIComponent(v)); });
      return (x.host.replace("www.", "") + x.pathname.replace(/\/$/, "") + "?" + keep.join("&")).toLowerCase();
    } catch (e) { return u; }
  }
  function normTitle(t) { return (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 90); }
  function heat(it, now) { var t = it.time ? Date.parse(it.time) : NaN; var age = isNaN(t) ? 24 : Math.max(0, (now - t) / 36e5); return it.pop / Math.pow(age + 2, 0.35); }

  function merge(lists, now) {
    var merged = [], byKey = new Map();
    lists.forEach(function (it) {
      if (!it || !it.title || !it.url || !relevant(it)) return;
      var keys = [urlKey(it.url), normTitle(it.title)], ex = byKey.get(keys[0]) || byKey.get(keys[1]);
      if (ex) {
        ex.pop = Math.max(ex.pop, it.pop) + 8; ex.hits++;
        if (!ex.snippet && it.snippet) ex.snippet = it.snippet;
        if (!ex.img && it.img) ex.img = it.img;
        keys.forEach(function (k) { byKey.set(k, ex); }); return;
      }
      it.hits = 1; merged.push(it); keys.forEach(function (k) { byKey.set(k, it); });
    });
    merged.forEach(function (it) { it.cats = categorize(it); it.heat = Math.round(heat(it, now) * 100) / 100; });
    merged.sort(function (a, b) { return b.heat - a.heat; });
    return merged;
  }

  async function pool(tasks, n) {
    var i = 0;
    async function worker() { while (i < tasks.length) { var t = tasks[i++]; await t(); } }
    var ws = []; for (var k = 0; k < Math.min(n, tasks.length); k++) ws.push(worker());
    await Promise.all(ws);
  }

  /** Fetch every source. opts: {http, xUrl, onProgress(items, status, done, total), concurrency} */
  async function fetchAll(opts) {
    var http = opts.http, now = Date.now(), raw = [], status = {}, done = 0, total = 0, lastEmit = 0;
    function job(key, fn) {
      total++;
      return async function () {
        try { var got = await fn(); status[key] = got.length; Array.prototype.push.apply(raw, got); }
        catch (e) { status[key] = "FAIL " + (e && e.message || e); }
        done++;
        if (opts.onProgress && (Date.now() - lastEmit > 4000 || done === total)) { lastEmit = Date.now(); opts.onProgress(merge(raw.map(clone), now), status, done, total); }
      };
    }
    var reddit = [], others = [];
    C.SUBREDDITS.forEach(function (s) { ["top", "hot"].forEach(function (so) { reddit.push(job("reddit r/" + s + " " + so, function () { return fetchReddit(http, s, so, now); })); }); });
    C.YT_QUERIES.forEach(function (q) { others.push(job("youtube: " + q, function () { return fetchYouTube(http, q, now); })); });
    C.SOCIAL_QUERIES.forEach(function (q) {
      others.push(job("bluesky: " + q, function () { return fetchBluesky(http, q, now); }));
      others.push(job("lemmy: " + q, function () { return fetchLemmy(http, q, now); }));
    });
    C.MASTODON_TAGS.forEach(function (t) { others.push(job("mastodon: #" + t, function () { return fetchMastodon(http, t, now); })); });
    C.NEWS_QUERIES.forEach(function (q) {
      others.push(job("google news: " + q, function () { return fetchGoogle(http, q, now); }));
      others.push(job("bing news: " + q, function () { return fetchBing(http, q, now); }));
    });
    if (opts.xUrl) others.push(job("x feed", function () { return fetchXUrl(http, opts.xUrl, now); }));
    // Reddit is rate-limit sensitive: 2 at a time with a short pause; everything else in parallel.
    var redditPaced = reddit.map(function (t) { return async function () { await t(); await sleep(700); }; });
    await Promise.all([pool(redditPaced, 1), pool(others, opts.concurrency || 8)]);
    return { items: merge(raw, now), status: status, fetchedAt: new Date(now).toISOString() };
  }
  function clone(o) { var c = {}; for (var k in o) c[k] = o[k]; return c; }

  var api = { fetchAll: fetchAll, merge: merge, categorize: categorize, relevant: relevant, heat: heat, urlKey: urlKey, normTitle: normTitle,
    _f: { fetchReddit: fetchReddit, fetchGoogle: fetchGoogle, fetchBing: fetchBing, fetchYouTube: fetchYouTube, fetchBluesky: fetchBluesky, fetchMastodon: fetchMastodon, fetchLemmy: fetchLemmy } };
  root.TCCore = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
