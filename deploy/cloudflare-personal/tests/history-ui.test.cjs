const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.handlers = {};
    this.textContent = '';
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  setAttribute() {}
}

function createContext() {
  const nodes = new Map();
  const calls = [];
  let promptIndex = 0;
  const promptValues = ['Updated action', 'Updated next step', '', '進行中'];
  const event = {
    at_utc: '2026-09-28T01:00:00.000Z', entity_type: 'work_item',
    operation: 'update', entity_id: 'synthetic-item', actor: 'synthetic-owner',
    before_json: '{"title":"Old title","state":"未確認"}',
    after_json: '{"title":"New title","state":"進行中"}',
  };
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new Element());
      return nodes.get(id);
    },
    createElement(tag) { return new Element(tag); },
  };
  const fetch = async (path) => {
    calls.push(path);
    const body = path === '/api/me' ? { email: 'owner@example.com' } :
      path === '/api/projects' ? { projects: [] } :
      path === '/api/events' ? { events: [event] } : { id: 'synthetic-item', version: 2 };
    return { ok: true, json: async () => body };
  };
  const context = vm.createContext({ document, fetch,
    FormData: class {},
    prompt: () => promptValues[promptIndex++],
  });
  vm.runInContext(source, context);
  return { context, nodes, calls };
}

test('history displays actor and before/after values, and item edits refresh it', async () => {
  const { context, nodes, calls } = createContext();
  await new Promise((resolve) => setImmediate(resolve));
  const initialEventCalls = calls.filter((path) => path === '/api/events').length;
  await vm.runInContext(`editItem({ id: 'synthetic-item', title: 'Old title', next_action: '',
    check_date: '', state: '未確認', version: 1, milestone_id: '' })`, context);

  const refreshedEventCalls = calls.filter((path) => path === '/api/events').length;
  assert.equal(refreshedEventCalls, initialEventCalls + 1);
  const entry = nodes.get('events').children[0];
  assert.equal(entry.tagName, 'details');
  assert.match(entry.children[0].textContent, /実行者 synthetic-owner/);
  assert.match(entry.children[1].textContent, /変更前/);
  assert.match(entry.children[1].textContent, /Old title/);
  assert.match(entry.children[1].textContent, /New title/);
});
