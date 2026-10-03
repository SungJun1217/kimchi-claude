import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAbsolute } from 'node:path';

const root = process.argv[4];
const plugin = process.argv[3];
const prompts = JSON.parse(readFileSync(new URL('./prompts.json', import.meta.url), 'utf8'));
const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) throw new Error('before 또는 after를 지정해야 한다');
if (!root || !plugin || !isAbsolute(root) || !isAbsolute(plugin)) {
  throw new Error('플러그인 절대 경로와 출력 절대 경로를 지정해야 한다');
}
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'prompts.json'), JSON.stringify(prompts, null, 2));
writeFileSync(join(root, `${phase}-style.md`), readFileSync(join(plugin, 'output-styles/natural-korean.md')));
async function run(id, prompt) {
  const name = `${phase}-${id}`;
  const cwd = join(root, name);
  mkdirSync(cwd);
  const args = ['-p', '--model', 'sonnet', '--effort', 'high', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', '', '--settings', '{"enabledPlugins":{}}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--plugin-dir', plugin, '--debug-file', join(root, `${name}.debug.log`)];
  const child = spawn('claude', args, { cwd, env: { ...process.env, CLAUDECODE: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', data => out += data);
  child.stderr.on('data', data => err += data);
  child.stdin.end(prompt);
  const timer = setTimeout(() => child.kill('SIGTERM'), 240000);
  const code = await new Promise(resolve => child.on('close', resolve));
  clearTimeout(timer);
  writeFileSync(join(root, `${name}.jsonl`), out);
  writeFileSync(join(root, `${name}.stderr`), err);
  const events = out.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const init = events.find(e => e.type === 'system' && e.subtype === 'init');
  const result = events.find(e => e.type === 'result');
  if (code !== 0 || !result || result.is_error) throw new Error(`${name}: ${code} ${result?.subtype} ${err}`);
  writeFileSync(join(root, `${name}.md`), result.result);
  const meta = { name, model: init.model, modelUsage: result.modelUsage, plugins: init.plugins, cost: result.total_cost_usd, chars: result.result.length, args, prompt };
  writeFileSync(join(root, `${name}.meta.json`), JSON.stringify(meta, null, 2));
  console.log(JSON.stringify({ name, model: meta.model, chars: meta.chars, cost: meta.cost }));
}
await Promise.all(Object.entries(prompts).map(([id, prompt]) => run(id, prompt)));
