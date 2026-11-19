// Lab engine, browser side. It draws whatever the lab record describes (menu, screens, fields)
// and reports the student's state to the server. It contains no lab content and no answers:
// the server decides which steps are done.
(function () {
  var labId = new URLSearchParams(location.search).get('id') || '';
  var sideOpen = {}, sideNav = null;
  var lab = null, state = null, steps = {}, current = null, flash = '', lastTests = {}, busy = 0;

  function $(id) { return document.getElementById(id); }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function getPath(obj, path) { return String(path).split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj); }
  function setPath(obj, path, value) {
    var keys = String(path).split('.'), o = obj;
    for (var i = 0; i < keys.length - 1; i++) { if (typeof o[keys[i]] !== 'object' || o[keys[i]] === null) o[keys[i]] = {}; o = o[keys[i]]; }
    o[keys[keys.length - 1]] = value;
  }
  // Paths in a lab record may contain $policy, meaning "the policy chosen in the selector".
  function rp(path) { return String(path).split('$policy').join(state.currentPolicy || ''); }
  function cfgGet(path) { return getPath(state.config, rp(path)); }
  function cfgSet(path, value) { setPath(state.config, rp(path), value); }
  function dirty() {
    if (lab.applyScope) return JSON.stringify(cfgGet(lab.applyScope)) !== JSON.stringify(getPath(state.applied, rp(lab.applyScope)));
    return JSON.stringify(state.config) !== JSON.stringify(state.applied);
  }
  function applyNow() {
    if (lab.applyScope) setPath(state.applied, rp(lab.applyScope), clone(cfgGet(lab.applyScope)));
    else state.applied = clone(state.config);
  }

  // ---- server ----
  function send(extra) {
    busy++; $('saved').textContent = 'Saving...';
    var body = Object.assign({ id: labId, state: state }, extra || {});
    return fetch('/api/lab/check', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { if (r.status === 401) { location.href = '/'; throw new Error('signed out'); } return r.json(); })
      .then(function (d) {
        busy--;
        if (d.error) { $('saved').textContent = d.error; return d; }
        if (extra && (extra.reset || extra.testId)) state = d.state;
        else if (d.state && d.state.tests) state.tests = d.state.tests;
        steps = d.steps || {};
        if (d.test) lastTests[d.test.id] = d.test;
        (d.stale || []).forEach(function (id) {
          if (lastTests[id] && !(d.test && d.test.id === id)) lastTests[id] = { id: id, result: 'stale', message: 'The configuration has changed since this test was sent. Send the request again to see the result now.' };
        });
        $('saved').textContent = busy ? 'Saving...' : 'Progress saved';
        renderLesson(d.complete);
        return d;
      })
      .catch(function (e) { busy--; if (String(e.message) !== 'signed out') $('saved').textContent = 'Not saved. Check your connection.'; });
  }

  // ---- lesson sidebar ----
  function renderLesson(complete) {
    var list = $('steps'); list.textContent = '';
    var done = 0, firstOpen = true;
    lab.steps.forEach(function (s, i) {
      var ok = Boolean(steps[s.id]); if (ok) done++;
      var li = el('li'); li.className = ok ? 'done' : (firstOpen ? 'now' : '');
      var isNow = !ok && firstOpen; if (!ok) firstOpen = false;
      li.appendChild(el('span', ok ? '✓' : '', 'tick'));
      var txt = el('span', (i + 1) + '. ' + s.text);
      txt.appendChild(el('small', ok ? 'Done' : (isNow ? 'Do this next' : 'To do')));
      li.appendChild(txt); list.appendChild(li);
    });
    $('count').textContent = done + ' of ' + lab.steps.length + ' steps done';
    $('bar').style.width = (lab.steps.length ? Math.round(done * 100 / lab.steps.length) : 0) + '%';
    $('complete').hidden = !complete;
    renderTests();
  }

  function renderTests() {
    var box = $('tests'); box.textContent = '';
    if (!lab.tests.length) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el('h3', 'Test from a client'));
    lab.tests.forEach(function (t) {
      if (t.request) box.appendChild(el('pre', t.request));
      var b = el('button', t.label, 'btn small'); b.type = 'button';
      b.addEventListener('click', function () { b.disabled = true; send({ testId: t.id }).then(function () { b.disabled = false; }); });
      box.appendChild(b);
      var lastTest = lastTests[t.id];
      if (lastTest) {
        // Text between ** and ** in a lab message is shown in bold.
        var res = el('div', undefined, 'result ' + lastTest.result);
        String(lastTest.message).split('**').forEach(function (part, k) { if (part) res.appendChild(k % 2 ? el('b', part) : document.createTextNode(part)); });
        box.appendChild(res);
      }
    });
  }

  // ---- device menu ----
  // Works like the device's main menu. Top-level items open in place; items below that open
  // fly-out panels to the right, by hover with a mouse or by tap on a touch screen.
  var openTop = {}, flys = [], flyTimer = null;
  function findTrail(items, screenId, trail) {
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.screen === screenId) return trail.concat(it.label);
      if (it.children) { var r = findTrail(it.children, screenId, trail.concat(it.label)); if (r) return r; }
    }
    return null;
  }
  function activeTrail() {
    var scr = lab.screens[current], target = (scr && scr.returnTo) || current;
    return findTrail(lab.menu, target, []) || [];
  }
  function openTrailTo(screenId) {
    var scr = lab.screens[screenId], target = (scr && scr.returnTo) || screenId;
    var trail = findTrail(lab.menu, target, []);
    if (trail && trail.length) openTop[trail[0]] = true;
  }
  function closeFlys(fromLevel) {
    while (flys.length > fromLevel) { var f = flys.pop(); if (f.parentNode) f.parentNode.removeChild(f); }
    if (fromLevel === 0) { var marked = document.querySelectorAll('.nav .row.hot'); for (var i = 0; i < marked.length; i++) marked[i].classList.remove('hot'); }
  }
  function keepFlys() { if (flyTimer) { clearTimeout(flyTimer); flyTimer = null; } }
  function leaveFlys() { keepFlys(); flyTimer = setTimeout(function () { closeFlys(0); }, 500); }

  function menuRow(it, level, trail, active) {
    var b = el('button'); b.type = 'button'; b.className = 'row';
    var here = trail.concat(it.label), inTrail = active.slice(0, here.length).join('|') === here.join('|');
    if (inTrail) b.classList.add('on');
    b.appendChild(el('span', it.label, 'lbl'));
    if (it.children) {
      b.appendChild(el('span', '▸', 'arrow'));
      b.setAttribute('aria-haspopup', 'true');
      var open = function () {
        keepFlys(); closeFlys(level);
        var sibs = b.parentNode.querySelectorAll('.row.hot'); for (var i = 0; i < sibs.length; i++) sibs[i].classList.remove('hot');
        b.classList.add('hot');
        showFly(it.children, b, level, here, active);
      };
      b.addEventListener('mouseenter', open);
      b.addEventListener('click', open);
    } else if (it.screen) {
      b.addEventListener('mouseenter', function () { keepFlys(); closeFlys(level); });
      b.addEventListener('click', function () { closeFlys(0); go(it.screen); });
    } else {
      b.classList.add('off'); b.setAttribute('aria-disabled', 'true'); b.title = 'Not part of this lab';
      b.addEventListener('mouseenter', function () { keepFlys(); closeFlys(level); });
    }
    return b;
  }

  function showFly(items, anchor, level, trail, active) {
    var fly = el('div', undefined, 'fly'); fly.setAttribute('role', 'menu');
    items.forEach(function (it) { fly.appendChild(menuRow(it, level + 1, trail, active)); });
    fly.addEventListener('mouseenter', keepFlys); fly.addEventListener('mouseleave', leaveFlys);
    document.body.appendChild(fly); flys.push(fly);
    var r = anchor.getBoundingClientRect(), w = fly.offsetWidth, h = fly.offsetHeight;
    var left = r.right, top = r.top;
    if (left + w > window.innerWidth - 4) left = Math.max(4, window.innerWidth - w - 4);
    if (top + h > window.innerHeight - 4) top = Math.max(4, window.innerHeight - h - 4);
    fly.style.left = left + 'px'; fly.style.top = top + 'px';
  }

  function renderNav() {
    closeFlys(0);
    var nav = $('nav'); nav.textContent = '';
    var active = activeTrail();
    lab.menu.forEach(function (it) {
      var top = el('button', it.label, 'top'); top.type = 'button';
      if (!it.children && !it.screen) { top.classList.add('off'); top.setAttribute('aria-disabled', 'true'); top.title = 'Not part of this lab'; nav.appendChild(top); return; }
      var isOpen = Boolean(openTop[it.label]);
      if (isOpen) top.classList.add('open');
      top.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      top.addEventListener('click', function () {
        if (it.screen) { go(it.screen); return; }
        openTop[it.label] = !isOpen; renderNav();
      });
      nav.appendChild(top);
      if (isOpen && it.children) {
        var panel = el('div', undefined, 'panel');
        it.children.forEach(function (c) { panel.appendChild(menuRow(c, 0, [it.label], active)); });
        nav.appendChild(panel);
      }
    });
  }
  document.addEventListener('click', function (e) {
    if (!flys.length) return;
    var n = e.target; while (n) { if (n.classList && (n.classList.contains('fly') || n.classList.contains('nav'))) return; n = n.parentNode; }
    closeFlys(0);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeFlys(0); });

  function go(screenId, message) {
    if (!lab.screens[screenId]) return;
    current = screenId; flash = message || '';
    openTrailTo(screenId);
    var isNew = state.visited.indexOf(screenId) === -1;
    if (isNew) state.visited.push(screenId);
    renderNav(); renderScreen(); renderBar();
    if (isNew) send();
  }

  // The bar above the screen. Normally the policy selector; a screen can replace it with
  // its own header (a back button and read-only facts about the open record).
  function renderHeader(s) {
    var normal = $('devinfo'), alt = $('althead');
    if (!s.header) { normal.hidden = false; alt.hidden = true; return; }
    normal.hidden = true; alt.hidden = false; alt.textContent = '';
    var back = el('button', '\u2190', 'hbtn'); back.type = 'button'; back.setAttribute('aria-label', 'Back');
    back.addEventListener('click', function () { go(s.header.back || s.returnTo); }); alt.appendChild(back);
    (s.header.buttons || []).forEach(function (t) { var hb = el('button', t + '  \u25BE', 'hbtn wide'); hb.type = 'button'; hb.disabled = true; hb.title = 'Not part of this lab'; alt.appendChild(hb); });
    (s.header.facts || []).forEach(function (f, k) {
      var sp = el('span', undefined, 'fact' + (k ? ' sepd' : '')); sp.appendChild(el('b', f.label + ': ')); sp.appendChild(document.createTextNode(f.bind ? cfgGet(f.bind) : rp(f.text || ''))); alt.appendChild(sp);
    });
  }

  function renderBar() {
    $('pending').hidden = !dirty();
    $('apply').disabled = !dirty();
    var sel = $('policySel');
    if (sel) sel.value = state.currentPolicy || '';
  }

  // ---- screens ----
  function fieldControl(f, value, onChange) {
    var wrap = el('div', undefined, 'ctl');
    if (f.type === 'select') {
      var sel = el('select'); sel.id = 'f_' + f.id;
      (f.options || []).forEach(function (o) { var isObj = o && typeof o === 'object'; var op = el('option', isObj ? o.label : o); op.value = isObj ? o.value : o; sel.appendChild(op); });
      sel.setAttribute('aria-label', f.label);
      sel.value = value; sel.addEventListener('change', function () { onChange(sel.value); }); wrap.appendChild(sel);
    } else if (f.type === 'radio') {
      (f.options || []).forEach(function (o) {
        var lb = el('label', undefined, 'radio'), r = el('input'); r.type = 'radio'; r.name = 'f_' + f.id; r.value = o; r.checked = (o === value);
        r.addEventListener('change', function () { onChange(o); });
        lb.appendChild(r); lb.appendChild(document.createTextNode(o)); wrap.appendChild(lb);
      });
    } else if (f.type === 'readonly') {
      wrap.appendChild(el('span', value == null ? '' : String(value), 'ro'));
      if (f.linkText) { wrap.appendChild(document.createTextNode(' ')); wrap.appendChild(el('span', f.linkText, 'linkish')); }
      if (f.sub) wrap.appendChild(el('div', rp(f.sub), 'ro sub'));
    } else if (f.type === 'segmented') {
      // A row of joined buttons where exactly one is selected.
      var seg = el('div', undefined, 'seg'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', f.label);
      var cur = value;
      (f.options || []).forEach(function (o) {
        var sb = el('button', o); sb.type = 'button'; sb.setAttribute('role', 'radio');
        function paint() { sb.className = (o === cur ? 'on' : ''); sb.setAttribute('aria-checked', o === cur ? 'true' : 'false'); }
        paint();
        sb.addEventListener('click', function () { cur = o; onChange(o); var all = seg.querySelectorAll('button'); for (var i = 0; i < all.length; i++) { all[i].className = all[i].textContent === o ? 'on' : ''; all[i].setAttribute('aria-checked', all[i].textContent === o ? 'true' : 'false'); } });
        seg.appendChild(sb);
      });
      wrap.appendChild(seg);
      if (f.withNumber) {
        var ni = el('input'); ni.type = 'text'; ni.className = 'num'; ni.value = cfgGet(f.withNumber.bind); ni.setAttribute('aria-label', f.label + ' value');
        ni.addEventListener('input', function () { f.withNumber._v = ni.value; }); f.withNumber._v = ni.value;
        wrap.appendChild(ni); if (f.withNumber.suffix) wrap.appendChild(el('span', f.withNumber.suffix, 'suffix'));
      }
    } else if (f.type === 'textarea') {
      var ta = el('textarea'); ta.id = 'f_' + f.id; ta.value = value == null ? '' : value; ta.rows = 2; ta.setAttribute('aria-label', f.label);
      ta.addEventListener('input', function () { onChange(ta.value); }); wrap.appendChild(ta);
    } else if (f.type === 'number') {
      var nu = el('input'); nu.type = 'text'; nu.className = 'num'; nu.id = 'f_' + f.id; nu.value = value == null ? '' : value; nu.setAttribute('aria-label', f.label);
      nu.addEventListener('input', function () { onChange(nu.value); }); wrap.appendChild(nu);
      if (f.suffix) wrap.appendChild(el('span', f.suffix, 'suffix'));
    } else if (f.type === 'chips') {
      var cw = el('div', undefined, 'chips'); (f.values || []).forEach(function (v) { cw.appendChild(el('span', v + ' \u00D7')); }); wrap.appendChild(cw);
      if (f.note) wrap.appendChild(el('div', f.note, 'help'));
    } else if (f.type === 'checkbox') {
      var c = el('input'); c.type = 'checkbox'; c.id = 'f_' + f.id; c.checked = Boolean(value);
      c.addEventListener('change', function () { onChange(c.checked); });
      if (f.text) { var cl = el('label', undefined, 'radio'); cl.appendChild(c); cl.appendChild(document.createTextNode(f.text)); wrap.appendChild(cl); }
      else wrap.appendChild(c);
    } else {
      var inp = el('input'); inp.type = 'text'; inp.id = 'f_' + f.id; inp.value = value == null ? '' : value; inp.autocomplete = 'off'; inp.spellcheck = false;
      if (f.placeholder) inp.placeholder = f.placeholder;
      inp.setAttribute('aria-label', f.label);
      inp.addEventListener('input', function () { onChange(inp.value); }); wrap.appendChild(inp);
    }
    if (f.help) wrap.appendChild(el('div', f.help, 'help'));
    var err = el('div', '', 'err'); err.id = 'e_' + f.id; err.hidden = true; wrap.appendChild(err);
    return wrap;
  }

  // One labelled row holding several controls side by side, as on the device.
  function inlineRow(spec, fields, values) {
    var form = el('div', undefined, 'form'), row = el('div', undefined, 'row');
    var lb = el('div', spec.label, 'lbl'); if (spec.help) lb.appendChild(el('div', spec.help, 'help'));
    row.appendChild(lb);
    var ctl = el('div', undefined, 'ctl inline');
    fields.forEach(function (f) {
      var c = fieldControl(f, values[f.id], function (v) { values[f.id] = v; });
      c.className = 'cell' + (f.type === 'text' ? ' grow' : ''); ctl.appendChild(c);
    });
    row.appendChild(ctl); form.appendChild(row); return form;
  }

  function formRows(fields, values) {
    var form = el('div', undefined, 'form');
    fields.forEach(function (f) {
      var row = el('div', undefined, 'row');
      var plainLbl = f.type === 'radio' || f.type === 'segmented' || f.type === 'readonly' || f.type === 'chips' || f.text;
      var lb = el(plainLbl ? 'div' : 'label', f.text ? '' : f.label, plainLbl ? 'lbl' : ''); if (!plainLbl) lb.htmlFor = 'f_' + f.id;
      row.appendChild(lb);
      row.appendChild(fieldControl(f, values[f.id], function (v) { values[f.id] = v; }));
      form.appendChild(row);
    });
    return form;
  }

  function recMatches(r, cond) { return !cond || Object.keys(cond).every(function (k) { return String(r[k]) === String(cond[k]); }); }

  function stamp() {
    var n = new Date(), p2 = function (x) { return (x < 10 ? '0' : '') + x; };
    return n.getFullYear() + '-' + p2(n.getMonth() + 1) + '-' + p2(n.getDate()) + ' ' + p2(n.getHours()) + ':' + p2(n.getMinutes()) + ':' + p2(n.getSeconds());
  }

  // A pop-up that creates or edits one record of a list, as the device does for file types.
  // index -1 means a new record. Everything shown comes from the screen's "editor" definition.
  function openEditor(s, index, preset) {
    var ed = s.editor, rowsNow = cfgGet(s.collection) || [], isNew = index < 0;
    var rec = isNew ? Object.assign(clone(ed.defaults || {}), clone(preset || {})) : clone(rowsNow[index]);
    var prev = document.querySelector('.modalwrap'); if (prev) prev.parentNode.removeChild(prev);
    var wrap = el('div', undefined, 'modalwrap'), dlg = el('div', undefined, 'modal');
    dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-label', ed.title);
    dlg.appendChild(el('div', ed.title, 'mtitle'));
    var body = el('div', undefined, 'mbody'), form = el('div', undefined, 'form plain'), err = el('div', '', 'err'); err.hidden = true;
    function seg(options, value, onPick, label) {
      var g = el('div', undefined, 'seg'); g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', label);
      options.forEach(function (o) {
        var b = el('button', o); b.type = 'button'; b.setAttribute('role', 'radio'); b.className = o === value ? 'on' : ''; b.setAttribute('aria-checked', o === value ? 'true' : 'false');
        b.addEventListener('click', function () {
          var all = g.querySelectorAll('button'); for (var i = 0; i < all.length; i++) { all[i].className = all[i] === b ? 'on' : ''; all[i].setAttribute('aria-checked', all[i] === b ? 'true' : 'false'); }
          onPick(o);
        });
        g.appendChild(b);
      });
      return g;
    }
    var titleFor = (ed.titles || []).filter(function (x) { return recMatches(rec, x.when); })[0];
    if (titleFor) { dlg.querySelector('.mtitle').textContent = titleFor.title; dlg.setAttribute('aria-label', titleFor.title); }
    var shown = ed.fields.filter(function (f) { return recMatches(rec, f.showWhen); });
    shown.forEach(function (f) {
      var row = el('div', undefined, 'row'), lb = el('div', f.label, 'lbl'), ctl = el('div', undefined, 'ctl');
      if (f.required) lb.appendChild(el('span', ' *', 'req'));
      if (f.type === 'key') {
        if (isNew) {
          var ki = el('input'); ki.type = 'text'; ki.value = rec[f.field] || ''; ki.setAttribute('aria-label', f.label); ki.autocomplete = 'off'; ki.spellcheck = false;
          ki.addEventListener('input', function () { rec[f.field] = ki.value; }); ctl.appendChild(ki); setTimeout(function () { ki.focus(); }, 0);
        } else ctl.appendChild(el('span', '\u2713 ' + rec[f.field], 'ro keyname'));
      } else if (f.type === 'segmented') {
        var info = el('div', undefined, 'ro sub');
        var paint = function () {
          info.textContent = '';
          if (f.infoWhen && rec[f.field] !== f.infoWhen) return;
          (f.info || []).forEach(function (ln) { if (!rec[ln.field]) return; var d = el('div'); d.appendChild(el('b', ln.label + ': ')); d.appendChild(document.createTextNode(rec[ln.field])); info.appendChild(d); });
        };
        ctl.appendChild(seg(f.options, rec[f.field], function (o) {
          var was = rec[f.field]; rec[f.field] = o;
          // Turning a timed setting on stamps the time, as the device does for staging.
          if (f.stampOn && o === f.stampOn.value && was !== o) f.stampOn.fields.forEach(function (k) { rec[k] = stamp(); });
          paint();
        }, f.label));
        ctl.appendChild(info); paint();
      } else if (f.type === 'length') {
        var num = el('input'); num.type = 'text'; num.className = 'num'; num.value = rec[f.field] == null ? '' : rec[f.field]; num.setAttribute('aria-label', f.label + ' value');
        num.disabled = rec[f.modeField] === 'Any';
        num.addEventListener('input', function () { rec[f.field] = num.value; });
        ctl.appendChild(seg(['Any', 'Length'], rec[f.modeField], function (o) { rec[f.modeField] = o; num.disabled = o === 'Any'; }, f.label));
        ctl.appendChild(num); ctl.appendChild(el('span', f.suffix || 'bytes', 'suffix'));
      } else if (f.type === 'note') {
        ctl.appendChild(el('span', f.text || '', 'ro'));
        if (f.warning) ctl.appendChild(el('div', '\u26A0 ' + f.warning, 'ro sub warn'));
      }
      row.appendChild(lb); row.appendChild(ctl); form.appendChild(row);
    });
    body.appendChild(form); body.appendChild(err); dlg.appendChild(body);
    var foot = el('div', undefined, 'mfoot');
    var ok = el('button', isNew ? (ed.createLabel || 'Create') : (ed.updateLabel || 'Update'), 'mbtn primary'); ok.type = 'button';
    var cancel = el('button', 'Cancel', 'mbtn'); cancel.type = 'button';
    function close() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    cancel.addEventListener('click', close);
    ok.addEventListener('click', function () {
      var msg = '';
      shown.forEach(function (f) {
        if (msg) return;
        if (f.type === 'key') {
          var k = String(rec[f.field] || '').trim(); rec[f.field] = k;
          if (!k) msg = f.label + ' is required.';
          else if (isNew && rowsNow.some(function (r) { return String(r[f.field]).toLowerCase() === k.toLowerCase(); })) msg = f.label + ' "' + k + '" already exists.';
        }
        if (f.type === 'length' && rec[f.modeField] === 'Length') {
          var v = String(rec[f.field] == null ? '' : rec[f.field]).trim();
          if (!/^[0-9]+$/.test(v)) msg = f.label + ' must be a whole number of bytes.';
          else rec[f.field] = parseInt(v, 10);
        }
      });
      if (msg) { err.textContent = msg; err.hidden = false; return; }
      // A new record that starts with a timed setting on gets its timestamps now.
      shown.forEach(function (f) {
        if (f.stampOn && rec[f.field] === f.stampOn.value) f.stampOn.fields.forEach(function (k) { if (!rec[k]) rec[k] = stamp(); });
      });
      var list = clone(rowsNow);
      if (isNew) { if (ed.insertAt === 'top') list.unshift(rec); else list.push(rec); } else list[index] = rec;
      cfgSet(s.collection, list); close();
      go(current, (isNew ? 'Created.' : 'Updated.') + ' Apply the policy to put the change into effect.'); send();
    });
    foot.appendChild(ok); foot.appendChild(cancel); dlg.appendChild(foot);
    wrap.appendChild(dlg); wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) close(); });
    document.body.appendChild(wrap);
  }

  function renderScreen() {
    var s = lab.screens[current], box = $('screen'); box.textContent = '';
    var pb = $('pathbar'), ptxt = rp(s.pathText || (s.path || []).join(' : ')), parts = ptxt.split(' \u00BB ');
    pb.textContent = '';
    parts.forEach(function (part, k) {
      if (k) pb.appendChild(el('span', ' \u00BB ', 'sep'));
      pb.appendChild(el('span', part, k === parts.length - 1 && k > 0 ? 'here' : ''));
    });
    var tabs = $('tabsbar'); tabs.textContent = ''; tabs.hidden = !s.tabs;
    (s.tabs || []).forEach(function (tb0) {
      var tbn = el('button', tb0.label); tbn.type = 'button';
      if (tb0.screen && (tb0.screen === current || tb0.screen === s.tabOn)) tbn.className = 'on';
      if (tb0.screen) tbn.addEventListener('click', function () { go(tb0.screen); });
      else { tbn.disabled = true; tbn.title = 'Not part of this lab'; }
      tabs.appendChild(tbn);
    });
    renderHeader(s);
    // A screen can sit inside a page with a section list on the left (the policy page).
    // The section list is defined once in the lab record and shared by those screens.
    var host = box, panel = typeof s.sidePanel === 'string' ? (lab.sidePanels || {})[s.sidePanel] : s.sidePanel;
    if (panel) {
      var page = el('div', undefined, 'polpage'), side = el('div', undefined, 'side');
      panel.forEach(function (g) {
        // Section groups open and close when clicked, like the device.
        var hasCurrent = (g.items || []).some(function (it) { return it.screen === current; });
        if (!(g.label in sideOpen)) sideOpen[g.label] = Boolean(g.open);
        if (hasCurrent && sideNav !== current) sideOpen[g.label] = true;
        var isOpen = sideOpen[g.label];
        var gh = el('button', undefined, 'sgrp'); gh.type = 'button'; gh.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        gh.appendChild(el('span', isOpen ? '\u25BE' : '\u25B8', 'tog')); gh.appendChild(document.createTextNode(g.label));
        gh.addEventListener('click', function () { sideOpen[g.label] = !isOpen; renderScreen(); });
        side.appendChild(gh);
        if (isOpen) (g.items || []).forEach(function (it) {
          var sb2 = el('button', it.label, 'sitem'); sb2.type = 'button';
          if (it.screen === current) sb2.classList.add('on');
          if (it.screen) sb2.addEventListener('click', function () { go(it.screen); });
          else { sb2.disabled = true; sb2.title = 'Not part of this lab'; }
          side.appendChild(sb2);
        });
      });
      sideNav = current;
      host = el('div', undefined, 'main'); page.appendChild(side); page.appendChild(host); box.appendChild(page);
    }
    if (flash) host.appendChild(el('div', flash, 'flash'));
    var titleRow = el('div', undefined, 'titlerow'); titleRow.appendChild(el('h1', s.title || '')); if (s.title || s.createScreen) host.appendChild(titleRow);

    if (s.type === 'list' && s.style === 'modern') {
      // Policy-page list: a summary line with action buttons, a filter bar and a plain table.
      var mrows = cfgGet(s.collection) || [], msel = {}, mboxes = [];
      var top = el('div', undefined, 'mtop'), sum = el('div', undefined, 'msum'), acts = el('div', undefined, 'macts');
      (s.summary || []).forEach(function (it) {
        var n = mrows.filter(function (r) { return recMatches(r, it.countWhere); }).length;
        var sp = el('span'); sp.appendChild(el('b', String(it.bold || '').replace('{n}', n))); sp.appendChild(document.createTextNode(' ' + (it.text || ''))); sum.appendChild(sp);
      });
      (s.buttons || []).forEach(function (bt) {
        var b = el('button', bt.label + (bt.menu ? ' \u25BE' : ''), 'mbtn ' + (bt.kind || 'plain')); b.type = 'button';
        if (bt.screen) b.addEventListener('click', function () { go(bt.screen); });
        else if (bt.op === 'create' && s.editor && Array.isArray(bt.menu)) b.addEventListener('click', function (ev) {
          // A Create button that first asks which kind of record to make.
          ev.stopPropagation();
          var old = document.querySelector('.dropmenu'); if (old) { old.parentNode.removeChild(old); return; }
          var dm = el('div', undefined, 'dropmenu'), r = b.getBoundingClientRect();
          bt.menu.forEach(function (mi) {
            var mb = el('button', mi.label); mb.type = 'button';
            mb.addEventListener('click', function () { dm.parentNode.removeChild(dm); openEditor(s, -1, mi.defaults); });
            dm.appendChild(mb);
          });
          document.body.appendChild(dm); dm.style.top = r.bottom + 'px'; dm.style.left = Math.max(4, Math.min(r.left, window.innerWidth - dm.offsetWidth - 4)) + 'px';
          setTimeout(function () { document.addEventListener('click', function once() { if (dm.parentNode) dm.parentNode.removeChild(dm); document.removeEventListener('click', once); }); }, 0);
        });
        else if (bt.op === 'create' && s.editor) b.addEventListener('click', function () { openEditor(s, -1); });
        else if (bt.op === 'delete') b.addEventListener('click', function () {
          var picked = mrows.filter(function (_, i) { return msel[i]; });
          if (!picked.length) { go(current, 'Select at least one entry first.'); return; }
          var locked = picked.filter(function (r) { return r.locked; });
          if (locked.length) { go(current, (bt.lockedText || 'This entry cannot be deleted.')); return; }
          cfgSet(s.collection, mrows.filter(function (_, i) { return !msel[i]; })); go(current, 'Deleted. Apply the policy to put the change into effect.'); send();
        });
        else if (bt.op === 'set') b.addEventListener('click', function () {
          // Sets fields on every ticked row, for example Enforce turns staging off.
          var any = false, list = clone(mrows);
          list.forEach(function (r, i) {
            if (!msel[i] || !recMatches(r, bt.onlyWhere)) return; any = true;
            Object.keys(bt.set || {}).forEach(function (k) { r[k] = bt.set[k] === '$now' ? stamp() : bt.set[k]; });
          });
          if (!any) { go(current, bt.noneText || 'Select at least one entry first.'); return; }
          cfgSet(s.collection, list); go(current, (bt.doneText || 'Updated.') + ' Apply the policy to put the change into effect.'); send();
        });
        else { b.disabled = true; b.title = 'Not part of this lab'; }
        acts.appendChild(b);
      });
      top.appendChild(sum); top.appendChild(acts); host.appendChild(top);
      var fbar = el('div', undefined, 'mfilter'); fbar.appendChild(el('span', '\u25BD\u25BE', 'ficon')); fbar.appendChild(el('span', mrows.length + ' Entries', 'ents')); host.appendChild(fbar);
      var mt = el('table', undefined, 'mgrid'), mh = el('tr'), mth = el('th', undefined, 'chk'), mall = el('input');
      mall.type = 'checkbox'; mall.setAttribute('aria-label', 'Select all rows');
      mall.addEventListener('change', function () { mboxes.forEach(function (cb, i) { cb.checked = mall.checked; msel[i] = mall.checked; }); });
      mth.appendChild(mall); mh.appendChild(mth);
      s.columns.forEach(function (c) { mh.appendChild(el('th', c.label)); });
      var mhead = el('thead'); mhead.appendChild(mh); mt.appendChild(mhead);
      var mbody = el('tbody');
      mrows.forEach(function (r, i) {
        var tr = el('tr'), tdc = el('td', undefined, 'chk'), cb = el('input'); cb.type = 'checkbox'; cb.setAttribute('aria-label', 'Select row ' + (i + 1));
        cb.addEventListener('change', function () { msel[i] = cb.checked; }); mboxes.push(cb); tdc.appendChild(cb); tr.appendChild(tdc);
        s.columns.forEach(function (c) {
          var td = el('td'), v = r[c.field];
          if (c.anyWhen && r[c.anyWhen] === 'Any') v = 'Any';
          if (c.blankWhen && recMatches(r, c.blankWhen)) v = '';
          if (c.map && c.map[v] !== undefined) v = c.map[v];
          if (c.type === 'check') td.appendChild(el('span', v ? '\u2713' : '', 'tickmark'));
          else if (c.opens === 'editor' && s.editor) {
            var lk = el('a', v == null ? '' : String(v), 'linkish'); lk.href = '#';
            lk.addEventListener('click', function (ev) { ev.preventDefault(); openEditor(s, i); }); td.appendChild(lk);
          }
          else td.appendChild(el('span', v == null ? '' : String(v), c.style === 'link' ? 'linkish' : ''));
          tr.appendChild(td);
        });
        mbody.appendChild(tr);
      });
      if (!mrows.length) { var me = el('td', s.emptyText || 'No records to display.', 'empty'); me.colSpan = s.columns.length + 1; var mer = el('tr'); mer.appendChild(me); mbody.appendChild(mer); }
      mt.appendChild(mbody); host.appendChild(mt);
    } else if (s.type === 'list') {
      var rows = cfgGet(s.collection) || [];
      var selected = {};
      if (s.createScreen) {
        var cr = el('button', s.createLabel || 'Create', 'btn small create'); cr.type = 'button'; cr.addEventListener('click', function () { go(s.createScreen); });
        titleRow.appendChild(cr);
      }
      var wrap = el('div', undefined, 'listbox');
      var t = el('table', undefined, 'grid'), hr = el('tr');
      var boxes = [];
      if (s.allowDelete) {
        var thc = el('th', undefined, 'chk'), all = el('input'); all.type = 'checkbox'; all.setAttribute('aria-label', 'Select all rows');
        all.addEventListener('change', function () { boxes.forEach(function (cb, i) { cb.checked = all.checked; selected[i] = all.checked; }); });
        thc.appendChild(all); hr.appendChild(thc);
      }
      s.columns.forEach(function (c) { hr.appendChild(el('th', c.label)); });
      var thead = el('thead'); thead.appendChild(hr); t.appendChild(thead);
      var tbody = el('tbody');
      if (!rows.length) { var e = el('td', s.emptyText || 'No records to display.', 'empty'); e.colSpan = s.columns.length + (s.allowDelete ? 1 : 0); var er = el('tr'); er.appendChild(e); tbody.appendChild(er); }
      rows.forEach(function (r, i) {
        var tr = el('tr');
        if (s.allowDelete) { var td = el('td', undefined, 'chk'), cb = el('input'); boxes.push(cb); cb.type = 'checkbox'; cb.setAttribute('aria-label', 'Select row ' + (i + 1)); cb.addEventListener('change', function () { selected[i] = cb.checked; }); td.appendChild(cb); tr.appendChild(td); }
        s.columns.forEach(function (c) {
          if (!c.link) { var cell = el('td'); cell.appendChild(el('span', r[c.field], c.style === 'link' ? 'linkish' : '')); tr.appendChild(cell); return; }
          // A linked cell opens that record, for example clicking a policy name selects the policy.
          var td2 = el('td'), a = el('a', r[c.field]); a.href = '#';
          a.addEventListener('click', function (ev) {
            ev.preventDefault();
            if (c.link.set) state[c.link.set] = r[c.field];
            go(c.link.screen || current); send();
          });
          td2.appendChild(a); tr.appendChild(td2);
        });
        tbody.appendChild(tr);
      });
      t.appendChild(tbody); wrap.appendChild(t); host.appendChild(wrap);
      var foot = el('div', undefined, 'listfoot'); host.appendChild(foot);
      if (s.allowDelete) {
        var del = el('button', 'Delete', 'btn small ghost'); del.type = 'button';
        del.addEventListener('click', function () {
          var keep = rows.filter(function (_, i) { return !selected[i]; });
          if (keep.length === rows.length) return;
          cfgSet(s.collection, keep); go(current, 'Deleted.'); send();
        });
        foot.appendChild(del);
      } else foot.appendChild(el('span'));
      foot.appendChild(el('span', 'Total Entries: ' + rows.length, 'total'));
    }

    if (s.type === 'create') {
      var vals = {}; s.fields.forEach(function (f) { vals[f.id] = f.default !== undefined ? f.default : (f.type === 'checkbox' ? false : ''); });
      host.appendChild(s.inlineRow ? inlineRow(s.inlineRow, s.fields, vals) : formRows(s.fields, vals));
      var act = el('div', undefined, 'actions');
      var cancel = el('button', 'Cancel', 'btn ghost'); cancel.type = 'button'; cancel.addEventListener('click', function () { go(s.returnTo); });
      var create = el('button', 'Create', 'btn'); create.type = 'button';
      create.addEventListener('click', function () {
        var ok = true;
        s.fields.forEach(function (f) {
          var v = typeof vals[f.id] === 'string' ? vals[f.id].trim() : vals[f.id], msg = '';
          // The device adds a missing leading character for you (for example the / on a URL).
          if (typeof v === 'string' && v && f.autoPrefix && v.indexOf(f.autoPrefix) !== 0) v = f.autoPrefix + v;
          if (typeof v === 'string') vals[f.id] = v;
          if (f.required && !v) msg = f.label + ' is required.';
          else if (f.mustStartWith && String(v).indexOf(f.mustStartWith) !== 0) msg = f.label + ' must start with ' + f.mustStartWith;
          var e = $('e_' + f.id); e.textContent = msg; e.hidden = !msg; if (msg) ok = false;
          if (f.type === 'select' && f.options) vals[f.id] = v;
        });
        if (!ok) return;
        var list = (cfgGet(s.collection) || []).slice(); list.push(clone(vals));
        cfgSet(s.collection, list);
        go(s.returnTo, 'Created. Apply the policy to put the change into effect.'); send();
      });
      act.appendChild(cancel); act.appendChild(create); host.appendChild(act);
    }

    if (s.type === 'form') {
      var secs = s.sections || [{ fields: s.fields || [] }], allFields = [];
      secs.forEach(function (sec) { (sec.fields || []).forEach(function (f) { allFields.push(f); }); });
      var fv = {};
      allFields.forEach(function (f) { fv[f.id] = f.type === 'readonly' && f.value !== undefined ? rp(f.value) : (f.bind ? cfgGet(f.bind) : undefined); });
      secs.forEach(function (sec) {
        if (sec.title) host.appendChild(el('h2', sec.title, 'sec'));
        var rows = formRows(sec.fields || [], fv); if (panel) rows.classList.add('plain');
        host.appendChild(rows);
      });
      var a2 = el('div', undefined, 'actions');
      var save = el('button', 'Save', 'btn'); save.type = 'button';
      save.addEventListener('click', function () {
        allFields.forEach(function (f) {
          if (f.type !== 'readonly' && f.type !== 'chips' && f.bind) cfgSet(f.bind, fv[f.id]);
          if (f.withNumber && f.withNumber.bind) cfgSet(f.withNumber.bind, f.withNumber._v);
        });
        go(current, 'Saved. Apply the policy to put the change into effect.'); send();
      });
      a2.appendChild(save); host.appendChild(a2);
    }
  }

  // ---- start ----
  function start(d) {
    lab = d.lab; state = d.state; steps = d.steps || {};
    document.title = lab.title + ' | F5 Labs';
    var c = $('crumbs'), b = d.breadcrumb; c.textContent = '';
    var home = el('a', b.course); home.href = '/course.html?id=' + encodeURIComponent(lab.courseId);
    c.appendChild(home);
    [b.version, b.module].forEach(function (x) { c.appendChild(document.createTextNode(' › ' + x)); });
    c.appendChild(document.createTextNode(' › ')); c.appendChild(el('b', b.lab));
    $('ltitle').textContent = lab.title; $('lintro').textContent = lab.intro || '';
    $('lreq').textContent = lab.requirement || ''; $('lreqbox').hidden = !lab.requirement;
    // Device chrome: banner, header strip with a live clock, and the status lines.
    var dev = lab.device || {};
    var banner = $('banner'); banner.textContent = (dev.banner && dev.banner.text) || dev.hostname || ''; banner.hidden = !banner.textContent;
    if (dev.banner && dev.banner.color) banner.style.background = dev.banner.color;
    var head = $('devhead'); head.textContent = '';
    function pair(rows) {
      var g = el('div', undefined, 'grp');
      rows.forEach(function (kv) { g.appendChild(el('i', kv[0])); var v = el('b', kv[1]); if (kv[2]) v.id = kv[2]; g.appendChild(v); });
      head.appendChild(g);
    }
    pair([['Hostname', dev.hostname || ''], ['IP Address', dev.ip || '']]);
    pair([['Date', '', 'devdate'], ['Time', '', 'devtime']]);
    pair([['User', dev.user || 'admin'], ['Role', dev.role || 'Administrator']]);
    var rt = el('div', undefined, 'grp end');
    rt.appendChild(el('i', 'Partition:')); var part = el('select'); part.disabled = true; part.appendChild(el('option', dev.partition || 'Common')); part.setAttribute('aria-label', 'Partition'); rt.appendChild(part);
    var lo = el('span', 'Log out', 'logout'); lo.title = 'Not part of this lab'; rt.appendChild(lo);
    head.appendChild(rt);
    function tick() {
      var n = new Date();
      $('devdate').textContent = n.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      $('devtime').textContent = n.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
    tick(); setInterval(tick, 30000);
    var st = $('status'); st.textContent = '';
    (dev.status || []).forEach(function (x) { var li = el('li', x.text); li.className = x.level || 'ok'; st.appendChild(li); });
    var info = $('devinfo'); info.textContent = '';
    if (lab.policySelector) {
      // The policy selector: every policy screen shows and edits the policy chosen here.
      var ps = el('select'); ps.id = 'policySel'; ps.setAttribute('aria-label', 'Current edited security policy');
      (getPath(state.config, lab.policySelector.collection) || []).forEach(function (r) { var o = el('option', r[lab.policySelector.field]); o.value = r[lab.policySelector.field]; ps.appendChild(o); });
      ps.value = state.currentPolicy || '';
      ps.addEventListener('change', function () { state.currentPolicy = ps.value; flash = ''; renderScreen(); renderBar(); send(); });
      info.appendChild(ps);
    }
    info.appendChild(el('span', [lab.policySelector ? '' : lab.device.hostname, lab.device.learningMode ? 'Learning Mode: ' + lab.device.learningMode : ''].filter(Boolean).join('  |  ')));
    $('pending').textContent = lab.pendingText;
    $('apply').textContent = lab.applyLabel;
    $('apply').addEventListener('click', function () {
      applyNow(); flash = 'Policy applied.'; renderScreen(); renderBar(); send();
    });
    $('reset').addEventListener('click', function () {
      lastTests = {};
      send({ reset: true }).then(function () { current = null; openTop = {}; go(lab.startScreen || Object.keys(lab.screens)[0]); });
    });
    $('nav').addEventListener('mouseleave', leaveFlys); $('nav').addEventListener('mouseenter', keepFlys);
    renderLesson(d.complete);
    go(lab.startScreen || Object.keys(lab.screens)[0]);
  }

  fetch('/api/lab?id=' + encodeURIComponent(labId), { credentials: 'same-origin' })
    .then(function (r) { if (r.status === 401) { location.href = '/'; return null; } return r.json(); })
    .then(function (d) {
      if (!d) return;
      if (d.error) { $('crumbs').textContent = d.error; $('screen').textContent = d.error; return; }
      start(d);
    })
    .catch(function (e) { $('screen').textContent = 'Could not load the lab: ' + e; });
})();
(function () { var b = document.getElementById('build'); if (b && b.getAttribute('data-build')) b.textContent = '· build ' + b.getAttribute('data-build'); })();
