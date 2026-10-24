// 直播助手守护脚本
// 1) 「自动翻页」始终为开
// 2) 签到弹窗从源头关掉：直接把 enableClaimRewardToday 固定为 false。
//    （上一版是弹出来再隐藏节点，会把全屏半透明遮罩留在最上层，导致整个大厅点不动）
(function () {
  var tries = 0;
  var patched = false;

  function patchSignIn() {
    if (patched) return true;
    try {
      if (typeof System === 'undefined' || !System.get) return false;
      var m = System.get('chunks:///_virtual/SignInProxy.ts');
      var P = m && m.default;
      if (!P || !P.prototype) return false;
      P.prototype.enableClaimRewardToday = function () { return false; };
      P.prototype.enableClaimReward = function () { return false; };
      if (P.isShow !== undefined) P.isShow = false;
      patched = true;
      return true;
    } catch (e) { return false; }
  }

  // 兜底：万一已经弹出来（旧存档/时序问题），只关弹窗本体、不碰它下面的遮罩，
  // 通过游戏自己的 closeThis / hideBack 正常关闭，避免留下吃点击的透明层。
  function closeIfOpen() {
    try {
      if (!window.cc || !cc.director || !cc.director.getScene) return;
      var scene = cc.director.getScene();
      if (!scene) return;
      var hits = [];
      (function walk(n) {
        if (!n) return;
        if (/^UI_SignIn$|^SignInView$/i.test(n.name) && n.activeInHierarchy) hits.push(n);
        var kids = n.children || [];
        for (var i = 0; i < kids.length; i++) walk(kids[i]);
      })(scene);
      for (var i = 0; i < hits.length; i++) {
        var nd = hits[i];
        var comps = nd._components || [];
        var closed = false;
        for (var j = 0; j < comps.length; j++) {
          var c = comps[j];
          try {
            if (c && typeof c.closeThis === 'function') { c.closeThis(); closed = true; break; }
            if (c && typeof c.hideBack === 'function') { c.hideBack(); if (c.hideAni) c.hideAni(); c.isOpen = false; closed = true; break; }
          } catch (e) {}
        }
        if (!closed) { try { nd.active = false; } catch (e) {} }
      }
    } catch (e) {}
  }

  var timer = setInterval(function () {
    tries++;
    try {
      if (typeof System === 'undefined' || !System.get) return;
      var mod = System.get('chunks:///_virtual/GMProxy.ts');
      var P = mod && mod.GMProxy;
      if (P && P.model) {
        var dirty = false;
        if (P.model.enableAutoNextPage2 !== true) { P.model.enableAutoNextPage2 = true; dirty = true; }
        // 免倒计时：LevelView 里 isNoCountDown() 读的就是这个开关（false = 关掉倒计时）
        // 打开后 timeNode / 加时按钮一起隐藏，关卡内不再走超时判定
        if (P.model.timeLimitSwitch !== false) { P.model.timeLimitSwitch = false; dirty = true; }
        if (dirty) { try { P.save && P.save(); } catch (e) {} }
      }
      patchSignIn();
      closeIfOpen();
    } catch (e) {}
    if (tries > 900) clearInterval(timer); // 最多轮询 3 分钟
  }, 200);
})();
