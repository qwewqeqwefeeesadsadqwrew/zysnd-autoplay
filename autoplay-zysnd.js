/* ============================================================
   《这有啥难的》自动玩 · 页内脚本
   ------------------------------------------------------------
   依据 2026-10-07\nxbxa-reverse 的 v7 打法（同款拖图配对）：
     · 配对关系从游戏数据直读（大图触发点 itemId = 下排卡 id），不点提示
     · 下排横滑/scrollTo 找卡 → 上提拿起 → 举着 → 对齐 → 松手
     · 时间不足自动点「加时」

   本游戏的结构：
     window.levelView.levelMgr
       .pageView.getPages()          多页大图，每页一组触发点 trigger_<id>
       .answerScrollView.listView    下排卡（虚拟列表，scrollTo(idx) 滚动）
       .foundIdList                  已完成的卡 id
       .puzzleItemCfgList            下排卡顺序（id 列表）

   坐标：canvas CSS 坐标 = 世界坐标 × sc + 居中偏移；y 轴翻转。
   ============================================================ */
(function () {
  var W = window;
  if (W.__ZYSN) { try { W.__ZYSN.stop(); } catch (e) {} }

  var AP = (W.__ZYSN = {
    version: "0.1",
    t0: Date.now(),
    running: true,
    log: [],
    stats: { drags: 0, ok: 0, fail: 0, pages: 0, addTime: 0, addStep: 0, levels: 0 },
    doneLevels: [],   // 已通关的关卡 code，用来做连播和收尾
  });

  function log(m) {
    var s = ((Date.now() - AP.t0) / 1000).toFixed(1) + "s " + m;
    AP.log.push(s);
    if (AP.log.length > 500) AP.log.splice(0, 250);
  }
  AP.logAdd = log;
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function view() { return W.levelView && W.levelView.levelMgr ? W.levelView : null; }
  function mgr() { var v = view(); return v ? v.levelMgr : null; }

  // ---------- 坐标 ----------
  function coords() {
    var cv = document.getElementById("GameCanvas");
    var r = cv.getBoundingClientRect();
    var vs = cc.view.getVisibleSize();
    var sc = Math.min(r.width / vs.width, r.height / vs.height);
    var ox = (r.width - vs.width * sc) / 2;
    var oy = (r.height - vs.height * sc) / 2;
    return {
      cv: cv,
      C: function (wx, wy) {
        return [Math.round(r.left + ox + wx * sc), Math.round(r.top + oy + (vs.height - wy) * sc)];
      },
      sc: sc,
    };
  }
  function ut(n) { return (n._components || []).find(function (c) { return c && typeof c.getBoundingBoxToWorld === "function"; }); }
  function boxCenter(n) {
    // scrollTo 后世界矩阵可能还是旧值：强制更新一遍再取
    try { if (n.updateWorldTransform) n.updateWorldTransform(); } catch (e) {}
    var u = ut(n);
    if (!u) return null;
    var b = u.getBoundingBoxToWorld();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
  }
  // 卡片：getBoundingBoxToWorld 会把 spine/大图子节点也算进去（第 2 页出现过 455×759），
  // 所以卡片的可点位置要用 iconSprite 自己的框。
  function cardCenter(item) {
    var comp = (item._components || []).find(function (x) { return x && x.puzzleItemCfg; });
    var iconNode = comp && comp.iconSprite ? comp.iconSprite.node : null;
    var b = iconNode ? boxCenter(iconNode) : null;
    return b || boxCenter(item);
  }

  // ---------- 输入（技能件 fire-touch.js：鼠标/触摸分流） ----------
  var TOUCH_MODE = null;
  function isTouchMode() {
    if (TOUCH_MODE === null) {
      try { TOUCH_MODE = !!(window.cc && cc.sys && cc.sys.isMobile); } catch (e) { TOUCH_MODE = false; }
    }
    return TOUCH_MODE;
  }
  function makeTouch(cv, x, y, id) {
    var o = { identifier: id, target: cv, clientX: Math.round(x), clientY: Math.round(y),
      pageX: Math.round(x), pageY: Math.round(y), screenX: Math.round(x), screenY: Math.round(y),
      radiusX: 2.5, radiusY: 2.5, rotationAngle: 0, force: 1 };
    try { return new Touch(o); } catch (e) { return o; }
  }
  function fireTouch(cv, type, x, y) {
    var name = type === "mousedown" ? "touchstart" : type === "mouseup" ? "touchend" : type === "mousemove" ? "touchmove" : null;
    if (!name) return;
    var t = makeTouch(cv, x, y, 1);
    var list = name === "touchend" ? [] : [t];
    var ev = null;
    try {
      ev = new TouchEvent(name, { bubbles: true, cancelable: true, view: window, touches: list, targetTouches: list, changedTouches: [t] });
    } catch (e) {
      ev = new CustomEvent(name, { bubbles: true, cancelable: true });
      ev.touches = list; ev.targetTouches = list; ev.changedTouches = [t];
    }
    cv.dispatchEvent(ev);
  }
  function fire(cv, type, x, y, buttons) {
    if (!cv) return;
    if (isTouchMode()) { fireTouch(cv, type, x, y); return; }
    cv.dispatchEvent(new MouseEvent(type, {
      clientX: Math.round(x), clientY: Math.round(y),
      bubbles: true, cancelable: true, view: window,
      button: 0, buttons: buttons,
    }));
  }

  // ---------- 路径（技能件 drag-path.js：二次贝塞尔 + 500px/s 人速） ----------
  var DEFAULT_SPEED = 500, DEFAULT_SAMPLES = 24;
  function quadPoint(p0, cp, p1, t) {
    var u = 1 - t;
    return { x: u * u * p0.x + 2 * u * t * cp.x + t * t * p1.x,
             y: u * u * p0.y + 2 * u * t * cp.y + t * t * p1.y };
  }
  function bezierPath(from, cp, to, samples) {
    var n = Math.max(1, samples || DEFAULT_SAMPLES), pts = [];
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      if (!cp) pts.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
      else pts.push(quadPoint(from, cp, to, t));
    }
    return pts;
  }
  function pathLength(points) {
    var total = 0;
    for (var i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    return total;
  }
  function dragPlan(from, to, opts) {
    var cp = (opts && opts.cp) || null;
    var speed = (opts && opts.speed != null) ? opts.speed : DEFAULT_SPEED;
    if (!(speed > 0)) throw new Error("speed 必须为正");
    var points = bezierPath(from, cp, to, opts && opts.samples);
    var length = pathLength(points);
    return { points: points, length: length, durationMs: Math.round((length / speed) * 1000) };
  }

  // ---------- 打法参数（drag-match.md 第 3 条：落点参数写进配置） ----------
  // 举卡位：以屏幕正中心为底，只往上 / 往左 / 往右浮动，不往下
  var PARK_SPREAD_Y = 0.08;   // 从正中心往上 0~8% 屏幕高（约 0~125 设计像素）
  var PARK_SPREAD_X = 0.05;   // 左右各 ±5% 屏幕宽
  // 落点：卡渲染在手指上方固定 DROP_OFFSET 设计像素 → 手指要落在目标中心下方这么多。
  // 本游戏 PuzzleItemCfg.dragOffsetY 实测恒为 null，这个 60 是逐关试出来的校准值（技能第 3 条的「人眼校准」）。
  var DROP_OFFSET = 60;
  // 每次拿起卡时摇一个新的举卡点，整次拖拽期间不动（只叠加小幅抖动）
  var curPark = null;
  function pickPark() {
    var c = coords();
    var vs = cc.view.getVisibleSize();
    var wx = vs.width / 2 + (Math.random() * 2 - 1) * PARK_SPREAD_X * vs.width;
    // 世界坐标 y 越大越靠上 → 只加不减，就是只往上浮动
    var wy = vs.height / 2 + Math.random() * PARK_SPREAD_Y * vs.height;
    var p = c.C(wx, wy);
    return [Math.round(p[0]), Math.round(p[1])];
  }
  function parkPos() {
    if (!curPark) curPark = pickPark();
    return curPark;
  }

  // 分帧平滑移动（贝塞尔弧线 + 人速），绝不瞬移
  async function glide(x0, y0, x1, y1, speed) {
    var c = coords();
    var cp = {
      x: (x0 + x1) / 2 + (Math.random() * 2 - 1) * 22,
      y: (y0 + y1) / 2 + (Math.random() * 2 - 1) * 14,
    };
    var plan = dragPlan({ x: x0, y: y0 }, { x: x1, y: y1 }, { cp: cp, speed: speed || 480, samples: 22 });
    var per = Math.max(14, plan.durationMs / plan.points.length);
    for (var i = 1; i < plan.points.length; i++) {
      await sleep(per);
      fire(c.cv, "mousemove", Math.round(plan.points[i].x), Math.round(plan.points[i].y), 1);
    }
  }

  // 拿起：悬停 → mousedown → 6×26px 渐进上提（>50px 才生效）→ 平滑移到举卡位
  async function liftCard(item) {
    var c = coords();
    var ib = cardCenter(item);
    if (!ib) return null;
    curPark = pickPark();          // 这一把举多高，随机定
    var sp = c.C(ib.x, ib.y);
    var park = parkPos();
    fire(c.cv, "mousemove", sp[0], sp[1], 0);
    await sleep(150 + Math.random() * 80);
    fire(c.cv, "mousedown", sp[0], sp[1], 1);
    await sleep(70 + Math.random() * 40);
    // 上提 156px，每步 30~42ms ≈ 620~870px/s
    for (var k = 1; k <= 6; k++) {
      fire(c.cv, "mousemove", sp[0], sp[1] - k * 26, 1);
      await sleep(30 + Math.random() * 12);
    }
    // 从拿起位置平滑走到举卡位（约 500px/s，真人手速），不是闪过去
    await glide(sp[0], sp[1] - 156, park[0], park[1], 520);
    await sleep(100);
    AP.lastPark = park;            // 便于外部核对举卡位是否在中心附近随机
    return { sp: sp, park: park };
  }

  // 举着等目标页：大图自己会翻（实测约 1 秒一页、向后循环），全程不许手动翻页抢方向
  // 规则：就算目标就在当前这页，也要举着等大图翻走、转一圈回来再放，不在原地直接配
  async function holdAndDrop(trig, targetPage, maxWaitMs) {
    var m = mgr();
    var pv = m && m.pageView;
    if (!pv) return { ok: false, why: "no-pageview" };
    var c = coords();

    var pickupPage = pv.getCurrentPageIndex();   // 拿起卡时停在哪一页
    var turnedAway = false;                      // 是否已经翻离过拿起那一页
    var t1 = Date.now(), prev = null, k = 0, seen = [];
    while (Date.now() - t1 < maxWaitMs) {
      if (!AP.running) return { ok: false, why: "stopped" };
      var idx = pv.getCurrentPageIndex();
      if (idx !== pickupPage) turnedAway = true;
      var scrolling = pv.isScrolling ? pv.isScrolling() : false;
      // 目标就在拿起的那一页时，必须先等它翻走再转回来
      var mustWaitTurn = (targetPage === pickupPage) && !turnedAway;
      var tb = (idx === targetPage && !scrolling && !mustWaitTurn && trig.activeInHierarchy) ? boxCenter(trig) : null;
      if (tb) {
        // 落点：目标中心再往下 DROP_OFFSET（卡在手指上方，手指得有这个补偿）
        var dp = c.C(tb.x, tb.y - DROP_OFFSET);
        if (prev && Math.abs(dp[0] - prev[0]) <= 6 && Math.abs(dp[1] - prev[1]) <= 6) {
          // 从举卡位平滑移到落点（约 460px/s），不是一帧闪过去
          var pk3 = parkPos();
          await glide(pk3[0], pk3[1], dp[0], dp[1], 460);
          await sleep(110 + Math.random() * 70);
          // 移动这段时间大图可能已经翻走，落点要重新校验
          var idx2 = pv.getCurrentPageIndex();
          var tb2 = (idx2 === targetPage) ? boxCenter(trig) : null;
          if (tb2 && Math.abs(tb2.x - tb.x) * c.sc <= 12 && Math.abs(tb2.y - tb.y) * c.sc <= 12) {
            fire(c.cv, "mouseup", dp[0], dp[1], 0);
            await sleep(650);
            return { ok: true, waited: Date.now() - t1, circle: (targetPage === pickupPage) };
          }
          prev = null;
          continue;
        }
        prev = dp;
        await sleep(150);
        continue;
      }
      prev = null;
      k++;
      if (seen.length < 20 && seen[seen.length - 1] !== idx) seen.push(idx);
      // 手一直在小幅抖动（举着不是定住）
      var pk = parkPos();
      var dx = Math.round(20 * Math.sin(k * 0.33));
      var dy = Math.round(25 * Math.sin(k * 0.21 + 1));
      fire(c.cv, "mousemove", pk[0] + dx, pk[1] + dy, 1);
      await sleep(170);
    }
    var pk2 = parkPos();
    fire(c.cv, "mousemove", pk2[0], pk2[1], 1);
    await sleep(90);
    fire(c.cv, "mouseup", pk2[0], pk2[1], 0);
    await sleep(700);
    return { ok: false, why: "超时 " + Math.round(maxWaitMs / 1000) + "s，到过 " + JSON.stringify(seen) };
  }

  // ---------- 滑列表找卡（技能打法 2 第一句）----------
  // 坑位：ScrollView/view 的 bbox 是**内容总宽**（实测 9835），不是可视窗口。
  // 可视窗口必须用 ScrollView 外层节点（实测 x=362 w=720），否则滑动起点会落到屏幕外。
  function swipeWindow() {
    var m = mgr();
    var sv = m && m.answerScrollView;
    if (!sv) return null;
    var b = boxCenter(sv.node);
    if (!b) return null;
    var c = coords();
    return [c.C(b.x - b.w / 2, b.y)[0], c.C(b.x + b.w / 2, b.y)[0]];
  }
  // 真人横滑：悬停 → 按下 → 分帧滑动（带加速度曲线）→ 停 → 松手
  // 手指速度约 450~600px/s，滑完让惯性自己走完再动，绝不瞬移
  async function swipeRow(fromX, y, dx) {
    var c = coords();
    fire(c.cv, "mousemove", fromX, y, 0);
    await sleep(140 + Math.random() * 60);
    fire(c.cv, "mousedown", fromX, y, 1);
    await sleep(40);
    var N = 12;
    for (var i = 1; i <= N; i++) {
      // 前段加速、后段减速（ease-in-out），像真人手指起落
      var t = i / N;
      var e = t * t * (3 - 2 * t);
      fire(c.cv, "mousemove", fromX + dx * e, y + Math.round(Math.sin(t * Math.PI) * 3), 1);
      await sleep(24 + Math.random() * 8);
    }
    await sleep(90 + Math.random() * 60);
    fire(c.cv, "mouseup", fromX + dx, y, 0);
    await sleep(900 + Math.random() * 400);
  }
  function rowY() {
    var m = mgr();
    var sv = m && m.answerScrollView;
    var b = sv ? boxCenter(sv.node) : null;
    if (!b) return Math.round(window.innerHeight * 0.85);
    return coords().C(b.x, b.y)[1];
  }
  // 起点必须落在两卡之间的空隙，落在卡上就变成「拿起卡」而不是「滑列表」
  function gapX(vis, midX, col) {
    var xs = vis.map(function (v) { return boxCenter(v.node); })
      .filter(function (b) { return b; })
      .map(function (b) { return coords().C(b.x, b.y)[0]; })
      .sort(function (a, b) { return a - b; });
    var left = null, right = null;
    for (var i = 0; i < xs.length; i++) {
      if (xs[i] <= midX) left = xs[i];
      if (xs[i] >= midX && right === null) right = xs[i];
    }
    var g = midX;
    if (left !== null && right !== null && right - left > 20) g = Math.round((left + right) / 2);
    else if (left !== null && Math.abs(left - midX) < 25) g = midX + 40;
    if (col) g = Math.max(col[0] + 20, Math.min(col[1] - 20, g));
    return g;
  }
  // 滑列表找卡：全程真人横滑，卡没露头就一小段一小段滑，绝不瞬移
  async function ensureCardInWindow(id) {
    var m = mgr();
    var sv = m && m.answerScrollView;
    var ids = (sv && sv.puzzleItemCfgList) ? sv.puzzleItemCfgList.map(function (x) { return x.id; }) : [];
    var targetIdx = ids.indexOf(id);
    var col = swipeWindow();
    var mid = col ? Math.round((col[0] + col[1]) / 2) : 0;

    for (var guard = 0; guard < 8; guard++) {
      var vis = visibleIds();
      var hit = vis.filter(function (v) { return v.id === id; })[0];

      if (hit) {
        var b = boxCenter(hit.node);
        if (!b) { await sleep(300); continue; }
        var p = coords().C(b.x, b.y);
        if (!col) return hit;
        // 已在窗口舒适区 → 停一下让它稳定，确认还在就直接用
        if (p[0] >= col[0] + 45 && p[0] <= col[1] - 45) {
          await sleep(320 + Math.random() * 200);
          var again = visibleIds().filter(function (v) { return v.id === id; })[0];
          if (again) return again;
          continue;
        }
        // 露出来了但贴边 → 小幅横滑挪到中间
        var dx = Math.max(-160, Math.min(160, mid - p[0]));
        await swipeRow(gapX(vis, mid, col), p[1], dx);
        continue;
      }

      // 还没露头：判断在左边还是右边，滑一屏的 55~75%
      if (!col) return null;
      var visIdxs = vis.map(function (v) { return ids.indexOf(v.id); }).filter(function (i) { return i >= 0; });
      var dir = -1;
      if (visIdxs.length && targetIdx >= 0) {
        var minI = Math.min.apply(null, visIdxs);
        var maxI = Math.max.apply(null, visIdxs);
        dir = targetIdx > maxI ? -1 : (targetIdx < minI ? 1 : -1);
      }
      var span = col[1] - col[0];
      var dist = Math.round(span * (0.55 + Math.random() * 0.2));
      await swipeRow(gapX(vis, mid, col), rowY(), dir * dist);
    }
    return visibleIds().filter(function (v) { return v.id === id; })[0] || null;
  }

  // 起手前等卡停稳（技能模板：连续两次位移 ≤2px 才算稳定，否则拿不准）
  async function settleCard(item) {
    var a = cardCenter(item);
    for (var i = 0; i < 6; i++) {
      await sleep(260);
      var b = cardCenter(item);
      if (a && b && Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2) return b;
      a = b;
    }
    return a;
  }

  async function dragCard(item, trig, targetPage) {
    sweepPopups();
    await settleCard(item);
    var lifted = await liftCard(item);
    if (!lifted) return false;
    var r = await holdAndDrop(trig, targetPage, 60000);
    if (!r.ok) log("     ✗ " + r.why);
    else if (r.circle) log("     （目标就在当前页 → 举着等它翻了一圈）" + Math.round(r.waited / 1000) + "s");
    return r.ok;
  }

  // ---------- 弹窗清理（技能坑位：自动弹出面板挡路，点击前先 sweep） ----------
  function sweepPopups() {
    if (!W.cc || !cc.director || !cc.director.getScene) return;
    var scene = null;
    try { scene = cc.director.getScene(); } catch (e) { return; }
    if (!scene) return;
    var hits = [];
    (function walk(n) {
      if (!n) return;
      if (!n.activeInHierarchy) return;
      var nm = String(n.name || "");
      if (/^(ReliveView|LevelFailView|LevelAddTimeView|LevelAddStepView|UI_AddStep|UI_AddTime|AddStepView|AddTimeView|UI_AddError)/.test(nm)) hits.push(n);
      (n.children || []).forEach(walk);
    })(scene);
    for (var i = 0; i < hits.length; i++) {
      var nd = hits[i];
      var comps = nd._components || [];
      var closed = false;
      for (var j = 0; j < comps.length; j++) {
        var c = comps[j];
        try {
          if (c && typeof c.closeThis === "function") { c.closeThis(); closed = true; break; }
          if (c && typeof c.hideBack === "function") { c.hideBack(); if (c.hideAni) c.hideAni(); c.isOpen = false; closed = true; break; }
        } catch (e) {}
      }
      if (!closed) { try { nd.active = false; } catch (e) {} }
      log("关弹窗 " + nd.name);
    }
    if (hits.length) {
      var lv = view();
      if (lv && lv.gameState !== 1) {
        try { lv.setGameState(1); log("恢复 Playing"); } catch (e) {}
      }
    }
  }

  // ---------- 关卡状态 ----------
  function found() {
    var m = mgr();
    return (m && m.foundIdList) ? m.foundIdList.slice() : [];
  }
  function curPage() {
    var m = mgr();
    if (!m || !m.pageView) return null;
    return m.pageView.getPages()[m.curPageIndex] || null;
  }
  function pageTriggers(page) {
    var out = [];
    (function walk(n) {
      if (!n) return;
      var c = (n._components || []).find(function (x) { return x && typeof x.itemId === "string"; });
      if (c && /^trigger/.test(n.name)) out.push({ id: c.itemId, node: n });
      (n.children || []).forEach(walk);
    })(page);
    return out;
  }
  function scrollContent() {
    var m = mgr();
    var sv = m && m.answerScrollView;
    if (!sv) return null;
    var sc = sv.node.getChildByName("ScrollView");
    var v = sc && sc.getChildByName("view");
    return v && v.getChildByName("content");
  }
  function visibleIds() {
    var content = scrollContent();
    if (!content) return [];
    var out = [];
    for (var i = 0; i < content.children.length; i++) {
      var ch = content.children[i];
      var cp = (ch._components || []).find(function (x) { return x && x.puzzleItemCfg; });
      if (cp) out.push({ id: cp.puzzleItemCfg.id, node: ch });
    }
    return out;
  }
  async function scrollToId(id) {
    var m = mgr();
    var sv = m && m.answerScrollView;
    if (!sv || !sv.listView || !sv.puzzleItemCfgList) return false;
    var ids = sv.puzzleItemCfgList.map(function (x) { return x.id; });
    var idx = ids.indexOf(id);
    if (idx < 0) return false;
    try {
      // 模板坑：折叠在列表外的卡点不到 → 先滚到底让真实 item 建出来，再滚到目标
      sv.listView.scrollTo(ids.length - 1, 0.05);
      await sleep(120);
      sv.listView.scrollTo(idx, 0.15);
      return true;
    } catch (e) { return false; }
  }

  // ---------- 按钮：加时 / 加步 ----------
  function findBtn(name) {
    var lv = view();
    if (!lv) return null;
    var ui = lv.node.getChildByName("UILayer");
    var layout = ui && ui.getChildByName("layout");
    if (!layout) return null;
    var b = layout.getChildByName(name);
    return (b && b.activeInHierarchy) ? b : null;
  }
  async function tapNode(node) {
    var c = coords();
    var b = boxCenter(node);
    if (!b) return false;
    var p = c.C(b.x, b.y);
    fire(c.cv, "mousedown", p[0], p[1], 1);
    await sleep(90 + Math.random() * 40);
    fire(c.cv, "mouseup", p[0], p[1], 0);
    await sleep(500);
    return true;
  }
  // 技能打法 4 · 口径 B：开局不点，真失误（errNum≤2）自动补一次
  async function addSteps() {
    var lv = view();
    if (!lv) return false;
    var before = lv.errorCountLimit || 0;
    // 先点游戏自己的「加步」按钮，等它自己回包
    var btn = findBtn("addErrorCountBtn");
    if (btn) {
      await tapNode(btn);
      await sleep(1200);
      var lv2 = view() || lv;
      if ((lv2.errorCountLimit || 0) > before) {
        AP.stats.addStep++;
        log("加步(按钮) -> " + lv2.errorCountLimit);
        return true;
      }
    }
    // 本地没有广告可看，按钮回不来 → 直补运行时值（踩坑见交付说明）
    lv.errorCountLimit = before + 20;
    try { lv.updateErrorLabel && lv.updateErrorLabel(); } catch (e) {}
    AP.stats.addStep++;
    log("加步(本地无广告，直补) -> " + lv.errorCountLimit);
    return true;
  }

  // ---------- 加时 ----------
  function addTime() {
    var c = coords();
    // 先看是否弹了「时间已耗尽」框，点里面的「加时」
    var overlays = [];
    (function walk(n) {
      if (!n) return;
      if (/AddTime|加时/i.test(n.name) && n.activeInHierarchy) overlays.push(n);
      (n.children || []).forEach(walk);
    })(cc.director.getScene());
    if (overlays.length) {
      var ob = boxCenter(overlays[0]);
      if (ob) {
        var p = c.C(ob.x, ob.y);
        fire(c.cv, "mousedown", p[0], p[1], 1);
        setTimeout(function () { fire(c.cv, "mouseup", p[0], p[1], 0); }, 90);
        AP.stats.addTime++;
        return true;
      }
    }
    return false;
  }

  // ---------- 主循环 ----------
  // 全部页的待办；带 steps = 大图还要几页才转到这里（成品 arriveOrder 同思路）
  // 实测：大图约 1 秒翻一页、向后循环，所以拿「最快到达」的卡举着时间最短
  function pendingJobs() {
    var m = mgr();
    if (!m || !m.pageView) return [];
    var done = found();
    var pv = m.pageView;
    var n = pv.getPages().length;
    var cur = pv.getCurrentPageIndex();
    var jobs = [];
    pv.getPages().forEach(function (pg, pi) {
      var steps = (((pi - cur) % n) + n) % n;
      pageTriggers(pg).forEach(function (t) {
        if (done.indexOf(t.id) < 0) jobs.push({ page: pi, trig: t, steps: steps });
      });
    });
    return jobs;
  }

  // 按 id 反查目标触发点（在哪个大图页、哪个节点）
  function findTrigger(id) {
    var m = mgr();
    if (!m || !m.pageView) return null;
    var pages = m.pageView.getPages();
    for (var pi = 0; pi < pages.length; pi++) {
      var ts = pageTriggers(pages[pi]);
      for (var i = 0; i < ts.length; i++) {
        if (ts[i].id === id) return { node: ts[i].node, page: pi };
      }
    }
    return null;
  }

  // 下排没得做时滑一下，让后面的卡露出来（真人横滑，不瞬移）
  async function revealMoreCards(done) {
    var m = mgr();
    var sv = m && m.answerScrollView;
    var allIds = (sv && sv.puzzleItemCfgList) ? sv.puzzleItemCfgList.map(function (x) { return x.id; }) : [];
    var col = swipeWindow();
    if (!col || !allIds.length) { await sleep(500); return; }

    var vis = visibleIds();
    var visIdxs = vis.map(function (v) { return allIds.indexOf(v.id); }).filter(function (i) { return i >= 0; });
    var dir = -1;
    if (visIdxs.length) {
      var maxI = Math.max.apply(null, visIdxs);
      // 后面还有没做的卡 → 往后滑；后面都做完了 → 往前滑
      var more = false;
      for (var i = maxI + 1; i < allIds.length; i++) {
        if (done.indexOf(allIds[i]) < 0) { more = true; break; }
      }
      dir = more ? -1 : 1;
    }
    var mid = Math.round((col[0] + col[1]) / 2);
    var span = col[1] - col[0];
    await swipeRow(gapX(vis, mid, col), rowY(), dir * Math.round(span * (0.6 + Math.random() * 0.15)));
  }

  // 打法：只从当前露出来的那几张里随机拿，举着等它目标页转过来就放
  // 下排不主动翻找，做完卡自己空出来，全做完了才滑一下露出后面的
  async function solvePage() {
    if (!mgr()) return false;
    var failCount = {};
    for (var guard = 0; guard < 400; guard++) {
      if (!AP.running) return false;
      // 技能打法 6：单轮 try-catch，读状态落空/翻页中异常不能让整关崩掉
      try {
        fixLevelTitle();   // 游戏偶尔会自己重刷标题，每轮补一刀
        var done = found();
        // 可见的卡里挑还没做完的；老失败的先歇一歇，避免死磕同一张
        var cands = visibleIds().filter(function (v) {
          if (done.indexOf(v.id) >= 0) return false;
          return (failCount[v.id] || 0) < 2;
        });

        if (!cands.length) {
          if (!pendingJobs().length) return true;   // 全做完了
          await revealMoreCards(done);
          continue;
        }

        var pick = cands[Math.floor(Math.random() * cands.length)];
        var t = findTrigger(pick.id);
        if (!t) { log("找不到目标 " + pick.id); await sleep(400); continue; }

        await dragCard(pick.node, t.node, t.page);
        AP.stats.drags++;
        if (found().indexOf(pick.id) >= 0) {
          AP.stats.ok++;
          log("OK " + pick.id + "（可见 " + cands.length + " 张里随手拿的）");
        } else {
          AP.stats.fail++;
          failCount[pick.id] = (failCount[pick.id] || 0) + 1;
          log("FAIL " + pick.id + " 第" + failCount[pick.id] + "次");
          await sleep(300);
        }
        await sleep(120 + Math.random() * 180);
      } catch (e) {
        log("单轮异常：" + ((e && e.message) || e) + "，稍后继续");
        await sleep(900);
      }
    }
    return true;
  }

  async function turnPage(dir) {
    var m = mgr();
    if (!m || !m.pageView) return false;
    var pv = m.pageView;
    var cur = pv.getCurrentPageIndex ? pv.getCurrentPageIndex() : 0;
    var n = pv.getPages().length;
    var next = cur + dir;
    if (next < 0 || next >= n) return false;
    try { pv.scrollToPage(next, 0.3); return true; } catch (e) { return false; }
  }

  // 全部页的触发点合集（通关判定用它，而不是只看当前页）
  function allTriggerIds() {
    var m = mgr();
    if (!m || !m.pageView) return [];
    var out = [];
    m.pageView.getPages().forEach(function (p) {
      pageTriggers(p).forEach(function (t) { out.push(t.id); });
    });
    return out;
  }
  function allDone() {
    var all = allTriggerIds();
    var done = found();
    for (var i = 0; i < all.length; i++) if (done.indexOf(all[i]) < 0) return false;
    return all.length > 0;
  }
  // 找到第一个还有未完成项的页索引；没有则返回 -1
  function firstUnfinishedPage() {
    var m = mgr();
    if (!m || !m.pageView) return -1;
    var done = found();
    var pages = m.pageView.getPages();
    for (var i = 0; i < pages.length; i++) {
      var left = pageTriggers(pages[i]).filter(function (t) { return done.indexOf(t.id) < 0; });
      if (left.length) return i;
    }
    return -1;
  }

  // ---------- 大厅：自动进关 ----------
  function findLevelCards() {
    var scene = cc.director.getScene();
    var out = [];
    (function walk(n) {
      if (!n) return;
      if (n.name === "levelItem4" && n.activeInHierarchy) {
        var b = boxCenter(n);
        if (b && b.w > 50) out.push({ node: n, box: b, y: b.y });
      }
      (n.children || []).forEach(walk);
    })(scene);
    out.sort(function (a, b) { return b.y - a.y || a.box.x - b.box.x; });
    return out;
  }
  async function enterLevel(idx) {
    var cards = findLevelCards();
    if (!cards.length) return false;
    var card = cards[idx % cards.length];
    var c = coords();
    var p = c.C(card.box.x, card.box.y);
    fire(c.cv, "mousedown", p[0], p[1], 1);
    await sleep(90 + Math.random() * 40);
    fire(c.cv, "mouseup", p[0], p[1], 0);
    log("进关 #" + (idx % cards.length) + " @" + Math.round(card.box.x) + "," + Math.round(card.box.y));
    return true;
  }

  // ---------- 关卡标题：把「第N页-关卡名」改成「关卡-关卡名」 ----------
  // 必须用 W.levelView 而不是 view()：view() 要求 levelMgr 已存在，
  // 那时游戏早就把「第N页」画出来了，会闪一下。
  function liveLevelView() {
    var lv = W.levelView;
    return (lv && lv.node) ? lv : null;
  }
  function fixLevelTitle() {
    try {
      var lv = liveLevelView();
      if (!lv || !lv.levelNameLabel) return;
      var cfg = lv.levelCfg;
      if (!cfg || !cfg.levelName) return;
      var want = "关卡-" + cfg.levelName;
      if (lv.levelNameLabel.string !== want) lv.levelNameLabel.string = want;
    } catch (e) {}
  }
  // 游戏自己会调 updateIndexLabel 重刷标题（翻页等场景），必须 hook 住
  function hookLevelTitle() {
    var lv = liveLevelView();
    if (!lv || lv.__apTitleHooked) return;
    var orig = lv.updateIndexLabel;
    if (typeof orig !== "function") return;
    lv.updateIndexLabel = function () {
      try { orig.call(this); } catch (e) {}
      try {
        var nm = (this.levelCfg && this.levelCfg.levelName) || "";
        if (this.levelNameLabel && nm) this.levelNameLabel.string = "关卡-" + nm;
      } catch (e) {}
    };
    lv.__apTitleHooked = true;
    fixLevelTitle();
  }

  // ---------- 洗牌式关卡随机（《我来掌勺》同款） ----------
  // 5 关一轮 Fisher-Yates 洗牌，不重复；打完一轮重新洗，无限循环。
  // 用游戏自己的 loadLevelWithLevelCode 直接跳关，不回主页，一关接一关。
  var LEVEL_CODES = ["yxlg", "gzxg", "htsm", "slhz", "zjhy"]; // 玉匣流光/公主鞋柜/花钿拾梦/十里红妆/指尖花漾
  var shuffleQueue = [];
  function shuffleArr(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function nextShuffleCode() {
    if (!shuffleQueue.length) {
      shuffleQueue = shuffleArr(LEVEL_CODES.slice());
      log("新一轮洗牌：" + shuffleQueue.join(" → "));
    }
    return shuffleQueue.shift();
  }
  function getLevelHelper() {
    try {
      var m = System.get("chunks:///_virtual/LevelHelper.ts");
      return m && m.LevelHelper ? m.LevelHelper : null;
    } catch (e) { return null; }
  }
  // 直接跳关；成功返回 true
  function jumpToLevel(code) {
    var H = getLevelHelper();
    if (!H || typeof H.loadLevelWithLevelCode !== "function") return false;
    try { H.loadLevelWithLevelCode(code); return true; }
    catch (e) { log("跳关异常：" + ((e && e.message) || e)); return false; }
  }

  // 通关弹窗里的按钮（levelSucView4/content/<btnName>）
  // nextLevelBtn = 下一关；An_return = 返回。弹窗是异步弹出的，调用方要轮询等。
  function findSucBtn(btnName) {
    if (!W.cc || !cc.director || !cc.director.getScene) return null;
    var s = null;
    try { s = cc.director.getScene(); } catch (e) { return null; }
    if (!s) return null;
    var v = null;
    (function w(n) {
      if (!n || v) return;
      if (/^levelSucView/i.test(n.name) && n.activeInHierarchy) { v = n; return; }
      (n.children || []).forEach(w);
    })(s);
    if (!v) return null;
    var c = v.getChildByName("content");
    var b = c && c.getChildByName(btnName);
    return (b && b.activeInHierarchy) ? b : null;
  }

  // 轮询等按钮出现（通关弹窗比 allDone 晚，实测要等到 2~6 秒）
  async function waitSucBtn(btnName, tries) {
    for (var i = 0; i < (tries || 20); i++) {
      var b = findSucBtn(btnName);
      if (b) return b;
      await sleep(500);
    }
    return null;
  }

  async function main() {
    log("自动玩启动");
    var lastTimeCheck = Date.now();
    var lastStepCheck = Date.now();
    // 开局也是随机的（之后全部走洗牌跳关，不回主页）
    var levelIdx = Math.floor(Math.random() * 5);
    // 调试用：?start=N 固定从第 N 张关卡卡片开跑（正式链接不带参数）
    try {
      var qm = (location.search || "").match(/[?&]start=(\d+)/);
      if (qm) levelIdx = parseInt(qm[1], 10) || 0;
    } catch (e) {}
    var lastLevelCode = null;
    var wasPlaying = false;
    while (AP.running) {
      // 先清弹窗（加步/加时/失败窗会 setGameState(End)，晚清就会被当成「不在关卡里」）
      sweepPopups();
      var lvNow = view();
      // 不在关卡里 → 回大厅
      if (!lvNow || lvNow.gameState !== 1) {
        if (wasPlaying) {
          wasPlaying = false;
          var lastFound = (lvNow && lvNow.levelMgr && lvNow.levelMgr.foundIdList) ? lvNow.levelMgr.foundIdList.length : 0;
          var lastAll = (lvNow && lvNow.levelMgr && lvNow.levelMgr.pageView)
            ? (function () {
                var n = 0;
                lvNow.levelMgr.pageView.getPages().forEach(function (p) {
                  (function w(x) { if (!x) return; var c = (x._components || []).find(function (y) { return y && typeof y.itemId === "string"; }); if (c && /^trigger/.test(x.name)) n++; (x.children || []).forEach(w); })(p);
                });
                return n;
              })()
            : 0;
          if (lastAll > 0 && lastFound < lastAll) {
            log("本关未完成 " + lastFound + "/" + lastAll + " → 重开本关");
            // 不递增 levelIdx，重打这一关
          } else {
            levelIdx++;
          }
          await sleep(1500);
        }
        await sleep(800);
        var ok = await enterLevel(levelIdx);
        if (ok) await sleep(5000);
        continue;
      }
      if (!wasPlaying) {
        wasPlaying = true;
        // 技能打法 4 · 口径 B：开局不点加步，等真到 errNum≤2 再补
        await sleep(800);
        // 关卡标题改「关卡-关卡名」
        hookLevelTitle();
        fixLevelTitle();
        // 免倒计时兜底：GMProxy 开关若晚于关卡 onLoad 生效，这里补一刀把时间 UI 关掉
        try {
          var tv = view();
          if (tv) {
            tv.isTimeLimit = false;
            var ui = tv.node.getChildByName("UILayer");
            var top = ui && ui.getChildByName("topWeight");
            var tn = top && top.getChildByName("timeNode");
            if (tn) tn.active = false;
          }
        } catch (e) {}
      }
      var m = mgr();
      var v = lvNow;
      if (!m || !v || v.gameState !== 1) { await sleep(500); continue; }

      // 时间维护：加时按钮要看完广告才生效，本地没广告 → 直接补 remainTime
      if (Date.now() - lastTimeCheck > 2000) {
        lastTimeCheck = Date.now();
        try {
          if (v.remainTime < 60) {
            v.remainTime = 600;
            AP.stats.addTime++;
            log("补时间 -> 600s");
          }
        } catch (e) {}
      }
      // 错误次数维护：剩余可用 ≤2 就补（读运行时 errorCountLimit / curErrorCount）
      if (Date.now() - lastStepCheck > 4000) {
        lastStepCheck = Date.now();
        try {
          var lv2 = view();
          var lim = lv2 ? (lv2.errorCountLimit || 0) : 0;
          var cur2 = lv2 ? (lv2.curErrorCount || 0) : 0;
          if (lim > 0 && (lim - cur2) <= 2) await addSteps();
        } catch (e) {}
      }

      await solvePage();
      if (!AP.running) break;

      // 通关判定：所有页的所有触发点都完成 → 点「下一关」继续，不要结束整个 main
      if (allDone()) {
        var total = allTriggerIds().length;
        var curCode = (lvNow.levelCfg && lvNow.levelCfg.code) || String(levelIdx);
        if (AP.doneLevels.indexOf(curCode) < 0) AP.doneLevels.push(curCode);
        if (AP.doneLevels.length > 40) AP.doneLevels.splice(0, 20);
        AP.stats.levels++;
        log("全部完成 " + found().length + "/" + total +
            "（累计通关 " + AP.stats.levels + " 关）");

        // 展示节奏：通关画面停一下再走（用户要的观赏效果）
        await sleep(2200 + Math.random() * 1600);

        // 洗牌下一关：直接用游戏的加载接口跳关，不回主页
        var nx = nextShuffleCode();
        if (jumpToLevel(nx)) {
          log("洗牌跳关 → " + nx);
          await sleep(5500 + Math.random() * 2000);
        } else {
          log("跳关接口不可用，走通关弹窗按钮兜底");
          var nextBtn = await waitSucBtn("nextLevelBtn", 24);
          if (!nextBtn) nextBtn = await waitSucBtn("An_return", 8);
          if (nextBtn) {
            await sleep(700);
            await tapNode(nextBtn);
            log("点「" + nextBtn.name + "」继续");
            await sleep(2500);
            var chk = view();
            var chkCode = (chk && chk.levelCfg && chk.levelCfg.code) || null;
            if (chkCode === curCode) {
              await sleep(1200);
              var b2 = await waitSucBtn("nextLevelBtn", 10);
              if (b2) { await tapNode(b2); await sleep(2500); }
            }
          } else {
            log("等不到通关弹窗按钮，原地重试");
            await sleep(2000);
          }
        }
        levelIdx++;
        wasPlaying = false;   // 让主循环重新走「进关 / 已经在关卡里」的判断
        continue;
      }

      // 找下一个还有未完成项的页，翻过去
      var needIdx = firstUnfinishedPage();
      var m2 = mgr();
      var curIdx = m2.pageView.getCurrentPageIndex();
      if (needIdx >= 0 && needIdx !== curIdx) {
        AP.stats.pages++;
        log("翻页 -> " + needIdx);
        try { m2.pageView.scrollToPage(needIdx, 0.3); } catch (e) {}
        await sleep(900);
      } else {
        await sleep(300);
      }
    }
    log("结束");
  }

  AP.stop = function () { AP.running = false; };
  AP.status = function () {
    return JSON.stringify({ running: AP.running, stats: AP.stats, log: AP.log.slice(-15) });
  };
  // 等 cc 引擎就绪再起；main 挂了要能自己拉起来（否则整局静默死掉）
  function boot() {
    if (!W.cc || !cc.director || !cc.director.getScene) { setTimeout(boot, 300); return; }
    // 标题守护：levelView 一出现就 hook，不等主循环（否则会闪一下「第N页」）
    if (!W.__apTitleTimer) {
      W.__apTitleTimer = setInterval(function () {
        if (!AP.running) { clearInterval(W.__apTitleTimer); W.__apTitleTimer = null; return; }
        try { hookLevelTitle(); fixLevelTitle(); } catch (e) {}
      }, 80);
    }
    try {
      var p = main();
      if (p && typeof p.catch === "function") {
        p.catch(function (e) {
          log("main 异常: " + ((e && e.message) || e));
          if (AP.running) setTimeout(boot, 1000);
        });
      }
    } catch (e) {
      log("main 同步异常: " + ((e && e.message) || e));
      if (AP.running) setTimeout(boot, 1000);
    }
  }
  boot();
})();
