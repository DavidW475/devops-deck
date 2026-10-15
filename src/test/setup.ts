/* Loaded with --require before the tests: every `import 'vscode'` gets the stub. */
import Module = require('module');
import * as stub from './vscodeStub';

const mod = Module as unknown as { _load(request: string, ...rest: unknown[]): unknown };
const load = mod._load;
mod._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? stub : load.call(this, request, ...rest);
};
