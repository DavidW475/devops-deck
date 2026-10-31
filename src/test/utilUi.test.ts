import * as assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { WebviewPanel } from 'vscode';
import { AdoError } from '../client';
import {
  asText, avatarHtml, avatarHue, duration, guarded, inSequence, LINK_PICKER_SCRIPT, linkPickerHtml, LIVE_UPDATE_SCRIPT, LivePanel, mapLimit, nonce, panelHtml,
  plural, renderMarkdown, sanitizeHtml, showError, timeAgo, viewButtonsHtml,
} from '../util';
import { cspNonce, FakeWebview, FakeWebviewPanel, flush, inlineScript } from './fakeWebview';
import * as vscode from './vscodeStub';

describe('util: text helpers', () => {
  it('plural picks singular, default and custom plurals', () => {
    assert.equal(plural(1, 'file'), '1 file');
    assert.equal(plural(3, 'file'), '3 files');
    assert.equal(plural(0, 'query', 'queries'), '0 queries');
  });

  it('asText turns any value into text', () => {
    assert.equal(asText('x'), 'x');
    assert.equal(asText(3), '3');
    assert.equal(asText(false), 'false');
    assert.equal(asText(10n), '10');
    assert.equal(asText(null), '');
    assert.equal(asText(undefined), '');
    assert.equal(asText({ a: [1] }), '{"a":[1]}');
    assert.equal(asText(() => 1), '', 'values JSON cannot represent become empty');
  });

  it('nonce is random base64', () => {
    const a = nonce();
    assert.match(a, /^[A-Za-z0-9+/]{22}==$/);
    assert.notEqual(a, nonce());
  });

  it('timeAgo shows a date for old timestamps, duration runs until now', () => {
    const old = '2020-01-01T00:00:00Z';
    assert.equal(timeAgo(old), new Date(old).toLocaleDateString());
    assert.match(duration(new Date(Date.now() - 5000).toISOString()), /^\d+s$/);
  });

  it('avatarHtml escapes the name and derives a stable hue', () => {
    assert.equal(avatarHue('Lena Hoffmann'), avatarHue('Lena Hoffmann'));
    assert.equal(avatarHue(), 0);
    const html = avatarHtml('<Ana> Silva', 20);
    assert.match(html, /title="&lt;Ana&gt; Silva"/);
    assert.match(html, />&lt;S<\/span>$/, 'initials are escaped too');
    assert.match(html, /width:20px;height:20px;font-size:8px/);
  });

  it('toolbar and link picker HTML', () => {
    assert.match(viewButtonsHtml(), /data-action="browser"[\s\S]*data-action="refresh"/);
    assert.match(linkPickerHtml('Search "items"'), /data-picker="link".*placeholder="Search &quot;items&quot;"/);
    assert.match(linkPickerHtml('People', 'reviewer'), /data-picker="reviewer".*name="linker-reviewer"/);
  });
});

describe('util: async helpers', () => {
  it('inSequence runs one item after the other', async () => {
    const log: string[] = [];
    await inSequence([30, 1, 10], async n => {
      log.push(`start ${n}`);
      await new Promise(r => setTimeout(r, n));
      log.push(`end ${n}`);
    });
    assert.deepEqual(log, ['start 30', 'end 30', 'start 1', 'end 1', 'start 10', 'end 10']);
    await inSequence([], () => assert.fail('not called'));
  });

  it('inSequence stops at the first failure', async () => {
    const seen: number[] = [];
    await assert.rejects(inSequence([1, 2, 3], n => {
      seen.push(n);
      if (n === 2) {
        throw new Error('stop');
      }
    }), /stop/);
    assert.deepEqual(seen, [1, 2]);
  });

  it('mapLimit handles empty input and limits above the item count', async () => {
    assert.deepEqual(await mapLimit([], 4, async () => 1), []);
    assert.deepEqual(await mapLimit(['a', 'b'], 10, async (s, i) => `${s}${i}`), ['a0', 'b1']);
  });
});

describe('util: VS Code integration', () => {
  beforeEach(() => vscode.reset());

  it('showError offers sign-in for auth errors', async () => {
    vscode.answers.message.push('Sign In');
    await showError(new AdoError('Azure DevOps rejected the credentials.', 401, true));
    assert.deepEqual(vscode.messages, ['DevOps Deck: Azure DevOps rejected the credentials.']);
    assert.deepEqual(vscode.executed, [['azureDevOps.signIn']]);
    vscode.answers.message.push('Use PAT');
    await showError(new AdoError('x', 401, true));
    assert.deepEqual(vscode.executed.at(-1), ['azureDevOps.setPat']);
    await showError(new AdoError('x', 401, true));
    assert.equal(vscode.executed.length, 2, 'dismissed: no command');
  });

  it('guarded shows failures instead of throwing', async () => {
    const ok = guarded(async (n: number) => n * 2);
    await ok(2);
    assert.deepEqual(vscode.messages, []);
    await guarded(async () => { throw new Error('TF401019: not found'); })();
    await flush();
    assert.deepEqual(vscode.messages, ['DevOps Deck: TF401019: not found']);
  });

  it('renderMarkdown sanitizes the rendered HTML and falls back to escaped text', async () => {
    vscode.commandResults['markdown.api.render'] = '<p>Hi</p><script>alert(1)</script>';
    assert.equal(await renderMarkdown('Hi'), '<p>Hi</p>');
    assert.deepEqual(vscode.executed.at(-1), ['markdown.api.render', 'Hi']);
    delete vscode.commandResults['markdown.api.render'];
    assert.equal(await renderMarkdown('x'), '');
    const execute = vscode.commands.executeCommand;
    vscode.commands.executeCommand = async () => { throw new Error('no markdown extension'); };
    try {
      assert.equal(await renderMarkdown('<b>x</b>'), '<pre>&lt;b&gt;x&lt;/b&gt;</pre>');
    } finally {
      vscode.commands.executeCommand = execute;
    }
  });

  it('panelHtml puts every script under one nonce in a strict CSP', () => {
    const webview = new FakeWebview();
    const html = panelHtml(webview as never, vscode.Uri.file('/ext') as never, '<Title>', '<main></main>', 'run();', 'panel.js');
    const n = cspNonce(html);
    assert.ok(n);
    assert.match(html, /default-src 'none'/);
    assert.match(html, /<title>&lt;Title&gt;<\/title>/);
    assert.equal(html.split(`nonce="${n}"`).length - 1, 2);
    assert.match(html, /src="vscode-webview:\/\/fake\/file:\/\/\/ext\/media\/panel\.js"/);
    assert.match(html, /const vscode = acquireVsCodeApi\(\);run\(\);/);
    assert.doesNotMatch(panelHtml(webview as never, vscode.Uri.file('/ext') as never, 't', '', ''), /panel\.js/);
  });
});

describe('sanitizeHtml: more markup', () => {
  it('reads attribute values with spaces, single quotes, no quotes or no closing quote', () => {
    assert.equal(sanitizeHtml('<td colspan = 2 rowspan=\'3\' title>x</td>'), '<td colspan="2" rowspan="3" title="">x</td>');
    assert.equal(sanitizeHtml('<p title="a>b">x</p>'), '<p title="a&gt;b">x</p>');
    assert.equal(sanitizeHtml('<p =x class=y>z</p>'), '<p class="y">z</p>');
  });

  it('drops doctypes, processing instructions, unknown tags and unterminated comments', () => {
    assert.equal(sanitizeHtml('<!DOCTYPE html><?xml version="1.0"?><custom-tag>t</custom-tag>'), 't');
    assert.equal(sanitizeHtml('a<!-- never closed <p>b</p>'), 'a');
    assert.equal(sanitizeHtml('<br></br><hr/>'), '<br><hr>');
  });

  it('decodes numeric entities in URLs before checking them', () => {
    assert.equal(sanitizeHtml('<a href="&#x6A;avascript:x">l</a>'), '<a rel="noreferrer noopener">l</a>');
    assert.equal(sanitizeHtml('<a href="&#0;https://x">l</a>'), '<a href="https://x" rel="noreferrer noopener">l</a>');
    assert.equal(sanitizeHtml('<a href="mailto:alex@contoso.com">m</a>'), '<a href="mailto:alex@contoso.com" rel="noreferrer noopener">m</a>');
    assert.equal(sanitizeHtml('<a href="/relative?x=&unknown;">r</a>'), '<a href="/relative?x=&amp;unknown;" rel="noreferrer noopener">r</a>');
  });
});

describe('LivePanel', () => {
  const ext = vscode.Uri.file('/ext') as never;
  const create = () => {
    const fake = new FakeWebviewPanel('azureDevOps.test', 'Test', 1, {});
    return { fake, live: new LivePanel(fake as unknown as WebviewPanel, ext, 'page();') };
  };

  it('writes the document once and then updates #root in place', () => {
    const { fake, live } = create();
    live.idle();
    assert.deepEqual(fake.webview.posted, [], 'nothing to tell a page that is not live yet');
    live.show('<First>', '<p>one</p>');
    const html = fake.webview.html;
    assert.ok(html.includes('<title>&lt;First&gt;</title>'));
    assert.ok(html.includes('<body><div id="root"><p>one</p></div><script nonce="'));
    const script = inlineScript(html);
    assert.ok(script.startsWith('const vscode = acquireVsCodeApi();'));
    assert.ok(script.indexOf('window.postAction') < script.indexOf('page();'), 'the live update script runs before the page script');

    live.show('Second', '<p>two</p>');
    live.idle();
    live.post({ type: 'linkResults', seq: 1, items: [] });
    assert.equal(fake.webview.htmlWrites, 1);
    assert.deepEqual(fake.webview.posted, [
      { type: 'update', title: 'Second', html: '<p>two</p>' },
      { type: 'idle' },
      { type: 'linkResults', seq: 1, items: [] },
    ]);
    assert.equal(fake.webview.content, '<p>two</p>');
  });

  it('posts idle after actions that change nothing or fail', async () => {
    const { fake, live } = create();
    live.show('T', '');
    assert.equal(await live.action(async () => true), true);
    assert.equal(fake.webview.ofType('idle').length, 0);
    assert.equal(await live.action(async () => false), false);
    assert.equal(fake.webview.ofType('idle').length, 1);
    await assert.rejects(live.action(async () => { throw new Error('TF400898: failed'); }), /TF400898/);
    assert.equal(fake.webview.ofType('idle').length, 2);
  });

  it('does nothing once the panel is disposed', () => {
    const { fake, live } = create();
    live.show('T', '<p>one</p>');
    fake.dispose();
    live.show('T', '<p>two</p>');
    live.idle();
    live.post({ type: 'x' });
    assert.equal(fake.webview.htmlWrites, 1);
    assert.deepEqual(fake.webview.posted, []);

    const closed = create();
    closed.fake.dispose();
    closed.live.show('T', '<p>late</p>');
    assert.equal(closed.fake.webview.htmlWrites, 0, 'a render that finishes after closing does not touch the webview');
  });

  it('page scripts bind only delegated listeners', () => {
    assert.ok(!/(input|list|box)\.addEventListener/.test(LINK_PICKER_SCRIPT), 'no listeners on elements that an update replaces');
    for (const event of ['update', 'idle', 'panel:updated', 'updating']) {
      assert.ok(LIVE_UPDATE_SCRIPT.includes(`'${event}'`), event);
    }
  });
});
