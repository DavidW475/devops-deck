import * as assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openedDocs, quickPicks, resetExtras, shownDocs } from './vscodeExtras';
import * as vscode from './vscodeStub';
import { AdoClient, AdoError } from '../client';
import { Wiki, WikiPage } from '../types';
import { openWiki, WikiFileSystem, wikiUri } from '../wiki/wiki';

const WIKI: Wiki = { id: 'w1', name: 'Fabrikam Shop.wiki', type: 'projectWiki' } as Wiki;
const CODE_WIKI: Wiki = { id: 'w2', name: 'Docs', type: 'codeWiki' } as Wiki;
const flush = () => new Promise(r => setImmediate(r));

describe('wikiUri', () => {
  it('maps pages to Markdown files of the wiki and the root to Home', () => {
    const uri = wikiUri(WIKI, '/Guides/Release');
    assert.equal(uri.scheme, 'ado-wiki');
    assert.equal(uri.path, '/Fabrikam Shop.wiki/Guides/Release.md');
    assert.equal(new URLSearchParams(uri.query).get('wiki'), 'w1');
    assert.equal(wikiUri(WIKI, '/').path, '/Fabrikam Shop.wiki/Home.md');
  });
});

describe('WikiFileSystem', () => {
  const uri = wikiUri(WIKI, '/Guides/Release') as any;

  it('reads pages, keeps the time for unchanged content and sends the ETag on save', async () => {
    const saved: unknown[][] = [];
    let content = 'Hello';
    const client = {
      getWikiPage: async (id: string, p: string) => { assert.equal(id, 'w1'); assert.equal(p, '/Guides/Release'); return { content, etag: '"e1"' }; },
      saveWikiPage: async (...a: unknown[]) => { saved.push(a); return '"e2"'; },
    } as unknown as AdoClient;
    const fs = new WikiFileSystem(client);
    assert.deepEqual(fs.stat(uri), { type: vscode.FileType.File, ctime: 0, size: 0, mtime: 0 });
    assert.equal(new TextDecoder().decode(await fs.readFile(uri)), 'Hello');
    const first = fs.stat(uri);
    assert.equal(first.size, 5);
    await new Promise(r => setTimeout(r, 2));
    await fs.readFile(uri);
    assert.equal(fs.stat(uri).mtime, first.mtime);
    content = 'Hello, world';
    await fs.readFile(uri);
    assert.equal(fs.stat(uri).size, 12);

    const changes: unknown[] = [];
    fs.onDidChangeFile(e => changes.push(...e));
    await fs.writeFile(uri, new TextEncoder().encode('New'));
    await fs.writeFile(uri, new TextEncoder().encode('Newer'));
    assert.deepEqual(saved, [['w1', '/Guides/Release', 'New', '"e1"'], ['w1', '/Guides/Release', 'Newer', '"e2"']]);
    assert.equal(fs.stat(uri).size, 5);
    assert.equal(changes.length, 2);
  });

  it('maps a missing page to FileNotFound and passes other errors on', async () => {
    let err: Error = new AdoError('gone', 404);
    const fs = new WikiFileSystem({ getWikiPage: async () => { throw err; } } as unknown as AdoClient);
    await assert.rejects(fs.readFile(uri), (e: Error) => e instanceof vscode.FileSystemError && e.message.startsWith('not found'));
    err = new AdoError('server', 500);
    await assert.rejects(fs.readFile(uri), /server/);
  });

  it('refuses to overwrite a page someone else changed', async () => {
    let err: Error = new AdoError('conflict', 412);
    const fs = new WikiFileSystem({ saveWikiPage: async () => { throw err; } } as unknown as AdoClient);
    await assert.rejects(fs.writeFile(uri, new Uint8Array()), /Someone else changed this page/);
    err = new AdoError('conflict', 409);
    await assert.rejects(fs.writeFile(uri, new Uint8Array()), /Someone else changed this page/);
    err = new Error('offline');
    await assert.rejects(fs.writeFile(uri, new Uint8Array()), /offline/);
  });

  it('supports no directories, deleting or renaming', () => {
    const fs = new WikiFileSystem({} as AdoClient);
    fs.watch().dispose();
    assert.deepEqual(fs.readDirectory(), []);
    assert.throws(() => fs.createDirectory(), /Not supported/);
    assert.throws(() => fs.delete(), /Delete wiki pages in the browser/);
    assert.throws(() => fs.rename(), /Rename wiki pages in the browser/);
  });
});

function tree(): WikiPage {
  return {
    path: '/', subPages: [
      { path: '/Guides', order: 1, subPages: [{ path: '/Guides/Release process', order: 0 }] },
      { path: '/Home', order: 0 },
    ],
  } as WikiPage;
}

function wikiClient(wikis: Wiki[], org = 'https://dev.azure.com/contoso') {
  const calls = { tree: 0, saved: [] as unknown[][] };
  let fail = false;
  const client = {
    connection: { orgUrl: org, project: 'Fabrikam Shop' },
    listWikis: async () => wikis,
    getWikiPageTree: async () => {
      calls.tree++;
      if (fail) {
        throw new Error('forbidden');
      }
      return tree();
    },
    saveWikiPage: async (...a: unknown[]) => { calls.saved.push(a); return '"e"'; },
  } as unknown as AdoClient;
  return { client, calls, failNext: () => { fail = true; } };
}

describe('openWiki', () => {
  let picks: unknown[];
  let inputs: unknown[];
  let inputOptions: any;

  beforeEach(() => {
    vscode.reset();
    resetExtras();
    picks = [];
    inputs = [];
    (vscode.window as any).showQuickPick = async (items: any[]) => (picks.length ? picks.shift() : items[0]);
    (vscode.window as any).showInputBox = async (o: any) => { inputOptions = o; return inputs.shift(); };
  });

  it('tells when the project has no wiki', async () => {
    await openWiki(wikiClient([]).client);
    assert.deepEqual(vscode.messages, ['This project has no wiki yet.']);
    assert.equal(quickPicks.length, 0);
  });

  it('asks which wiki to open and stops when cancelled', async () => {
    picks = [undefined];
    await openWiki(wikiClient([WIKI, CODE_WIKI], 'https://dev.azure.com/fabrikam').client);
    assert.equal(quickPicks.length, 0);
  });

  it('lists pages in wiki order and previews the accepted page', async () => {
    await openWiki(wikiClient([WIKI]).client);
    const qp = quickPicks[0];
    await flush();
    assert.equal(qp.title, 'Fabrikam Shop.wiki wiki');
    assert.equal(qp.busy, false);
    assert.deepEqual(qp.items.map(i => i.label), ['$(book) Home', '$(book) Guides', '$(book) Release process', '$(add) New page…']);
    assert.equal(qp.items[2].description, 'Guides');
    qp.selectedItems = [qp.items[2]];
    qp.fire('accept');
    assert.equal(vscode.executed[0][0], 'markdown.showPreview');
    assert.equal((vscode.executed[0][1] as vscode.Uri).path, '/Fabrikam Shop.wiki/Guides/Release process.md');
    assert.ok(qp.disposed);
  });

  it('opens a page for editing or in the browser from the item buttons', async () => {
    const { client } = wikiClient([CODE_WIKI]);
    await openWiki(client);
    await flush();
    const qp = quickPicks[0];
    const [edit, browser] = qp.items[0].buttons;
    qp.fire('itemButton', { item: qp.items[3], button: edit });
    qp.fire('itemButton', { item: qp.items[0], button: edit });
    await flush();
    assert.equal((openedDocs[0] as vscode.Uri).path, '/Docs/Home.md');
    assert.equal(shownDocs.length, 1);
    qp.fire('itemButton', { item: qp.items[2], button: browser });
    assert.equal(vscode.opened.length, 1);
    assert.ok(vscode.opened[0].endsWith('/contoso/Fabrikam%20Shop/_wiki/wikis/Docs?pagePath=%2FGuides%2FRelease%20process'));
  });

  it('reloads the page tree from the server with the refresh button and shows errors', async () => {
    const { client, calls, failNext } = wikiClient([{ ...WIKI, id: 'w9' }]);
    await openWiki(client);
    await flush();
    assert.equal(calls.tree, 1);
    await openWiki(client);
    await flush();
    assert.equal(calls.tree, 1, 'second open uses the cached tree');
    failNext();
    quickPicks[1].fire('button');
    assert.equal(quickPicks[1].busy, true);
    await flush();
    assert.equal(calls.tree, 2);
    assert.equal(quickPicks[1].placeholder, 'Could not load pages: forbidden');
    assert.equal(quickPicks[1].busy, false);
  });

  it('creates a new page from the typed text and opens it', async () => {
    const { client, calls } = wikiClient([{ ...WIKI, id: 'w3' }]);
    await openWiki(client);
    await flush();
    const qp = quickPicks[0];
    qp.value = '  Guides/Onboarding ';
    qp.selectedItems = [qp.items[qp.items.length - 1]];
    inputs = ['/Guides/Onboarding/'];
    qp.fire('accept');
    await flush();
    assert.equal(inputOptions.value, 'Guides/Onboarding');
    assert.equal(inputOptions.validateInput(' '), 'Enter a page name');
    assert.equal(inputOptions.validateInput('x'), undefined);
    assert.deepEqual(calls.saved, [['w3', '/Guides/Onboarding', '# Onboarding\n']]);
    assert.equal((openedDocs[0] as vscode.Uri).path, '/Fabrikam Shop.wiki/Guides/Onboarding.md');
  });

  it('does nothing when the new page name is cancelled or nothing is selected', async () => {
    const { client, calls } = wikiClient([{ ...WIKI, id: 'w4' }]);
    await openWiki(client);
    await flush();
    const qp = quickPicks[0];
    qp.selectedItems = [qp.items[qp.items.length - 1]];
    qp.fire('accept');
    await flush();
    qp.selectedItems = [];
    qp.fire('accept');
    assert.deepEqual(calls.saved, []);
    assert.equal(vscode.executed.length, 0);
  });
});
