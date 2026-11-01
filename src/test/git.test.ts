import * as assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Connection, ConnectionManager, gitApi, trimSlashes } from '../connection';
import { adoRemoteOf, adoRepoForFile, currentBranch, describeCommits, isInside, localAdoRepos, pickLocalRepo, titleFromBranch } from '../git';
import * as vscode from './vscodeStub';

interface FakeRepo { rootUri: { fsPath: string }; state: { HEAD?: { name?: string }; remotes: { name: string; fetchUrl?: string; pushUrl?: string }[] } }

const remote = (repo: string, project = 'Fabrikam%20Shop', org = 'contoso') => `https://dev.azure.com/${org}/${project}/_git/${repo}`;

function repo(root: string, remotes: FakeRepo['state']['remotes'], branch?: string): FakeRepo {
  return { rootUri: { fsPath: root }, state: { HEAD: { name: branch }, remotes } };
}

let openListeners: (() => void)[];

function useGit(repos: FakeRepo[]): void {
  vscode.extensionExports['vscode.git'] = {
    getAPI: () => ({ repositories: repos, onDidOpenRepository: (l: () => void) => { openListeners.push(l); return { dispose() { /* stub */ } }; } }),
  };
}

const CONN: Connection = { orgUrl: 'https://dev.azure.com/contoso', project: 'Fabrikam Shop', projects: ['Fabrikam Shop', 'Northwind'], detected: false };
const win = vscode.window as Record<string, unknown>;

describe('git helpers with the git extension', () => {
  beforeEach(() => {
    vscode.reset();
    openListeners = [];
  });
  afterEach(() => { delete win.activeTextEditor; });

  it('localAdoRepos prefers origin and keeps only repos of the selected projects', () => {
    useGit([
      repo('/src/web', [{ name: 'fork', fetchUrl: remote('web-fork') }, { name: 'origin', fetchUrl: remote('web-shop') }], 'main'),
      repo('/src/api', [{ name: 'upstream', pushUrl: remote('api', 'Northwind') }]),
      repo('/src/other', [{ name: 'origin', fetchUrl: remote('x', 'Tailspin') }, { name: 'gh', fetchUrl: 'https://github.com/contoso/x.git' }]),
      repo('/src/elsewhere', [{ name: 'origin', fetchUrl: remote('y', 'Fabrikam%20Shop', 'adventure-works') }, { name: 'empty' }]),
    ]);
    const repos = localAdoRepos(CONN);
    assert.deepEqual(repos.map(r => [r.repo.rootUri.fsPath, r.remoteName, r.repoName, r.project]), [
      ['/src/web', 'origin', 'web-shop', 'Fabrikam Shop'],
      ['/src/api', 'upstream', 'api', 'Northwind'],
    ]);
  });

  it('localAdoRepos finds a repo whose first ADO remote is not selected but second is', () => {
    useGit([repo('/src/web', [{ name: 'origin', fetchUrl: remote('x', 'Tailspin') }, { name: 'second', fetchUrl: remote('api', 'Northwind') }])]);
    assert.deepEqual(localAdoRepos(CONN).map(r => [r.remoteName, r.repoName, r.project]), [['second', 'api', 'Northwind']]);
  });

  it('localAdoRepos is empty without a connection or git', () => {
    assert.deepEqual(localAdoRepos(undefined), []);
    assert.deepEqual(localAdoRepos(CONN), []);
    assert.equal(gitApi(), undefined);
  });

  it('localAdoRepos falls back to the primary project when no list is given', () => {
    useGit([repo('/src/web', [{ name: 'origin', fetchUrl: remote('web-shop') }])]);
    const conn = { ...CONN, projects: undefined } as unknown as Connection;
    assert.equal(localAdoRepos(conn)[0].project, 'Fabrikam Shop');
  });

  it('pickLocalRepo returns the only repository without asking', async () => {
    useGit([repo('/src/web', [{ name: 'origin', fetchUrl: remote('web-shop') }])]);
    assert.equal((await pickLocalRepo(CONN, 'Create PR'))?.repoName, 'web-shop');
    assert.equal(vscode.prompts.quickPick, undefined);
  });

  it('pickLocalRepo uses the innermost repository of the active editor', async () => {
    useGit([
      repo('/src/web', [{ name: 'origin', fetchUrl: remote('web-shop') }]),
      repo('/src/web/packages/ui', [{ name: 'origin', fetchUrl: remote('ui-kit') }]),
    ]);
    win.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: '/src/web/packages/ui/button.ts' } } };
    assert.equal((await pickLocalRepo(CONN, 'Create PR'))?.repoName, 'ui-kit');
  });

  it('pickLocalRepo asks when the active editor is outside every repository', async () => {
    const web = repo('/src/web', [{ name: 'origin', fetchUrl: remote('web-shop') }], 'feature/login');
    useGit([web, repo('/src/api', [{ name: 'origin', fetchUrl: remote('api') }])]);
    win.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: '/home/alex/notes.md' } } };
    vscode.answers.quickPick.push(undefined);
    assert.equal(await pickLocalRepo(CONN, 'Create PR'), undefined, 'cancelled');
    const shown = vscode.prompts.quickPick as { items: { label: string; description: string; detail?: string; r: unknown }[]; options: { title: string } };
    assert.deepEqual(shown.items.map(i => [i.label, i.description, i.detail]), [['web', 'web-shop', 'feature/login'], ['api', 'api', undefined]]);
    assert.equal(shown.options.title, 'Create PR');
    vscode.answers.quickPick.push(shown.items[1]);
    assert.equal((await pickLocalRepo(CONN, 'Create PR'))?.repoName, 'api');
  });

  it('pickLocalRepo ignores non-file editors', async () => {
    useGit([repo('/src/web', [{ name: 'origin', fetchUrl: remote('web-shop') }]), repo('/src/api', [{ name: 'origin', fetchUrl: remote('api') }])]);
    win.activeTextEditor = { document: { uri: { scheme: 'untitled', fsPath: '/src/web/x' } } };
    vscode.answers.quickPick.push(undefined);
    await pickLocalRepo(CONN, 'Pick');
    assert.ok(vscode.prompts.quickPick, 'asked instead of guessing');
  });

  it('small helpers', () => {
    assert.ok(isInside('/src/web/a.ts', '/src/web'));
    assert.ok(!isInside('/src/web', '/src/web'));
    assert.ok(!isInside('/src/api/a.ts', '/src/web'));
    assert.equal(currentBranch({ state: { HEAD: { name: 'main' } } }), 'main');
    assert.equal(currentBranch({ state: { HEAD: { name: '' } } }), undefined);
    assert.equal(currentBranch(undefined), undefined);
    assert.equal(titleFromBranch('feature/1234'), 'feature/1234');
    assert.deepEqual(describeCommits('feature/x', ['Fix login\n\nDetails here']), { title: 'Fix login', description: 'Details here' });
    assert.deepEqual(describeCommits('feature/fix-login', []), { title: 'Fix login', description: '' });
  });
});

describe('adoRepoForFile and adoRemoteOf', () => {
  const FILE = { fsPath: '/src/web/a.ts' };
  function useGetRepository(getRepository: ((uri: { fsPath: string }) => FakeRepo | null) | undefined): void {
    vscode.extensionExports['vscode.git'] = { getAPI: () => ({ repositories: [], getRepository }) };
  }

  beforeEach(() => vscode.reset());

  it('returns the Azure Repos remote of the file repository', () => {
    useGetRepository(() => repo('/src/web', [{ name: 'origin', fetchUrl: remote('web-shop') }]));
    const r = adoRepoForFile(CONN, FILE);
    assert.deepEqual([r?.remoteName, r?.repoName, r?.project], ['origin', 'web-shop', 'Fabrikam Shop']);
  });

  it('is undefined for a GitHub remote', () => {
    useGetRepository(() => repo('/src/web', [{ name: 'origin', fetchUrl: 'https://github.com/contoso/x.git' }]));
    assert.equal(adoRepoForFile(CONN, FILE), undefined);
  });

  it('finds the ADO remote among mixed remotes and prefers origin', () => {
    useGetRepository(() => repo('/src/web', [
      { name: 'gh', fetchUrl: 'https://github.com/contoso/x.git' },
      { name: 'fork', fetchUrl: remote('web-fork') },
      { name: 'origin', fetchUrl: remote('web-shop') },
    ]));
    assert.equal(adoRepoForFile(CONN, FILE)?.repoName, 'web-shop');
    useGetRepository(() => repo('/src/web', [{ name: 'gh', fetchUrl: 'https://github.com/contoso/x.git' }, { name: 'up', pushUrl: remote('api') }]));
    assert.equal(adoRepoForFile(CONN, FILE)?.remoteName, 'up');
  });

  it('is undefined for another organization', () => {
    useGetRepository(() => repo('/src/web', [{ name: 'origin', fetchUrl: remote('web-shop', 'Fabrikam%20Shop', 'adventure-works') }]));
    assert.equal(adoRepoForFile(CONN, FILE), undefined);
  });

  it('accepts a project that is not selected and decodes it', () => {
    useGetRepository(() => repo('/src/web', [{ name: 'origin', fetchUrl: remote('web-shop', 'Tailspin%20Toys') }]));
    assert.equal(adoRepoForFile(CONN, FILE)?.project, 'Tailspin Toys');
  });

  it('is undefined without a connection, a repository or getRepository', () => {
    useGetRepository(() => repo('/src/web', [{ name: 'origin', fetchUrl: remote('web-shop') }]));
    assert.equal(adoRepoForFile(undefined, FILE), undefined);
    useGetRepository(() => null);
    assert.equal(adoRepoForFile(CONN, FILE), undefined);
    useGetRepository(undefined);
    assert.equal(adoRepoForFile(CONN, FILE), undefined);
    delete vscode.extensionExports['vscode.git'];
    assert.equal(adoRepoForFile(CONN, FILE), undefined);
  });

  it('uses the repository getRepository returns for a submodule file', () => {
    const outer = repo('/src/web', [{ name: 'origin', fetchUrl: remote('web-shop') }]);
    const sub = repo('/src/web/libs/ui', [{ name: 'origin', fetchUrl: remote('ui-kit', 'Northwind') }]);
    vscode.extensionExports['vscode.git'] = { getAPI: () => ({ repositories: [outer, sub], getRepository: () => sub }) };
    const r = adoRepoForFile(CONN, { fsPath: '/src/web/libs/ui/b.ts' });
    assert.deepEqual([r?.repo, r?.repoName, r?.project], [sub, 'ui-kit', 'Northwind']);
  });

  it('adoRemoteOf works on a repo directly and without a connection', () => {
    const r = repo('/src/web', [{ name: 'origin', fetchUrl: remote('web-shop') }]);
    assert.equal(adoRemoteOf(r, CONN)?.repoName, 'web-shop');
    assert.equal(adoRemoteOf(r, undefined), undefined);
  });
});

describe('ConnectionManager', () => {
  let m: ConnectionManager;
  let changes: number;

  beforeEach(() => {
    vscode.reset();
    openListeners = [];
    m = new ConnectionManager();
    changes = 0;
    m.onDidChange(() => changes++);
  });
  afterEach(() => m.dispose());

  it('reads organization, project and additional projects from the settings', async () => {
    vscode.settings['azureDevOps.organization'] = 'contoso';
    vscode.settings['azureDevOps.project'] = 'Fabrikam Shop';
    vscode.settings['azureDevOps.additionalProjects'] = [' Northwind ', 'fabrikam shop', '', 'Northwind'];
    await m.resolve();
    assert.deepEqual(m.current, { orgUrl: 'https://dev.azure.com/contoso', project: 'Fabrikam Shop', projects: ['Fabrikam Shop', 'Northwind'], detected: false });
    assert.deepEqual(vscode.executed.at(-1), ['setContext', 'azureDevOps.configured', true]);
    assert.equal(changes, 1);
    await m.resolve();
    assert.equal(changes, 1, 'no event without a change');
  });

  it('detects organization and project from a git remote', async () => {
    useGit([repo('/src/x', [{ name: 'gh', fetchUrl: 'https://github.com/contoso/x.git' }]), repo('/src/web', [{ name: 'origin', pushUrl: remote('web-shop') }])]);
    await m.resolve();
    assert.equal(m.current?.orgUrl, 'https://dev.azure.com/contoso');
    assert.equal(m.current?.project, 'Fabrikam Shop');
    assert.equal(m.current?.detected, true);
  });

  it('keeps a configured organization and only fills in the project', async () => {
    vscode.settings['azureDevOps.organization'] = 'https://dev.azure.com/contoso/';
    useGit([repo('/src/web', [{ name: 'origin', fetchUrl: remote('web-shop', 'Northwind') }])]);
    await m.resolve();
    assert.equal(m.current?.project, 'Northwind');
    assert.equal(m.current?.detected, false);
  });

  it('is unconfigured without settings or remotes', async () => {
    useGit([repo('/src/x', [{ name: 'gh', fetchUrl: 'https://github.com/contoso/x.git' }])]);
    await m.resolve();
    assert.equal(m.current, undefined);
    assert.deepEqual(vscode.executed.at(-1), ['setContext', 'azureDevOps.configured', false]);
    assert.equal(changes, 0);
  });

  it('watchGit resolves again when a repository opens', async () => {
    await m.watchGit();
    assert.equal(vscode.executed.length, 0, 'nothing to do without the git extension');
    const repos: FakeRepo[] = [];
    useGit(repos);
    await m.watchGit();
    assert.equal(m.current === undefined, true);
    repos.push(repo('/src/web', [{ name: 'origin', fetchUrl: remote('web-shop') }]));
    openListeners[0]();
    await new Promise(r => setImmediate(r));
    assert.equal(m.current?.project, 'Fabrikam Shop');
  });

  it('watchGit activates the git extension first', async () => {
    let activated = false;
    const getExtension = vscode.extensions.getExtension;
    vscode.extensions.getExtension = (() => ({ isActive: false, exports: {}, activate: async () => { activated = true; } })) as never;
    try {
      await m.watchGit();
    } finally {
      vscode.extensions.getExtension = getExtension;
    }
    assert.ok(activated);
  });

  it('trimSlashes trims both ends unless told otherwise', () => {
    assert.equal(trimSlashes('//a/b//'), 'a/b');
    assert.equal(trimSlashes('//a/', false), '//a');
    assert.equal(trimSlashes('///'), '');
  });
});
