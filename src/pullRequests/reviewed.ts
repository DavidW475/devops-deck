import * as vscode from 'vscode';
import { ConnectionManager } from '../connection';
import { PR_SCHEME, parsePrUri } from './prFiles';

export interface ReviewedChange {
  repoId: string;
  prId: number;
  path: string;
  version: string;
  reviewed: boolean;
}

/**
 * Per-user "reviewed" check marks for PR files, like the checkboxes in the Azure DevOps web UI.
 * Stored locally (the web UI's storage isn't public API). A mark belongs to a file version, so it
 * disappears when a later iteration changes the file again.
 */
export class ReviewedFiles implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ReviewedChange>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [this.emitter];

  constructor(private readonly memento: vscode.Memento, private readonly connections: ConnectionManager) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
      this.onDidChange(() => this.updateContext()),
      vscode.commands.registerCommand('azureDevOps.pr.markReviewed', () => this.toggleActive(true)),
      vscode.commands.registerCommand('azureDevOps.pr.unmarkReviewed', () => this.toggleActive(false)),
    );
    this.updateContext();
  }

  private key(repoId: string, prId: number): string {
    return `reviewed:${this.connections.current?.orgUrl ?? ''}/${repoId}/${prId}`;
  }

  isReviewed(repoId: string, prId: number, path: string, version: string): boolean {
    return this.memento.get<Record<string, string>>(this.key(repoId, prId), {})[path] === version;
  }

  async set(repoId: string, prId: number, path: string, version: string, reviewed: boolean): Promise<void> {
    const key = this.key(repoId, prId);
    const map = { ...this.memento.get<Record<string, string>>(key, {}) };
    if (reviewed) {
      map[path] = version;
    } else {
      delete map[path];
    }
    await this.memento.update(key, Object.keys(map).length ? map : undefined);
    this.emitter.fire({ repoId, prId, path, version, reviewed });
  }

  /** The PR file shown in the active diff, identified by its right (new) side. */
  private activeFile(): { repoId: string; prId: number; path: string; version: string } | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme !== PR_SCHEME) {
      return undefined;
    }
    const q = parsePrUri(uri);
    let right = q.side === 'right' ? uri : undefined;
    if (!right) {
      // Left side focused: find the matching right side among the visible diff editors.
      right = vscode.window.visibleTextEditors.map(e => e.document.uri).find(u => {
        if (u.scheme !== PR_SCHEME) {
          return false;
        }
        const r = parsePrUri(u);
        return r.side === 'right' && r.repo === q.repo && r.pr === q.pr && r.ct === q.ct;
      });
    }
    if (!right) {
      return undefined;
    }
    const r = parsePrUri(right);
    return { repoId: r.repo, prId: r.pr, path: right.path, version: r.obj || 'deleted' };
  }

  private async toggleActive(reviewed: boolean): Promise<void> {
    const f = this.activeFile();
    if (f) {
      await this.set(f.repoId, f.prId, f.path, f.version, reviewed);
    }
  }

  private updateContext(): void {
    const f = this.activeFile();
    void vscode.commands.executeCommand('setContext', 'azureDevOps.fileReviewed', !!f && this.isReviewed(f.repoId, f.prId, f.path, f.version));
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}

/** Version string matching ReviewedFiles.activeFile for a PR change entry. */
export function changeVersion(change: { changeType: string; item: { objectId?: string } }): string {
  return change.changeType.includes('delete') ? 'deleted' : change.item.objectId ?? 'deleted';
}
