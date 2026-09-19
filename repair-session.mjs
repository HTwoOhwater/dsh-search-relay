#!/usr/bin/env node
/**
 * repair-session.mjs — 修复被「空 tool callId」毒化的 DSH 会话日志。
 *
 * ## 背景
 *
 * 上游 bug（deepseek-harness 讨论 #3269 / #2169 / #1915 / #4385 / #4387 / #4611 …，
 * 社区有数十条同类报告）：`llm-deepseek` 处理流式 tool_call 增量时的守卫写成
 *
 *     if (call.id !== void 0) block.callId = call.id;
 *
 * provider（尤其经过 LiteLLM 之类的网关）在续帧里发**显式空串** `""` 时会覆盖首帧
 * 捕获的真 id，于是 `tool/call` 与 `tool/result` 都以 `callId: ""` 落盘。
 * 加载时的防损坏校验（有意设计，社区共识是不该放宽）要求 callId 非空 →
 * 抛 `message must have tool source` → **整个会话永久无法加载**。
 *
 * 上游已在 0.1.5-rc.2 修复（改成 `acceptIdentity`：首个非空值优先）。本脚本用于
 * 抢救**已经被毒化**的历史会话——只改日志，不碰引擎写入路径。
 *
 * ## 修复内容
 *
 * 把每个空 id 回填成唯一占位 id，并同步四处引用（缺一处都会导致 UI 配对错乱）：
 *   1. `tool-call-chunks` 的 `data.id`
 *   2. `assistant/message` 里 tool-call 块的 `id`
 *   3. `tool/call` 的 `data.callId`
 *   4. `tool/result` 的 `message.source.callId` 与 `message.content[0].toolCallId`
 *
 * 物理格式注意事项（踩过坑）：
 *   - 会话日志是**拼接式 zstd 帧**容器，必须逐帧解码/重压；
 *   - **第一帧必须恰好是 header 一行**，否则 DSH 启动即失败；
 *   - 帧要带 checksum（`ZSTD_c_checksumFlag`）；
 *   - 校验通过才写盘，写前自动备份。
 *
 * ## 用法
 *
 *   node repair-session.mjs --scan                     # 体检所有会话，列出会被拒绝的
 *   node repair-session.mjs <session.jsonl.zstd>       # 预演（不写盘）
 *   node repair-session.mjs <session.jsonl.zstd> --apply
 *   node repair-session.mjs --scan --apply             # 修复所有被毒化的会话
 *   node repair-session.mjs --restore                  # 还原最近一次备份
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const SCOPE = '@deepseek-ai';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const SESSIONS_ROOT = join(DSH_HOME, 'sessions');
const BACKUP_ROOT = join(DSH_HOME, 'session-repair-backup');

const C = process.stdout.isTTY && !process.env.NO_COLOR
	? { ok: '\u001b[32m', warn: '\u001b[33m', err: '\u001b[31m', dim: '\u001b[2m', bold: '\u001b[1m', off: '\u001b[0m' }
	: { ok: '', warn: '', err: '', dim: '', bold: '', off: '' };
const ok = (t) => console.log(`  ${C.ok}✓${C.off} ${t}`);
const warn = (t) => console.log(`  ${C.warn}!${C.off} ${t}`);
const fail = (t) => console.log(`  ${C.err}x${C.off} ${t}`);
const dim = (t) => console.log(`  ${C.dim}${t}${C.off}`);

/* ------------------------------------------------------------ zstd 帧容器 */

function frameStarts(buf) {
	const starts = [];
	for (let i = 0; i + 4 <= buf.length; i++) if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) starts.push(i);
	if (starts.length === 0 || starts[0] !== 0) starts.unshift(0);
	return starts;
}

/** 逐帧解码，保持原始帧边界（比合并成两帧更保守）。 */
function decodeFrames(buf) {
	const starts = frameStarts(buf);
	const frames = [];
	const notes = [];
	let k = 0;
	while (k < starts.length) {
		let j = k + 1;
		let done = false;
		while (j <= starts.length) {
			const end = j < starts.length ? starts[j] : buf.length;
			try { frames.push(zstdDecompressSync(buf.subarray(starts[k], end))); done = true; break; } catch { j++; }
		}
		if (!done) {
			notes.push(`末帧不完整（撕裂）：byte ${starts[k]} 起 ${buf.length - starts[k]} 字节，按 DSH 语义丢弃`);
			break;
		}
		k = j;
	}
	return { frames, notes };
}

/* -------------------------------------------- 校验（镜像 dsh-session 的规则） */

const hasProviderModel = (v) => typeof v === 'object' && v !== null && typeof v.provider === 'string' && v.provider.length > 0 && typeof v.model === 'string' && v.model.length > 0;

/** 镜像 dsh-session 的 assertMessageEventShape —— 加载时真正会跑的那套规则。 */
function checkEvent(ev) {
	const problems = [];
	const type = ev.type;
	const data = typeof ev.data === 'object' && ev.data !== null ? ev.data : undefined;
	if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result') return problems;
	const message = type === 'user/message' ? data : data?.message;
	if (typeof message !== 'object' || message === null || typeof message.id !== 'string' || message.id === '') { problems.push('lacks an identified message'); return problems; }
	const expectedRole = type === 'assistant/message' ? 'assistant' : 'user';
	if (message.role !== expectedRole) problems.push(`role must be "${expectedRole}"`);
	const source = message.source;
	if (typeof source !== 'object' || source === null || typeof source.kind !== 'string' || source.kind === '') problems.push('invalid source');
	if (!Array.isArray(message.content)) problems.push('invalid content');
	if (type === 'assistant/message') {
		if (source?.kind !== 'model' || !hasProviderModel(source)) problems.push('must have model source');
		return problems;
	}
	if (type !== 'tool/result') return problems;
	if (source?.kind !== 'tool' || typeof source.callId !== 'string' || source.callId === '') problems.push('must have tool source');
	const block = Array.isArray(message.content) ? message.content[0] : undefined;
	if (!Array.isArray(message.content) || message.content.length !== 1 || typeof block !== 'object' || block === null || block.type !== 'tool-result' || !Array.isArray(block.content)) problems.push('must contain one tool-result block');
	else if (block.toolCallId !== source.callId) problems.push('mismatched tool call ids');
	return problems;
}

/* ------------------------------------------------------------ 探测 DSH */

function findDshSessionModule(explicit) {
	const tryExec = (cmd, a) => { try { return execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
	const candidates = [];
	if (explicit) candidates.push(resolve(explicit));
	const exe = tryExec(process.platform === 'win32' ? 'where' : 'which', ['dsh']);
	if (exe) {
		let real = exe.split(/\r?\n/)[0].trim();
		try { real = realpathSync(real); } catch { /* 保持原样 */ }
		const marker = `${process.platform === 'win32' ? '\\' : '/'}${SCOPE}${process.platform === 'win32' ? '\\' : '/'}dsh`;
		const i = real.indexOf(marker);
		if (i >= 0) candidates.push(real.slice(0, i + marker.length));
	}
	const root = tryExec(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g']);
	if (root) candidates.push(join(root, SCOPE, 'dsh'));
	const home = homedir();
	if (process.platform === 'win32') {
		candidates.push(join(home, 'scoop', 'persist', 'nodejs', 'bin', 'node_modules', SCOPE, 'dsh'));
		candidates.push(join(home, 'scoop', 'apps', 'nodejs', 'current', 'bin', 'node_modules', SCOPE, 'dsh'));
	} else {
		candidates.push('/usr/local/lib/node_modules', '/usr/lib/node_modules');
		candidates.push(join(home, '.npm-global', 'lib', 'node_modules', SCOPE, 'dsh'));
	}
	for (const dir of candidates) {
		for (const mod of [join(dir, 'node_modules', SCOPE, 'dsh-session', 'lib', 'index.js'), join(dir, '..', 'dsh-session', 'lib', 'index.js')]) {
			if (existsSync(mod)) return mod;
		}
	}
	return null;
}

/* ------------------------------------------------------------ 体检 */

function walkLogs(dir) {
	const out = [];
	if (!existsSync(dir)) return out;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, e.name);
		if (e.isDirectory()) out.push(...walkLogs(full));
		else if (e.isFile() && (e.name.endsWith('.jsonl.zstd') || e.name.endsWith('.jsonl'))) out.push(full);
	}
	return out;
}

function inspect(file) {
	const buf = readFileSync(file);
	if (file.endsWith('.jsonl')) {
		const text = buf.toString('utf8');
		const lines = text.split('\n').filter((l) => l.trim());
		return { file, frames: 1, records: lines.length, text, lines, notes: [] };
	}
	const { frames, notes } = decodeFrames(buf);
	const lines = frames.flatMap((f) => f.toString('utf8').split('\n').filter((l) => l.length > 0));
	return { file, frames: frames.length, records: lines.length, lines, notes };
}

function countEmpty(parsedRecords) {
	let emptyResults = 0, emptyCalls = 0, emptyBlocks = 0, emptyChunks = 0;
	for (const ev of parsedRecords) {
		if (ev.type === 'tool/result' && ev.data?.message?.source?.callId === '') emptyResults++;
		if (ev.type === 'tool/call' && ev.data?.callId === '') emptyCalls++;
		if (ev.type === 'assistant/message') for (const b of (ev.data?.message?.content ?? [])) if (b.type === 'tool-call' && b.id === '') emptyBlocks++;
		if (ev.type === 'tool-call-chunks' && ev.data?.id === '') emptyChunks++;
	}
	return { emptyResults, emptyCalls, emptyBlocks, emptyChunks };
}

function scan() {
	const logs = walkLogs(SESSIONS_ROOT);
	if (logs.length === 0) { fail(`没有找到会话日志：${SESSIONS_ROOT}`); return []; }
	console.log(`${C.bold}会话体检${C.off}  (${SESSIONS_ROOT})`);
	console.log(`共 ${logs.length} 个日志\n`);
	const broken = [];
	for (const file of logs.sort()) {
		let info;
		try { info = inspect(file); } catch (error) { fail(`${file}: ${error.message}`); continue; }
		const parsed = info.lines.map((l) => JSON.parse(l));
		const e = countEmpty(parsed);
		const bad = e.emptyResults > 0;
		const rel = file.slice(SESSIONS_ROOT.length + 1);
		if (bad) {
			broken.push({ file, ...e });
			console.log(`  ${C.err}✗${C.off} 空 callId 结果 ${e.emptyResults} / 调用 ${e.emptyCalls} / 块 ${e.emptyBlocks} / chunk ${e.emptyChunks}  —  ${rel}`);
		} else {
			dim(`✓ ${String(info.records).padStart(6)} 记录  ${rel}`);
		}
	}
	console.log(`\n${broken.length === 0 ? `${C.ok}全部健康${C.off}` : `${C.err}${broken.length} 个会话会被加载校验拒绝${C.off}（用 --scan --apply 修复）`}`);
	return broken;
}

/* ------------------------------------------------------------ 修复 */

async function repairFile(file, { apply, backupDirArg, dshArg }) {
	const original = readFileSync(file);
	const { frames, notes } = decodeFrames(original);
	for (const n of notes) warn(n);
	const frameLines = frames.map((f) => f.toString('utf8').split('\n').filter((l) => l.length > 0));
	if ((frameLines[0] ?? []).length !== 1) { fail(`${file}: 第一帧不是恰好一行 header，格式不符预期，跳过`); return false; }
	const header = JSON.parse(frameLines[0][0]);
	if (header.type !== 'session') { fail(`${file}: 第一行不是 session header，跳过`); return false; }

	const records = [];
	frameLines.forEach((lines, fi) => lines.forEach((text) => records.push({ frame: fi, text, ev: JSON.parse(text) })));

	// 按 step/start 分段（重放会产生同名 turn/step，必须分段配对）
	const segments = [];
	let current = null;
	for (const rec of records) {
		const t = rec.ev.type;
		if (t === 'step/start') { current = { calls: [], results: [], blocks: [], chunks: [], key: `${rec.ev.data?.turn}/${rec.ev.data?.step}` }; segments.push(current); continue; }
		if (!current) continue;
		if (t === 'tool/call' && rec.ev.data?.callId === '') current.calls.push(rec);
		else if (t === 'tool/result' && rec.ev.data?.message?.source?.callId === '') current.results.push(rec);
		else if (t === 'assistant/message') (rec.ev.data?.message?.content ?? []).forEach((b, i) => { if (b.type === 'tool-call' && b.id === '') current.blocks.push({ rec, index: i }); });
		else if (t === 'tool-call-chunks' && rec.ev.data?.id === '') current.chunks.push(rec);
	}
	const affected = segments.filter((s) => s.calls.length || s.results.length || s.blocks.length || s.chunks.length);

	const used = new Set();
	for (const rec of records) if (rec.ev.type === 'tool/call' && rec.ev.data?.callId) used.add(rec.ev.data.callId);
	const makeId = (seed) => { let id = `call_repaired_${seed}`; let n = 1; while (used.has(id)) id = `call_repaired_${seed}_${n++}`; used.add(id); return id; };

	let sites = 0;
	for (const seg of affected) {
		const count = Math.max(seg.calls.length, seg.results.length, seg.blocks.length);
		const groups = new Map();
		for (const rec of seg.chunks) {
			const idx = rec.ev.data.index;
			if (!groups.has(idx)) groups.set(idx, []);
			groups.get(idx).push(rec);
		}
		const chunkGroups = [...groups.values()];
		for (let i = 0; i < count; i++) {
			const id = makeId(seg.calls[i]?.ev.seq ?? seg.results[i]?.ev.seq ?? seg.blocks[i]?.rec.ev.seq ?? 'x');
			const call = seg.calls[i];
			if (call) { call.ev.data.callId = id; call.text = JSON.stringify(call.ev); sites++; }
			const result = seg.results[i];
			if (result) { result.ev.data.message.source.callId = id; result.ev.data.message.content[0].toolCallId = id; result.text = JSON.stringify(result.ev); sites += 2; }
			const block = seg.blocks[i];
			if (block) { block.rec.ev.data.message.content[block.index].id = id; block.rec.text = JSON.stringify(block.rec.ev); sites++; }
			for (const rec of (chunkGroups[i] ?? [])) { rec.ev.data.id = id; rec.text = JSON.stringify(rec.ev); sites++; }
		}
		for (let i = count; i < chunkGroups.length; i++) {
			const id = makeId(`extra_${seg.key}_${i}`);
			for (const rec of chunkGroups[i]) { rec.ev.data.id = id; rec.text = JSON.stringify(rec.ev); sites++; }
		}
	}

	if (sites === 0) { ok(`${basename(dirname(file))}：无需修复（没有空 callId）`); return true; }

	const events = records.map((r) => r.ev);
	const problems = events.reduce((n, ev) => n + (checkEvent(ev).length ? 1 : 0), 0);

	// 可选：用 DSH 自己的解码器验证逻辑事件流连续（seed 校验要求 seq === index）。
	// 第一行是 header（进 meta，不进 seed），要跳过。
	let contiguity = null;
	const sessionModule = findDshSessionModule(dshArg);
	if (sessionModule) {
		try {
			const mod = await import(pathToFileURL(sessionModule).href);
			const logical = [];
			for (const r of records.slice(1)) logical.push(...mod.decodeStorageRecord(r.ev));
			const firstBad = logical.findIndex((e, i) => e.seq !== i);
			contiguity = firstBad < 0 ? true : `下标 ${firstBad} 的 seq 是 ${logical[firstBad].seq}`;
		} catch { contiguity = null; }
	}

	// 用打过补丁的 records 重建帧
	const groups = [];
	for (const rec of records) { (groups[rec.frame] ??= []).push(rec.text); }
	const outFrames = groups.map((lines) => zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'), CHECKSUM_OPTIONS));
	const rebuilt = Buffer.concat(outFrames);

	// 先校验重建缓冲，再动磁盘
	const check = decodeFrames(rebuilt);
	const firstOk = (check.frames[0] ?? Buffer.alloc(0)).toString('utf8').split('\n').filter((l) => l).length === 1;
	const reProblems = check.frames.flatMap((f) => f.toString('utf8').split('\n').filter((l) => l)).reduce((n, l) => n + (checkEvent(JSON.parse(l)).length ? 1 : 0), 0);

	const label = basename(dirname(file));
	console.log(`\n  ${C.bold}${label}${C.off}  空 id: 结果 ${affected.reduce((n, s) => n + s.results.length, 0)} / 调用 ${affected.reduce((n, s) => n + s.calls.length, 0)} / 块 ${affected.reduce((n, s) => n + s.blocks.length, 0)} / chunk ${affected.reduce((n, s) => n + s.chunks.length, 0)}`);
	console.log(`  回填 ${sites} 处；校验: 原事件 ${problems} 个不合规，重建后 ${reProblems} 个不合规，第一帧单行 header: ${firstOk ? '是' : '否'}`);
	if (contiguity !== null) console.log(`  逻辑事件流 seq 从 0 连续: ${contiguity === true ? '是' : `否（${contiguity}）`}`);

	if (problems > 0 || reProblems > 0 || !firstOk || contiguity === false) { fail('校验未通过，拒绝写入'); return false; }
	if (contiguity !== true) dim('（未能加载 dsh-session 做 seq 连续性校验，已跳过该项；可用 --dsh <目录> 指定）');
	if (!apply) { dim('（预演模式，未写盘。加 --apply 执行）'); return true; }

	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const backupDir = backupDirArg ?? join(BACKUP_ROOT, stamp);
	mkdirSync(backupDir, { recursive: true });
	const backupPath = join(backupDir, basename(file));
	copyFileSync(file, backupPath);
	writeFileSync(file, rebuilt);
	const disk = decodeFrames(readFileSync(file));
	const diskProblems = disk.frames.flatMap((f) => f.toString('utf8').split('\n').filter((l) => l)).reduce((n, l) => n + (checkEvent(JSON.parse(l)).length ? 1 : 0), 0);
	ok(`已修复（${original.length} → ${rebuilt.length} 字节，${outFrames.length} 帧，磁盘回读不合规 ${diskProblems}）`);
	dim(`原文件备份：${backupPath}`);
	return diskProblems === 0;
}

function restore() {
	const dirs = existsSync(BACKUP_ROOT)
		? readdirSync(BACKUP_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(BACKUP_ROOT, e.name)).sort()
		: [];
	const dir = dirs.at(-1);
	if (!dir) { fail('找不到备份'); process.exit(1); }
	console.log(`${C.bold}从备份还原${C.off}  ${dir}`);
	for (const name of readdirSync(dir)) {
		const backupPath = join(dir, name);
		if (!statSync(backupPath).isFile()) continue;
		// 备份是「日志文件名」，需要在 sessions 树里找到同名日志
		const matches = walkLogs(SESSIONS_ROOT).filter((f) => basename(f) === name);
		if (matches.length === 0) { warn(`找不到对应日志：${name}`); continue; }
		for (const target of matches) { copyFileSync(backupPath, target); ok(`已还原 ${target}`); }
	}
}

/* ------------------------------------------------------------------ CLI */

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--backup-dir', '--dsh']);
const flags = new Set();
const positionals = [];
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (VALUE_FLAGS.has(a)) { i++; continue; }
	if (a.startsWith('--')) { flags.add(a); continue; }
	positionals.push(a);
}
const apply = flags.has('--apply');
const doScan = flags.has('--scan');
const doRestore = flags.has('--restore');
const backupDirArg = args.includes('--backup-dir') ? args[args.indexOf('--backup-dir') + 1] : null;
const dshArg = args.includes('--dsh') ? args[args.indexOf('--dsh') + 1] : null;
const file = positionals[0];

if (doRestore) { restore(); process.exit(0); }
if (doScan) {
	const broken = scan();
	if (!apply) process.exit(broken.length === 0 ? 0 : 1);
	if (broken.length === 0) process.exit(0);
	console.log(`\n${C.bold}开始修复${C.off}`);
	let allOk = true;
	for (const b of broken) if (!await repairFile(b.file, { apply: true, backupDirArg, dshArg })) allOk = false;
	console.log(`\n${allOk ? `${C.ok}全部修复完成${C.off}，重启 dsh web 后这些会话应能正常打开` : `${C.err}部分失败${C.off}，请检查上面的输出`}`);
	process.exit(allOk ? 0 : 1);
}
if (!file) {
	console.log('用法：');
	console.log('  node repair-session.mjs --scan                 # 体检所有会话');
	console.log('  node repair-session.mjs <session.jsonl.zstd>   # 预演修复');
	console.log('  node repair-session.mjs <session.jsonl.zstd> --apply');
	console.log('  node repair-session.mjs --scan --apply         # 修复所有被毒化的会话');
	console.log('  node repair-session.mjs --restore              # 还原最近一次备份');
	console.log('  可选：--dsh <DSH 安装目录>  --backup-dir <备份目录>');
	process.exit(2);
}
process.exit(await repairFile(resolve(file), { apply, backupDirArg, dshArg }) ? 0 : 1);
