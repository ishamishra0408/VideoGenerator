// The web page: a form, live progress, an editable storyboard, the finished film and past films.
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  // a session that has run out sends the page back to sign in
  var realFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    return realFetch(url, opts).then(function (r) { if (r.status === 401) location.href = "/login"; return r; });
  };
  var WPM = 146, ORDER = ["repo", "storyboard", "voice", "sound", "render"];
  var S = { minutes: 2, voice: "gemini", mode: "keep", theme: "gitdiagram", tmode: "light", plan: null, dir: null, busy: false, key: true };
  var GITDIAGRAM = { vars: { "--paper": "#f2e8ff", "--card": "#fdfaff", "--ink": "#17111f", "--purple": "#bd85fb", "--purple-soft": "#dcc2ff", "--purple-deep": "#7a2be0" }, fonts: { sans: "Geist" } };

  // ---------- remembered inputs ----------
  var store = {
    get: function () { try { return JSON.parse(localStorage.getItem("videogen") || "{}"); } catch (e) { return {}; } },
    set: function (v) { try { localStorage.setItem("videogen", JSON.stringify(v)); } catch (e) {} },
  };
  function remember() { store.set({ repo: $("#repo").value, brief: $("#brief").value, minutes: S.minutes, voice: S.voice, theme: S.theme, tmode: S.tmode }); }

  // ---------- segmented controls ----------
  function seg(id, key, after) {
    var el = $("#" + id);
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b || b.disabled) return;
      pick(id, b.dataset.v);
      S[key] = key === "minutes" ? Number(b.dataset.v) : b.dataset.v;
      if (after) after();
      remember();
    });
  }
  function pick(id, v) { $("#" + id).querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x.dataset.v === String(v)); }); }
  seg("minutes", "minutes");
  seg("voice", "voice");
  seg("mode", "mode");
  seg("tmode", "tmode", swatches);

  var saved = store.get();
  if (saved.repo) $("#repo").value = saved.repo;
  if (saved.brief) $("#brief").value = saved.brief;
  if (saved.minutes) { S.minutes = saved.minutes; pick("minutes", saved.minutes); }
  if (saved.voice) { S.voice = saved.voice; pick("voice", saved.voice); }
  if (saved.tmode) { S.tmode = saved.tmode; pick("tmode", saved.tmode); }
  var savedTheme = saved.theme;  // used once the list confirms it still exists
  ["repo", "brief"].forEach(function (id) { $("#" + id).addEventListener("change", remember); });

  var script = $("#script");
  function scriptChanged() { $("#mode").hidden = !script.value.trim(); }
  script.addEventListener("input", scriptChanged);
  $("#scriptfile").addEventListener("change", function (e) {
    var f = e.target.files[0];
    if (!f) return;
    f.text().then(function (t) { script.value = t; scriptChanged(); });
    e.target.value = "";
  });

  // ---------- theme ----------
  var themeSeq = 0;
  function swatches() {
    var host = $("#swatches"), seq = ++themeSeq;
    $("#tmode").querySelectorAll("button").forEach(function (b) { b.disabled = S.theme === "gitdiagram"; });
    var draw = function (t) {
      if (seq !== themeSeq) return;
      host.textContent = "";
      ["--paper", "--card", "--ink", "--purple", "--purple-soft", "--purple-deep"].forEach(function (k) {
        var i = el("i"); i.style.background = t.vars[k] || "transparent"; i.title = k.slice(2); host.appendChild(i);
      });
      var font = (t.fonts && t.fonts.sans || "").split(",")[0].replace(/["']/g, "");
      if (font) host.appendChild(el("span", null, font));
    };
    if (S.theme === "gitdiagram") return draw(GITDIAGRAM);
    host.textContent = "";
    fetch("/api/themes/" + encodeURIComponent(S.theme) + "?mode=" + S.tmode).then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(draw, function () { if (seq === themeSeq) host.appendChild(el("span", null, "Couldn't load this theme")); });
  }
  $("#theme").addEventListener("change", function (e) { S.theme = e.target.value; remember(); swatches(); });
  swatches();
  fetch("/api/themes").then(function (r) { return r.ok ? r.json() : []; }).then(function (list) {
    if (!Array.isArray(list)) list = [];
    var sel = $("#theme");
    list.forEach(function (t) { var o = el("option", null, t.name); o.value = t.slug; sel.appendChild(o); });
    if (savedTheme && list.some(function (t) { return t.slug === savedTheme; }) && S.theme === "gitdiagram") { S.theme = savedTheme; sel.value = savedTheme; swatches(); }
  }, function () {});

  // ---------- views ----------
  function show(view) {
    ["progress", "board", "film"].forEach(function (v) { $("#" + v).hidden = v !== view; });
    $("#library").hidden = view === "progress";
  }
  function cost(line) { var el = $("#cost"); el.querySelector("span").textContent = line || ""; el.hidden = !line; }
  function error(msg) { var el = $("#error"); el.textContent = msg || ""; el.hidden = !msg; }
  function notes(host, list) {
    host.textContent = "";
    (list || []).forEach(function (w) { var d = document.createElement("div"); d.className = "note"; d.textContent = w; host.appendChild(d); });
  }
  var ping = null;
  function busy(on) {
    S.busy = on;
    // a free Render server sleeps after 15 quiet minutes; a request a minute keeps it awake while it films
    if (on && !ping) ping = setInterval(function () { fetch("/api/status").catch(function () {}); }, 60000);
    if (!on && ping) { clearInterval(ping); ping = null; }
    ["#go-board", "#go-film", "#b-film", "#f-edit"].forEach(function (s) { $(s).disabled = on || (!S.key && (s === "#go-board" || s === "#go-film")); });
  }
  var clock = function (sec) { var m = Math.floor(sec / 60), s = Math.round(sec % 60); if (s === 60) { m++; s = 0; } return m + ":" + (s < 10 ? "0" : "") + s; };
  var withQuery = function (url, q) { return url + (url.indexOf("?") < 0 ? "?" : "&") + q; };
  var countWords = function (t) { return t.split(/\s+/).filter(Boolean).length; };

  // ---------- running a job ----------
  function steps(visible) {
    document.querySelectorAll(".steps li").forEach(function (li) {
      li.hidden = visible.indexOf(li.dataset.stage) < 0;
      li.className = "";
      li.querySelector(".smsg").textContent = "";
    });
    $(".bar i").style.width = "0";
  }
  function step(e) {
    if (e.stage === "queued") { var first = document.querySelector(".steps li:not([hidden]) .smsg"); if (first) first.textContent = e.message; return; }
    var at = e.stage === "done" ? ORDER.length : ORDER.indexOf(e.stage);
    document.querySelectorAll(".steps li").forEach(function (li) {
      var i = ORDER.indexOf(li.dataset.stage);
      li.className = i < at ? "done" : i === at ? "active" : "";
      if (i === at) li.querySelector(".smsg").textContent = e.message;
    });
    if (e.stage === "render" && typeof e.fraction === "number") $(".bar i").style.width = e.fraction * 100 + "%";
  }

  function run(body, visible) {
    error("");
    cost("");
    busy(true);
    steps(visible);
    show("progress");
    return fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "The server refused."); return j.id; }); })
      .then(function (id) {
        return new Promise(function (resolve, reject) {
          var es = new EventSource("/api/runs/" + id + "/events");
          es.onmessage = function (m) {
            var e = JSON.parse(m.data);
            if (e.type === "progress") return e.stage === "cost" ? cost(e.message) : step(e);
            es.close();
            e.type === "done" ? resolve(e.result) : reject(new Error(e.message));
          };
          es.onerror = function () { es.close(); reject(new Error("Lost touch with the server. Finished films still appear under Films.")); };
        });
      })
      .then(function (result) { busy(false); return result; }, function (err) { busy(false); error(err.message); show(body.plan ? "board" : null); throw err; });
  }

  function formBody(kind) {
    var b = { kind: kind, repo: $("#repo").value.trim(), minutes: S.minutes, voice: S.voice, brief: $("#brief").value.trim(), theme: S.theme, themeMode: S.tmode };
    if (script.value.trim()) { b.script = script.value; b.adapt = S.mode === "fit"; }
    return b;
  }

  $("#make").addEventListener("submit", function (e) {
    e.preventDefault();
    if (S.busy) return;
    remember();
    run(formBody("storyboard"), ["repo", "storyboard"]).then(function (r) { openBoard(r.plan, r.dir, r.warnings, r.storyboard, r.cost); }, function () {});
  });
  $("#go-film").addEventListener("click", function () {
    if (S.busy || !$("#make").reportValidity()) return;
    remember();
    run(formBody("film"), ORDER).then(openFilm, function () {});
  });
  $("#b-film").addEventListener("click", function () {
    if (S.busy) return;
    var plan = collect();
    run({ kind: "film", plan: plan, dir: S.dir, voice: S.voice, theme: S.theme, themeMode: S.tmode }, ["voice", "sound", "render"]).then(openFilm, function () {});
  });

  // ---------- the storyboard ----------
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function grow(t) { t.style.height = "auto"; t.style.height = t.scrollHeight + 4 + "px"; }

  function openBoard(plan, dir, warnings, json, spent) {
    if (spent !== undefined) cost(spent);
    S.plan = plan; S.dir = dir;
    $("#b-title").textContent = plan.title;
    $("#b-json").href = json || "#";
    notes($("#b-notes"), warnings);
    var host = $("#beats");
    host.textContent = "";
    plan.beats.forEach(function (b, bi) {
      var sec = el("section", "beat"), h = el("div", "beat-h"), title = el("input");
      title.value = b.title; title.maxLength = 22; title.dataset.beat = bi;
      h.appendChild(el("span", "num", String(bi + 1))); h.appendChild(title); sec.appendChild(h);
      b.scenes.forEach(function (s, si) {
        var c = el("div", "card scene"), top = el("div", "scene-top"), eyebrow = el("input", "eyebrow"), heading = el("input", "heading"), lines = el("textarea");
        c.dataset.beat = bi; c.dataset.scene = si;
        eyebrow.value = s.eyebrow || ""; eyebrow.placeholder = "Label"; eyebrow.maxLength = 40;
        heading.value = s.heading; heading.maxLength = 90;
        lines.value = s.lines.join("\n"); lines.rows = 2;
        lines.addEventListener("input", function () { grow(lines); meta(); });
        top.appendChild(el("span", "kind", s.kind)); top.appendChild(eyebrow);
        c.appendChild(top); c.appendChild(heading); c.appendChild(lines);
        var items = (s.items || []).map(function (it) { return it.title; });
        if (s.code && s.code.file) items.unshift(s.code.file);
        if (items.length) { var row = el("div", "items"); items.forEach(function (t) { row.appendChild(el("span", null, t)); }); c.appendChild(row); }
        sec.appendChild(c);
      });
      host.appendChild(sec);
    });
    show("board");
    document.querySelectorAll("#beats textarea").forEach(grow);
    meta();
  }

  function meta() {
    var words = 0;
    document.querySelectorAll("#beats textarea").forEach(function (t) { words += countWords(t.value); });
    var scenes = document.querySelectorAll("#beats .scene").length;
    $("#b-meta").textContent = S.plan.beats.length + " beats · " + scenes + " scenes · " + words + " words · about " + clock((words / WPM) * 60);
  }

  /** The storyboard with the page's edits applied: one narration sentence per line. */
  function collect() {
    var plan = JSON.parse(JSON.stringify(S.plan));
    document.querySelectorAll("#beats .beat-h input").forEach(function (i) { plan.beats[+i.dataset.beat].title = i.value.trim() || plan.beats[+i.dataset.beat].title; });
    document.querySelectorAll("#beats .scene").forEach(function (c) {
      var s = plan.beats[+c.dataset.beat].scenes[+c.dataset.scene];
      s.eyebrow = c.querySelector(".eyebrow").value.trim() || undefined;
      s.heading = c.querySelector(".heading").value.trim() || s.heading;
      s.lines = c.querySelector("textarea").value.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
    });
    delete plan.tag;
    return plan;
  }

  // ---------- the film ----------
  function openFilm(r) {
    cost(r.cost);
    $("#yt").hidden = true;
    S.youtube = r.youtube || null;
    ytLink(S.youtube);
    var v = $("#player");
    v.textContent = "";
    v.src = r.video;
    if (r.vtt) { var t = el("track"); t.kind = "captions"; t.srclang = "en"; t.label = "English"; t.src = r.vtt; v.appendChild(t); }
    $("#f-title").textContent = (r.plan && r.plan.title) || r.title || r.dir;
    $("#f-meta").textContent = [r.duration ? clock(r.duration) : "", r.plan ? r.plan.repo : r.repo].filter(Boolean).join(" · ");
    $("#f-mp4").href = withQuery(r.video, "download=1");
    $("#f-srt").href = r.captions ? withQuery(r.captions, "download=1") : "#";
    $("#f-srt").hidden = !r.captions;
    notes($("#f-notes"), r.warnings);
    S.dir = r.dir;
    S.plan = r.plan || null;
    S.storyboard = r.storyboard;
    show("film");
    library();
  }

  $("#f-edit").addEventListener("click", function () {
    if (S.plan) return openBoard(S.plan, S.dir, [], S.storyboard);
    fetch(S.storyboard).then(function (r) { return r.json(); }).then(function (p) { openBoard(p, S.dir, [], S.storyboard); }, function () { error("That film has no storyboard."); });
  });

  // ---------- YouTube ----------
  var Y = { privacy: "private", status: null, posting: null };
  /** Under the film, always: where it is on YouTube. */
  function ytLink(v) {
    var line = $("#f-ytlink");
    line.textContent = "";
    line.hidden = !v;
    if (!v) return;
    var a = el("a", null, v.url.replace(/^https:\/\//, "")); a.href = v.url; a.target = "_blank"; a.rel = "noopener";
    line.appendChild(document.createTextNode("On YouTube · ")); line.appendChild(a);
  }
  /** A posted film's panel collapses to one line: what happened, and where to see it. */
  function postedLine(v) {
    var box = $("#yt-posted");
    box.textContent = "";
    box.appendChild(document.createTextNode(v.privacy !== v.requested ? "Posted, but YouTube kept it private until this Google project passes its audit. " : "Posted. "));
    var watch = el("a", null, "Watch"); watch.href = v.url; watch.target = "_blank"; watch.rel = "noopener";
    var studio = el("a", null, "YouTube Studio"); studio.href = v.studio; studio.target = "_blank"; studio.rel = "noopener";
    box.appendChild(watch); box.appendChild(document.createTextNode(" · ")); box.appendChild(studio);
    box.hidden = false;
    $("#yt-form").hidden = true;
    $("#yt").querySelector(".yt-connect").hidden = true;
    $("#yt").querySelector(".yt-off").hidden = true;
  }
  seg("yt-privacy", "ytPrivacy", function () { Y.privacy = S.ytPrivacy; });
  function ytShow(open) {
    var box = $("#yt");
    box.hidden = !open;
    if (!open) return;
    $("#yt-posted").hidden = true;
    if (S.youtube) return postedLine(S.youtube);
    // every film starts Private; a post in flight keeps its bar on its own film only
    Y.privacy = "private"; pick("yt-privacy", "private");
    var mine = Y.posting === S.dir;
    $("#yt-done").hidden = true; $("#yt-bar").hidden = !mine; $("#yt-status").hidden = !Y.posting;
    $("#yt-status").textContent = Y.posting && !mine ? "Another film is posting." : $("#yt-status").textContent;
    $("#yt-post").disabled = !!Y.posting;
    fetch("/api/youtube").then(function (r) { return r.json(); }).then(function (st) {
      Y.status = st;
      box.querySelector(".yt-off").hidden = st.configured;
      box.querySelector(".yt-connect").hidden = !st.configured || st.connected;
      $("#yt-form").hidden = !st.connected;
      if (!st.connected) return;
      $("#yt-who").textContent = st.email ? "Posting as " + st.email : "Connected";
      fetch("/api/youtube/draft?dir=" + encodeURIComponent(S.dir)).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        if (!d) return;
        $("#yt-title").value = d.title;
        $("#yt-desc").value = d.description;
      });
    });
  }
  $("#f-yt").addEventListener("click", function () { ytShow($("#yt").hidden); });
  // Google sends the browser back to the front page: remember which film to come back to
  $("#yt-connect").addEventListener("click", function () { try { localStorage.setItem("videogen-yt-film", S.dir || ""); } catch (e) {} });
  $("#yt-disconnect").addEventListener("click", function () {
    fetch("/api/youtube/disconnect", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(function () { ytShow(true); });
  });
  $("#yt-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var post = $("#yt-post"), bar = $("#yt-bar"), done = $("#yt-done"), status = $("#yt-status"), film = S.dir;
    var here = function () { return S.dir === film && !$("#yt").hidden; };
    Y.posting = film;
    post.disabled = true; bar.hidden = false; bar.querySelector("i").style.width = "0"; done.hidden = true;
    status.textContent = "Starting the upload"; status.hidden = false;
    fetch("/api/youtube/upload", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: S.dir, title: $("#yt-title").value, description: $("#yt-desc").value, privacy: Y.privacy }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "YouTube refused."); return j.id; }); })
      .then(function (id) {
        return new Promise(function (resolve, reject) {
          var es = new EventSource("/api/runs/" + id + "/events");
          es.onmessage = function (m) {
            var ev = JSON.parse(m.data);
            if (ev.type === "progress") {
              if (here()) { status.textContent = ev.message; if (typeof ev.fraction === "number") bar.querySelector("i").style.width = ev.fraction * 100 + "%"; }
              return;
            }
            es.close();
            ev.type === "done" ? resolve(ev.result) : reject(new Error(ev.message));
          };
          es.onerror = function () { es.close(); reject(new Error("Lost touch with the server. The upload may still finish: check YouTube Studio in a few minutes before posting again.")); };
        });
      })
      .then(function (v) {
        if (S.dir === film) { S.youtube = v; ytLink(v); }
        if (here()) postedLine(v);
        library();
      }, function (err) { if (!here()) return; done.textContent = err.message; done.classList.add("err"); done.hidden = false; })
      .then(function () { Y.posting = null; post.disabled = false; bar.hidden = true; status.hidden = true; });
  });

  // ---------- past films ----------
  function library() {
    fetch("/api/library").then(function (r) { return r.json(); }).then(function (list) {
      var host = $("#lib");
      host.textContent = "";
      $("#lib-empty").hidden = list.length > 0;
      list.forEach(function (f) {
        var b = el("button", "card"), v = el("video"), cap = el("div", "cap");
        b.type = "button";
        v.preload = "metadata"; v.muted = true;
        v.src = f.video + "#t=4";  // a frame from the title card as the thumbnail
        cap.appendChild(el("b", null, f.title));
        cap.appendChild(el("small", null, [f.duration ? clock(f.duration) : "", new Date(f.made).toLocaleDateString()].filter(Boolean).join(" · ")));
        b.appendChild(v); b.appendChild(cap);
        b.addEventListener("click", function () { if (!S.busy) { error(""); openFilm(f); window.scrollTo({ top: 0, behavior: "smooth" }); } });
        host.appendChild(b);
      });
    }, function () {});
  }

  fetch("/api/youtube").then(function (r) { return r.json(); }).then(function (st) { $("#f-yt").hidden = !st.configured; }, function () { $("#f-yt").hidden = true; });
  fetch("/api/status").then(function (r) { return r.json(); }).then(function (s) {
    S.key = s.key;
    $("#keynote").hidden = s.key;
    $("#signout").hidden = !s.auth;
    if (!s.offline) { $("#voice-say").disabled = true; if (S.voice === "say") { S.voice = "gemini"; pick("voice", "gemini"); } }
    busy(false);
  }, function () {});
  library();

  // back from Google: reopen the film that was being posted, with the YouTube panel open
  (function () {
    var q = new URLSearchParams(location.search), y = q.get("youtube");
    if (!y) return;
    history.replaceState(null, "", "/");
    var WHY = { denied: "The YouTube sign-in was cancelled.", expired: "That YouTube sign-in link expired. Connect again.",
      scope: "YouTube upload permission wasn't granted. Connect again and allow it.", account: "That Google account isn't the one this site posts as.",
      failed: "The YouTube sign-in didn't finish. Try again." };
    if (y === "off") error("YouTube isn't set up on this server.");
    if (y === "error") error(WHY[q.get("code")] || WHY.failed);
    var film = ""; try { film = localStorage.getItem("videogen-yt-film") || ""; localStorage.removeItem("videogen-yt-film"); } catch (e) {}
    if (!film) return;
    fetch("/api/library").then(function (r) { return r.json(); }).then(function (list) {
      var f = list.filter(function (x) { return x.dir === film; })[0];
      if (f) { openFilm(f); ytShow(true); }
    });
  })();
})();
