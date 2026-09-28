const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
for (const [id, message] of [
  ['project-form', '案件を追加しました。'],
  ['milestone-form', 'マイルストーンを追加しました。'],
  ['item-form', '行動を追加しました。'],
]) {
  test(`${id} keeps its form after asynchronous submission`, async () => {
    const nodes = new Map();
    const document = { getElementById(name) {
      if (!nodes.has(name)) nodes.set(name, {
        handlers: {}, resets: 0, textContent: '',
        addEventListener(type, handler) { this.handlers[type] = handler; },
        replaceChildren() {},
        reset() { this.resets++; },
      });
      return nodes.get(name);
    } };
    const context = vm.createContext({ document,
      FormData: class { constructor(form) { assert.ok(form); } *[Symbol.iterator]() { yield ['name', 'Synthetic']; } },
      fetch: async () => ({ ok: true, json: async () => ({ projects: [], events: [], email: 'owner@example.com' }) }),
    });
    vm.runInContext(source, context);
    await new Promise(resolve => setImmediate(resolve));
    vm.runInContext(`
      state.selected = 'synthetic-project';
      api = async () => { await Promise.resolve(); return { id: 'synthetic-project' }; };
      loadProjects = async () => {};
      selectProject = async () => {};
      loadEvents = async () => {};
    `, context);
    const form = document.getElementById(id);
    const event = { currentTarget: form, preventDefault() {} };
    const submitted = form.handlers.submit(event);
    // Browsers clear currentTarget once the synchronous event dispatch ends.
    event.currentTarget = null;
    await submitted;
    assert.equal(form.resets, 1);
    assert.equal(document.getElementById('message').textContent, message);
  });
}
