// Lab engine, browser side. It draws whatever the lab record describes (menu, screens, fields)
// and reports the student's state to the server. It contains no lab content and no answers:
// the server decides which steps are done.
(function () {
  var labId = new URLSearchParams(location.search).get('id') || '';
  var lab = null, state = null, steps = {}, current = null, flash = '', lastTest = null, busy = 0;

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
        if (d.test) lastTest = d.test;
        else if (lastTest && d.stale && d.stale.indexOf(lastTest.id) > -1) {
          lastTest = { id: lastTest.id, result: 'stale', message: 'The configuration has changed since this test was sent. Send the request again to see the result now.' };
        }
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
      if (lastTest && lastTest.id === t.id) {
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
    if (flash) box.appendChild(el('div', flash, 'flash'));
    var titleRow = el('div', undefined, 'titlerow'); titleRow.appendChild(el('h1', s.title || '')); if (s.title || s.createScreen) box.appendChild(titleRow);
    renderHeader(s);

    if (s.type === 'list') {
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
      t.appendChild(tbody); wrap.appendChild(t); box.appendChild(wrap);
      var foot = el('div', undefined, 'listfoot'); box.appendChild(foot);
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
      box.appendChild(s.inlineRow ? inlineRow(s.inlineRow, s.fields, vals) : formRows(s.fields, vals));
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
      act.appendChild(cancel); act.appendChild(create); box.appendChild(act);
    }

    if (s.type === 'form') {
      var secs = s.sections || [{ fields: s.fields || [] }], allFields = [];
      secs.forEach(function (sec) { (sec.fields || []).forEach(function (f) { allFields.push(f); }); });
      var fv = {};
      allFields.forEach(function (f) { fv[f.id] = f.type === 'readonly' && f.value !== undefined ? rp(f.value) : (f.bind ? cfgGet(f.bind) : undefined); });
      var host = box;
      if (s.sidePanel) {
        // Policy-style page: a section list on the left, the settings on the right.
        var page = el('div', undefined, 'polpage'), side = el('div', undefined, 'side');
        s.sidePanel.forEach(function (g) {
          side.appendChild(el('div', (g.open ? '\u25BE ' : '\u25B8 ') + g.label, 'sgrp' + (g.open ? '' : ' off')));
          if (g.open) (g.items || []).forEach(function (it) {
            var sb2 = el('button', it.label); sb2.type = 'button';
            if (it.screen === current) sb2.className = 'on';
            if (it.screen) sb2.addEventListener('click', function () { go(it.screen); });
            else { sb2.disabled = true; sb2.title = 'Not part of this lab'; }
            side.appendChild(sb2);
          });
        });
        host = el('div', undefined, 'main'); page.appendChild(side); page.appendChild(host); box.appendChild(page);
        if (flash) { var fl = box.querySelector('.flash'); if (fl) host.appendChild(fl); }
      }
      secs.forEach(function (sec) {
        if (sec.title) host.appendChild(el('h2', sec.title, 'sec'));
        var rows = formRows(sec.fields || [], fv); if (s.sidePanel) rows.classList.add('plain');
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
      lastTest = null;
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
