// The stage: builds every scene from the storyboard, lays it out to fit, and draws any moment on demand.
// window.seek(t) puts the picture at t seconds; the renderer screenshots it frame by frame.
(function () {
  "use strict";
  var VG = window.VG, plan = VG.plan, cues = VG.cues, TR = VG.transition, DURATION = VG.duration;
  var scenes = [];
  plan.beats.forEach(function (b, bi) { b.scenes.forEach(function (s) { scenes.push({ beat: bi, s: s }); }); });

  var MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return MAP[c]; }); };
  var rich = function (s) { return esc(s).replace(/\*([^*]+)\*/g, "<em>$1</em>"); };
  var flat = function (s) { return esc(String(s == null ? "" : s).replace(/\*/g, "")); };
  var at = function (t, anim) { return ' data-t="' + t.toFixed(3) + '"' + (anim ? ' data-anim="' + anim + '"' : ""); };

  document.querySelector("#brand span").textContent = plan.repo;
  document.getElementById("tag").textContent = plan.tag || "";

  // ---------- building ----------

  function chips(items, c) {
    return '<div class="chips">' + items.map(function (it, i) { return '<span class="chip"' + at(c.items[i]) + ">" + flat(it.title) + "</span>"; }).join("") + "</div>";
  }
  function itemCard(it, t, cls) {
    return '<div class="card ' + (cls || "") + '"' + at(t) + ">" +
      (it.tag ? '<div class="tag">' + flat(it.tag) + "</div>" : "") +
      '<div class="t">' + flat(it.title) + "</div>" +
      (it.text ? '<div class="x">' + flat(it.text) + "</div>" : "") + "</div>";
  }

  var BUILD = {
    title: function (s, c) {
      var initial = (plan.title || plan.repo || "?").replace(/[^A-Za-z0-9]/g, "").charAt(0) || "·";
      return '<div class="hero">' +
        (s.eyebrow ? '<div class="eyebrow"' + at(c.eyebrow) + ">" + flat(s.eyebrow) + "</div>" : "") +
        '<div class="lead"><div class="mark"' + at(Math.max(0, c.heading - 0.15)) + ">" + esc(initial) + "</div>" +
        '<div><h1 class="heading"' + at(c.heading) + ">" + rich(s.heading) + "</h1>" +
        (plan.url ? '<div class="sub" style="margin-top:22px"' + at(c.heading + 0.4) + ">" + esc(plan.url.replace(/^https?:\/\//, "")) + "</div>" : "") +
        "</div></div>" + (s.items.length ? chips(s.items, c) : "") + "</div>";
    },
    statement: function (s, c) {
      return '<div class="hero">' +
        (s.eyebrow ? '<div class="eyebrow"' + at(c.eyebrow) + ">" + flat(s.eyebrow) + "</div>" : "") +
        '<h1 class="heading"' + at(c.heading) + ">" + rich(s.heading) + "</h1>" +
        (s.items.length ? chips(s.items, c) : "") + "</div>";
    },
    cards: function (s, c) {
      return '<div class="grid" style="grid-template-columns:repeat(' + s.items.length + ',1fr)">' +
        s.items.map(function (it, i) { return itemCard(it, c.items[i]); }).join("") + "</div>";
    },
    stats: function (s, c) {
      return '<div class="grid" style="grid-template-columns:repeat(' + s.items.length + ',1fr)">' +
        s.items.map(function (it, i) {
          return '<div class="card stat"' + at(c.items[i]) + ">" + (it.tag ? '<div class="tag">' + flat(it.tag) + "</div>" : "") +
            '<div class="v">' + flat(it.title) + "</div>" + (it.text ? '<div class="x">' + flat(it.text) + "</div>" : "") + "</div>";
        }).join("") + "</div>";
    },
    flow: function (s, c) {
      return '<div class="flow"><svg class="wires"></svg>' + s.items.map(function (it, i) { return itemCard(it, c.items[i]); }).join("") + "</div>";
    },
    code: function (s, c) {
      var lines = s.code.text.split("\n");
      var pre = lines.map(function (l, j) {
        return '<span class="cl"' + at(c.body + 0.3 + 0.06 * j, "type") + '><span class="ln">' + (j + 1) + "</span>" + esc(l) + "</span>";
      }).join("");
      return '<div class="codewrap"><div class="card codecard"' + at(c.body) + '><div class="bar"><i></i><i></i><i></i><span>' + esc(s.code.file || "") + "</span></div>" +
        '<pre class="code">' + pre + "</pre></div>" +
        (s.items.length ? '<div class="callouts">' + s.items.map(function (it, i) { return itemCard(it, c.items[i]); }).join("") + "</div>" : "") + "</div>";
    },
    tree: function (s, c) {
      return '<div class="card treecard"' + at(c.body) + ">" + s.items.map(function (it, i) {
        var p = it.title, dir = /\/$/.test(p), bare = p.replace(/\/$/, ""), cut = bare.lastIndexOf("/");
        var head = cut >= 0 ? bare.slice(0, cut + 1) : "", base = cut >= 0 ? bare.slice(cut + 1) : bare;
        return '<div class="trow"' + at(c.items[i]) + '><div class="p"><span class="g">' + (dir ? "▸" : "·") + "</span>" +
          '<span class="d">' + esc(head) + "</span><b>" + esc(base) + (dir ? "/" : "") + "</b></div>" +
          (it.text ? '<div class="note">' + flat(it.text) + "</div>" : "") + "</div>";
      }).join("") + "</div>";
    },
    compare: function (s, c) {
      var b = s.items[0], a = s.items[1];
      return '<div class="cmp">' +
        '<div class="card vs b"' + at(c.items[0], "stamp") + '><div class="lab"><i>✕</i>' + flat(b.tag || "Before") + "</div><p>" + rich(b.title) + "</p></div>" +
        '<div class="arrow"' + at(Math.max(c.items[0] + 0.2, c.items[1] - 0.25)) + ">→</div>" +
        '<div class="card vs a"' + at(c.items[1], "stamp") + '><div class="lab"><i>✓</i>' + flat(a.tag || "After") + "</div><p>" + rich(a.title) + "</p></div></div>";
    },
    checklist: function (s, c) {
      return '<div class="card checkcard"' + at(c.body) + ">" + s.items.map(function (it, i) {
        return '<div class="check"' + at(c.items[i]) + '><div class="box"' + at(c.items[i] + 0.45, "tick") + ">✓</div><div>" +
          '<div class="t">' + flat(it.title) + "</div>" + (it.text ? '<div class="x">' + flat(it.text) + "</div>" : "") + "</div></div>";
      }).join("") + "</div>";
    },
  };

  var host = document.getElementById("scenes");
  scenes.forEach(function (sc, i) {
    var s = sc.s, c = cues[i], hero = s.kind === "title" || s.kind === "statement";
    var html = hero ? BUILD[s.kind](s, c) :
      (s.eyebrow ? '<div class="eyebrow"' + at(c.eyebrow) + ">" + flat(s.eyebrow) + "</div>" : "") +
      '<h1 class="heading"' + at(c.heading) + ">" + rich(s.heading) + "</h1>" +
      '<div class="body">' + BUILD[s.kind](s, c) + "</div>";
    host.insertAdjacentHTML("beforeend", '<section class="slide k-' + s.kind + '"><div class="cam">' + html + "</div></section>");
  });
  var slides = Array.prototype.slice.call(host.children);

  var rail = document.getElementById("rail");
  plan.beats.forEach(function (b, i) {
    rail.insertAdjacentHTML("beforeend", '<div class="seg"><div class="bar"><b></b></div><div class="lab">' + (i + 1) + " · " + flat(b.title) + "</div></div>");
  });
  var segs = rail.querySelectorAll(".seg");
  var beatSpan = plan.beats.map(function (_, b) {
    var cs = cues.filter(function (c) { return c.beat === b; });
    return [cs[0].start, cs[cs.length - 1].end];
  });

  // ---------- fitting ----------

  function shrink(el, prop, from, to, step, unit, overflows) {
    for (var v = from; v >= to; v -= step) { el.style.setProperty(prop, v + unit); if (!overflows()) return; }
  }

  function layout(slide, kind) {
    var h = slide.querySelector(".heading");
    var base = kind === "title" ? 128 : kind === "statement" ? 96 : 84, lines = kind === "statement" ? 3 : 2;
    shrink(h, "--hs", base, 44, 4, "px", function () { return h.offsetHeight > parseFloat(h.style.getPropertyValue("--hs")) * 1.14 * lines; });
    if (kind === "title" || kind === "statement") {
      var hero = slide.querySelector(".hero");
      shrink(hero, "--s", 1, 0.6, 0.05, "", function () { return hero.scrollHeight > hero.clientHeight + 1; });
      return;
    }
    var body = slide.querySelector(".body");
    body.style.top = Math.min(h.offsetTop + h.offsetHeight + 60, 560) + "px";
    var tooBig = function () { return body.scrollHeight > body.clientHeight + 1; };
    if (kind === "code") {
      // Size the code so the line at the 80th percentile of length fits; longer lines end in an ellipsis.
      var pre = body.querySelector("pre"), card = body.querySelector(".codecard"), cl = pre.querySelectorAll(".cl");
      var lens = Array.prototype.map.call(cl, function (l) { return l.textContent.length; }).sort(function (a, b) { return a - b; });
      var probe = document.createElement("span"); probe.textContent = "0000000000"; pre.appendChild(probe);
      var charW = probe.getBoundingClientRect().width / 10; pre.removeChild(probe);
      var cs = Math.max(0.7, Math.min(1, (pre.clientWidth - 60) / (((lens[Math.floor(0.8 * (lens.length - 1))] || 1) + 1.5) * charW)));
      shrink(pre, "--cs", cs, 0.5, 0.04, "", function () { return pre.scrollHeight > pre.clientHeight + 1 || card.scrollHeight > body.clientHeight + 1; });
    }
    shrink(body, "--s", 1, 0.55, 0.04, "", tooBig);
    if (kind === "flow") drawWires(slide, body);
  }

  function drawWires(slide, body) {
    var flow = body.querySelector(".flow"), svg = flow.querySelector("svg"), nodes = flow.querySelectorAll(".card");
    var fr = flow.getBoundingClientRect(), out = "";
    for (var k = 0; k + 1 < nodes.length; k++) {
      var a = nodes[k].getBoundingClientRect(), b = nodes[k + 1].getBoundingClientRect();
      var x1 = a.right - fr.left + 16, y1 = a.top + a.height / 2 - fr.top, x2 = b.left - fr.left - 14, y2 = b.top + b.height / 2 - fr.top, mx = (x1 + x2) / 2;
      var t = Math.max(+nodes[k].dataset.t + 0.1, +nodes[k + 1].dataset.t - 0.35);
      out += '<path d="M' + x1 + " " + y1 + " C " + mx + " " + y1 + ", " + mx + " " + y2 + ", " + x2 + " " + y2 +
        " M " + (x2 - 15) + " " + (y2 - 13) + " L " + x2 + " " + y2 + " L " + (x2 - 15) + " " + (y2 + 13) + '"' + at(t, "draw") + "/>";
    }
    svg.innerHTML = out;
  }

  // ---------- motion ----------

  var clamp = function (x) { return x < 0 ? 0 : x > 1 ? 1 : x; };
  var outCubic = function (p) { return 1 - Math.pow(1 - p, 3); };
  var outBack = function (p) { var c = 1.70158, d = c + 1; return 1 + d * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };
  var inOut = function (p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; };

  var groups = [];
  function collect() {
    groups = slides.map(function (slide) {
      return Array.prototype.slice.call(slide.querySelectorAll("[data-t]")).map(function (el) {
        var o = { el: el, t: +el.dataset.t, anim: el.dataset.anim || "pop" };
        if (o.anim === "draw") { o.len = el.getTotalLength(); el.style.strokeDasharray = o.len; }
        return o;
      });
    });
  }

  function animate(o, t) {
    var el = o.el, p;
    if (o.anim === "draw") {
      p = outCubic(clamp((t - o.t) / 0.8));
      el.style.opacity = p > 0 ? 1 : 0; el.style.strokeDashoffset = o.len * (1 - p); return;
    }
    if (o.anim === "type") {
      p = outCubic(clamp((t - o.t) / 0.25));
      el.style.opacity = p; el.style.transform = "translateX(" + (1 - p) * 8 + "px)"; return;
    }
    if (o.anim === "tick") {
      p = clamp((t - o.t) / 0.3);
      el.style.opacity = 1; el.classList.toggle("on", p > 0);
      el.style.transform = "scale(" + (p > 0 ? 1 + 0.25 * Math.sin(Math.PI * p) : 1) + ")"; return;
    }
    if (o.anim === "stamp") {
      p = clamp((t - o.t) / 0.42); var e = outCubic(p);
      el.style.opacity = p > 0 ? Math.min(1, p * 2.2) : 0;
      el.style.transform = "scale(" + (1.35 - 0.35 * e) + ") rotate(" + (-5 + 4 * e) + "deg)"; return;
    }
    p = clamp((t - o.t) / 0.5);
    el.style.opacity = p > 0 ? Math.min(1, p * 1.8) : 0;
    el.style.transform = "translateY(" + (1 - outCubic(p)) * 26 + "px) scale(" + (0.9 + 0.1 * outBack(p)) + ")";
  }

  window.seek = function (t) {
    cues.forEach(function (c, k) {
      var el = slides[k], cam = el.firstElementChild, next = cues[k + 1];
      var startsBeat = k === 0 || cues[k - 1].beat !== c.beat, nextBeat = next && next.beat !== c.beat;
      var from = k === 0 ? -1 : c.start - TR, to = next ? next.start : DURATION + 1;
      var vis = t >= from && t < to;
      el.style.visibility = vis ? "visible" : "hidden";
      if (!vis) return;
      var tx = "", op = 1;
      if (k > 0 && t < c.start) {               // coming in: zoom at a new beat, push within one
        var pi = inOut(clamp((t - from) / TR));
        tx = startsBeat ? "scale(" + (0.9 + 0.1 * pi) + ")" : "translateX(" + (1 - pi) * 1920 + "px)";
        op = startsBeat ? pi : 1;
      } else if (next && t > next.start - TR) {   // going out
        var po = inOut(clamp((t - (next.start - TR)) / TR));
        tx = nextBeat ? "scale(" + (1 + 0.12 * po) + ")" : "translateX(" + -po * 1920 + "px)";
        op = nextBeat ? 1 - po : 1;
      }
      el.style.opacity = op; el.style.transform = tx;
      cam.style.transform = "scale(" + (1 + 0.028 * clamp((t - c.start) / ((to - c.start) || 1))) + ")";
      groups[k].forEach(function (o) { animate(o, t); });
    });
    beatSpan.forEach(function (sp, b) {
      segs[b].querySelector("b").style.width = clamp((t - sp[0]) / (sp[1] - sp[0])) * 100 + "%";
      segs[b].classList.toggle("on", t >= sp[0] && t < sp[1]);
    });
  };
  window.DURATION = DURATION;

  // The background never moves, but its blurred glows cost Chrome more than the rest of a frame together. The renderer
  // photographs it alone once (backgroundOnly) and hands the picture back (freezeBackground) to stand in for it.
  var fore = ["brand", "tag", "scenes", "rail"].map(function (id) { return document.getElementById(id); });
  var loaded = new Promise(function (r) { if (document.readyState === "complete") r(); else window.addEventListener("load", function () { r(); }); });
  window.backgroundOnly = function () {
    fore.forEach(function (el) { el.style.opacity = "0"; });
    return loaded;
  };
  window.freezeBackground = function (src) {
    var img = new Image();
    img.src = src;
    return img.decode().then(function () {
      var bg = document.getElementById("bg");
      bg.replaceChildren(img);
      bg.classList.add("frozen");
      fore.forEach(function (el) { el.style.opacity = ""; });
    });
  };

  document.fonts.ready.then(function () {
    slides.forEach(function (slide, i) { layout(slide, scenes[i].s.kind); });
    collect();
    window.seek(0);
    window.STAGE_READY = true;
  });
})();
