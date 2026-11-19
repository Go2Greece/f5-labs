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
  function dirty() { return JSON.stringify(state.config) !== JSON.stringify(state.applied); }

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
        steps = d.steps || {};
        if (d.test) lastTest = d.test;
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
      if (lastTest && lastTest.id === t.id) box.appendChild(el('div', lastTest.message, 'result ' + lastTest.result));
    });
  }

  // ---- device menu ----
  function renderNav() {
    var nav = $('nav'); nav.textContent = '';
    function walk(items, depth) {
      items.forEach(function (it) {
        if (it.children) {
          var h = el('div', it.label, depth === 0 ? 'grp' : 'sub'); h.style.paddingLeft = (14 + depth * 12) + 'px';
          nav.appendChild(h); walk(it.children, depth + 1);
        } else {
          var b = el('button', it.label); b.type = 'button'; b.style.paddingLeft = (14 + depth * 12) + 'px';
          var scr = lab.screens[current];
          if (it.screen === current || (scr && scr.returnTo === it.screen)) b.className = 'on';
          b.addEventListener('click', function () { go(it.screen); });
          nav.appendChild(b);
        }
      });
    }
    walk(lab.menu, 0);
  }

  function go(screenId, message) {
    if (!lab.screens[screenId]) return;
    current = screenId; flash = message || '';
    var isNew = state.visited.indexOf(screenId) === -1;
    if (isNew) state.visited.push(screenId);
    renderNav(); renderScreen(); renderBar();
    if (isNew) send();
  }

  function renderBar() {
    $('pending').hidden = !dirty();
    $('apply').disabled = !dirty();
  }

  // ---- screens ----
  function fieldControl(f, value, onChange) {
    var wrap = el('div', undefined, 'ctl');
    if (f.type === 'select') {
      var sel = el('select'); sel.id = 'f_' + f.id;
      (f.options || []).forEach(function (o) { var op = el('option', o); op.value = o; sel.appendChild(op); });
      sel.value = value; sel.addEventListener('change', function () { onChange(sel.value); }); wrap.appendChild(sel);
    } else if (f.type === 'radio') {
      (f.options || []).forEach(function (o) {
        var lb = el('label', undefined, 'radio'), r = el('input'); r.type = 'radio'; r.name = 'f_' + f.id; r.value = o; r.checked = (o === value);
        r.addEventListener('change', function () { onChange(o); });
        lb.appendChild(r); lb.appendChild(document.createTextNode(o)); wrap.appendChild(lb);
      });
    } else if (f.type === 'checkbox') {
      var c = el('input'); c.type = 'checkbox'; c.id = 'f_' + f.id; c.checked = Boolean(value);
      c.addEventListener('change', function () { onChange(c.checked); }); wrap.appendChild(c);
    } else {
      var inp = el('input'); inp.type = 'text'; inp.id = 'f_' + f.id; inp.value = value == null ? '' : value; inp.autocomplete = 'off'; inp.spellcheck = false;
      if (f.placeholder) inp.placeholder = f.placeholder;
      inp.addEventListener('input', function () { onChange(inp.value); }); wrap.appendChild(inp);
    }
    if (f.help) wrap.appendChild(el('div', f.help, 'help'));
    var err = el('div', '', 'err'); err.id = 'e_' + f.id; err.hidden = true; wrap.appendChild(err);
    return wrap;
  }

  function formRows(fields, values) {
    var form = el('div', undefined, 'form');
    fields.forEach(function (f) {
      var row = el('div', undefined, 'row');
      var lb = el(f.type === 'radio' ? 'div' : 'label', f.label, f.type === 'radio' ? 'lbl' : ''); if (f.type !== 'radio') lb.htmlFor = 'f_' + f.id;
      row.appendChild(lb);
      row.appendChild(fieldControl(f, values[f.id], function (v) { values[f.id] = v; }));
      form.appendChild(row);
    });
    return form;
  }

  function renderScreen() {
    var s = lab.screens[current], box = $('screen'); box.textContent = '';
    box.appendChild(el('div', (s.path || []).join(' › '), 'path'));
    box.appendChild(el('h1', s.title));
    if (flash) box.appendChild(el('div', flash, 'flash'));

    if (s.type === 'list') {
      var rows = getPath(state.config, s.collection) || [];
      var selected = {};
      if (s.createScreen || s.allowDelete) {
        var tb = el('div', undefined, 'toolbar');
        if (s.allowDelete) {
          var del = el('button', 'Delete', 'btn small ghost'); del.type = 'button';
          del.addEventListener('click', function () {
            var keep = rows.filter(function (_, i) { return !selected[i]; });
            if (keep.length === rows.length) return;
            setPath(state.config, s.collection, keep); go(current, 'Deleted.'); send();
          });
          tb.appendChild(del);
        }
        if (s.createScreen) { var cr = el('button', 'Create', 'btn small'); cr.type = 'button'; cr.addEventListener('click', function () { go(s.createScreen); }); tb.appendChild(cr); }
        box.appendChild(tb);
      }
      var t = el('table', undefined, 'grid'), hr = el('tr');
      if (s.allowDelete) hr.appendChild(el('th', ''));
      s.columns.forEach(function (c) { hr.appendChild(el('th', c.label)); });
      var thead = el('thead'); thead.appendChild(hr); t.appendChild(thead);
      var tbody = el('tbody');
      if (!rows.length) { var e = el('td', s.emptyText || 'No records to display.', 'empty'); e.colSpan = s.columns.length + (s.allowDelete ? 1 : 0); var er = el('tr'); er.appendChild(e); tbody.appendChild(er); }
      rows.forEach(function (r, i) {
        var tr = el('tr');
        if (s.allowDelete) { var td = el('td'), cb = el('input'); cb.type = 'checkbox'; cb.setAttribute('aria-label', 'Select row ' + (i + 1)); cb.addEventListener('change', function () { selected[i] = cb.checked; }); td.appendChild(cb); tr.appendChild(td); }
        s.columns.forEach(function (c) { tr.appendChild(el('td', r[c.field])); });
        tbody.appendChild(tr);
      });
      t.appendChild(tbody); box.appendChild(t);
    }

    if (s.type === 'create') {
      var vals = {}; s.fields.forEach(function (f) { vals[f.id] = f.default !== undefined ? f.default : (f.type === 'checkbox' ? false : ''); });
      box.appendChild(formRows(s.fields, vals));
      var act = el('div', undefined, 'actions');
      var cancel = el('button', 'Cancel', 'btn ghost'); cancel.type = 'button'; cancel.addEventListener('click', function () { go(s.returnTo); });
      var create = el('button', 'Create', 'btn'); create.type = 'button';
      create.addEventListener('click', function () {
        var ok = true;
        s.fields.forEach(function (f) {
          var v = typeof vals[f.id] === 'string' ? vals[f.id].trim() : vals[f.id], msg = '';
          if (typeof v === 'string') vals[f.id] = v;
          if (f.required && !v) msg = f.label + ' is required.';
          else if (f.mustStartWith && String(v).indexOf(f.mustStartWith) !== 0) msg = f.label + ' must start with ' + f.mustStartWith;
          var e = $('e_' + f.id); e.textContent = msg; e.hidden = !msg; if (msg) ok = false;
        });
        if (!ok) return;
        var list = (getPath(state.config, s.collection) || []).slice(); list.push(clone(vals));
        setPath(state.config, s.collection, list);
        go(s.returnTo, 'Created. Apply the policy to put the change into effect.'); send();
      });
      act.appendChild(cancel); act.appendChild(create); box.appendChild(act);
    }

    if (s.type === 'form') {
      var fv = {}; s.fields.forEach(function (f) { fv[f.id] = getPath(state.config, f.bind); });
      box.appendChild(formRows(s.fields, fv));
      var a2 = el('div', undefined, 'actions');
      var save = el('button', 'Save', 'btn'); save.type = 'button';
      save.addEventListener('click', function () {
        s.fields.forEach(function (f) { setPath(state.config, f.bind, fv[f.id]); });
        go(current, 'Saved. Apply the policy to put the change into effect.'); send();
      });
      a2.appendChild(save); box.appendChild(a2);
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
    $('devinfo').textContent = [lab.device.hostname, lab.device.policy ? 'Policy: ' + lab.device.policy : ''].filter(Boolean).join('  |  ');
    $('apply').textContent = lab.applyLabel;
    $('apply').addEventListener('click', function () {
      state.applied = clone(state.config); flash = 'Policy applied.'; renderScreen(); renderBar(); send();
    });
    $('reset').addEventListener('click', function () {
      lastTest = null;
      send({ reset: true }).then(function () { current = null; go(lab.startScreen || Object.keys(lab.screens)[0]); });
    });
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
