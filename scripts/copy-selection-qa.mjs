// Isolated native owner and simulated Tern clipboard only. Never calls pbcopy,
// pbpaste, OS clipboard APIs or the user's daily daemon/window.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { prepareTernQaConfig } from './qa-tern-config.mjs';
const root = resolve(import.meta.dirname, '..'), out = resolve(root, '.prototype/copy-selection', `native-${process.pid}`);
const config = resolve(out, 'config'), control = resolve(out, 'control.sock');
await prepareTernQaConfig(config); await mkdir(resolve(out, 'codex/thread-writer-locks'), { recursive: true });
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, TERN_CONFIG_DIR: config,
  TERN_DAEMON_SOCKET: resolve(out, 'daemon.sock'), CODEX_TERN_CONTROL: control, CODEX_TERN_WEIXIN_DISABLE: '1',
  WB_DATA_DIR: resolve(out, 'workbench'), XDG_STATE_HOME: resolve(out, 'state'), XDG_CACHE_HOME: resolve(out, 'cache'),
  CODEX_HOME: resolve(out, 'codex'), QA_CODEX_HOME: resolve(out, 'codex'), QA_RPC_LOG: resolve(out, 'rpc.jsonl'), TERN_TSP_RECORD: resolve(out, 'wire.jsonl') };
delete env.TERN_WINDOW_SOCKET; delete env.TERN_WINDOW_KEY;
const fd = openSync(resolve(out, 'tern.log'), 'w');
const daemon = spawn('tern', ['daemon', '--socket', env.TERN_DAEMON_SOCKET], { env, stdio: ['ignore', fd, fd] });
let server; const passed = [], limitations = [], screenshots = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function ctl(command) {
  const r = JSON.parse(execFileSync('tern', ['ctl', '--control', control, command], { env, encoding: 'utf8', timeout: 6000, maxBuffer: 4*1024*1024 }));
  if (!r.ok) throw Error(`${command}: ${r.error}`); return r;
}
const tree = selector => ctl(`tree ${selector}`).nodes ?? [];
async function wait(fn, label) { for (let i = 0; i < 80; i++) { if (await fn()) return; await pause(100); } throw Error(`Timeout: ${label}`); }
const shot = name => { const s = ctl(`shot ${name}`); screenshots.push(s); return s; };
async function pastedText(expected, name) {
  ctl('click [data-role="omp.editor"] .sf-editor'); ctl('key Meta+v');
  let actual;
  await wait(async () => {
    const directory = resolve(out, 'state/codex-tern/recovery');
    for (const file of await readdir(directory)) if (file.endsWith('.json')) {
      const state = JSON.parse(await readFile(resolve(directory, file), 'utf8'));
      actual = state.sessions?.find(s => s.id === state.selected)?.draft.text;
      if (actual === expected) return true;
    }
    return false;
  }, `simulated clipboard paste: ${name}`);
  assert.equal(actual, expected);
  await writeFile(resolve(out, `${name}.json`), JSON.stringify({ expected, actual, transport: 'Tern headless memory clipboard -> native paste -> isolated draft' }, null, 2));
  ctl('key Meta+a'); ctl('key Backspace');
}
const source = 'Alpha SELECTME Omega\n\nSecond paragraph.';
try {
  await wait(() => existsSync(env.TERN_DAEMON_SOCKET), 'private daemon');
  server = spawn('tern', ['serve', '--control', control, '--out', out, '--cwd', root], { env, stdio: ['ignore', fd, fd] });
  await wait(() => existsSync(control), 'offscreen renderer');
  const quote = s => "'"+s.replaceAll("'", "'\\''")+"'";
  const keys = ['PATH','TERN_CONFIG_DIR','TERN_DAEMON_SOCKET','CODEX_TERN_CONTROL','CODEX_TERN_WEIXIN_DISABLE','WB_DATA_DIR','XDG_STATE_HOME','XDG_CACHE_HOME','CODEX_HOME','QA_CODEX_HOME','QA_RPC_LOG','TERN_TSP_RECORD'];
  ctl('run '+JSON.stringify(['env', ...keys.map(k=>`${k}=${env[k]}`),process.execPath,resolve(root,'dist/cli.mjs'),'--codex',resolve(root,'test/fixtures/ui-app-server.mjs')].map(quote).join(' ')));
  await wait(() => tree('[data-role="omp.composer.send"]').length > 0, 'ready native session');
  ctl('type "QA_COPY_FIXTURE"'); ctl('key Enter');
  await wait(() => tree('[data-role="omp.assistant"] .sf-md').some(n => n.text?.includes('SELECTME')), 'copy fixture reply');
  const paragraph = tree('[data-role="omp.assistant"] .sf-md p')[0]; assert.ok(paragraph);
  const [x,y,,h] = paragraph.rect;
  const select = () => { ctl(`dblclick ${x+72} ${y+h/2}`); };
  select();
  await writeFile(resolve(out, 'selected-state.json'), JSON.stringify(ctl('state'), null, 2));
  // Read selection from the native host API, not the real system clipboard.
  const selection = ctl('carly lua "return cx.session:selection(nil,{max_chars=1000})"');
  await writeFile(resolve(out, 'selection-api.json'), JSON.stringify({ call: selection, state: ctl('state').carly?.last_tool }, null, 2));
  ctl('key Meta+c'); shot('selected-text'); await pastedText('SELECTME', 'shortcut-copy');
  passed.push('native Cmd+C copies exactly SELECTME into the simulated clipboard');
  select(); ctl(`click ${x+72} ${y+h/2} right`);
  const menu = tree('[role="menuitem"]');
  await writeFile(resolve(out, 'context-menu.json'), JSON.stringify(menu, null, 2));
  assert.ok(menu.some(n=>n.text === 'Copy')); assert.ok(menu.some(n=>n.text === 'Copy entire Markdown'));
  shot('copy-menu');
  const pick = text => {
    const item = tree('[role="menuitem"]').find(n=>n.text === text); assert.ok(item, text);
    const [mx,my,mw,mh]=item.rect; ctl(`click ${mx+mw/2} ${my+mh/2}`);
  };
  pick('Copy');
  await pause(400); await pastedText('SELECTME', 'selection-copy');
  passed.push('ordinary right-click Copy uses native pane selection; whole-source copy is explicitly named');
  ctl(`click ${x+72} ${y+h/2} right`); pick('Copy entire Markdown');
  await pastedText(source, 'entire-copy');
  passed.push('explicit Copy entire Markdown retains native whole-source copying');
} catch (error) {
  limitations.push(error.message); try { shot('failed'); await writeFile(resolve(out,'failed-tree.json'),JSON.stringify(ctl('tree'),null,2)); } catch {}
  throw error;
} finally {
  try { ctl('key Control+q'); } catch {} try { ctl('quit'); } catch { server?.kill('SIGTERM'); }
  daemon.kill('SIGTERM'); closeSync(fd); let fixturePids = [];
  try { fixturePids = [...new Set((await readFile(env.QA_RPC_LOG,'utf8')).trim().split('\n').map(s=>JSON.parse(s).pid))]; } catch {}
  const ownedPids = [daemon.pid,server?.pid,...fixturePids].filter(Boolean);
  for(let i=0;i<30&&ownedPids.some(alive);i++) await pause(100);
  for(const pid of ownedPids.filter(alive)) process.kill(pid,'SIGTERM'); await pause(150);
  const remainingPids=ownedPids.filter(alive);
  await writeFile(resolve(out,'results.json'),JSON.stringify({passed,limitations,screenshots,ownedPids,remainingPids,config,control},null,2));
  console.log(`ARTIFACTS ${out}`); assert.deepEqual(remainingPids,[]);
}
