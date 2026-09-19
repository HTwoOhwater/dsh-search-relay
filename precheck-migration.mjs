#!/usr/bin/env node
/**
 * precheck-migration.mjs — 升级到会做 v0→v3 迁移的 DSH（0.1.5-rc.2+）之前，
 * 离线预检旧会话是否会在迁移后**投影失败**。
 *
 * ## 背景
 *
 * 新版把会话日志格式从 v0 迁到 v3（写成新的 `session.v3.jsonl.zstd`，原文件保留）。
 * 但社区报告（讨论 #6686）指出：迁移后若某些事件缺 `data.message`，三个官方投影会
 * 无保护地读取而抛
 *
 *     failed to project session "session-…": Cannot read properties of undefined (reading 'content')
 *
 * 该问题在 0.1.5-rc.2 及 master 上**仍未修**（社区已确认两个文件字节相同）。
 * 它不是"每个迁移过的会话都出问题"——取决于具体 v0 内容。所以升级前值得先查一下。
 *
 * ## 本脚本检查的两种触发形状
 *
 *   ① 类型暗示应带 message 体、但 `data.message` 缺失或不是对象的事件
 *      （`assistant/message` / `tool/result` / `system/message`）
 *   ② `surfaceOp` 是 replace 形状、但其引用的位置在日志里解析不到
 *
 * 两者都为 0 → 迁移不会产生残缺事件，升级后投影无风险。
 *
 * 用法：
 *   node precheck-migration.mjs              # 检查 $DSH_HOME/sessions（默认 ~/.dsh/sessions）
 *   node precheck-migration.mjs --dir <目录>
 */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MESSAGE_TYPES = new Set(['assistant/message', 'tool/result', 'system/message']);
const args = process.argv.slice(2);
const dirArg = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : null;
const ROOT = dirArg ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');

/** 解码拼接式 zstd 帧容器（保持帧边界）。 */
function decodeAll(buf) {
	const starts = [];
	for (let i = 0; i + 4 <= buf.length; i++) if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) starts.push(i);
	if (starts.length === 0 || starts[0] !== 0) starts.unshift(0);
	const parts = [];
	let k = 0;
	while (k < starts.length) {
		let j = k + 1;
		let done = false;
		while (j <= starts.length) {
			const end = j < starts.length ? starts[j] : buf.length;
			try { parts.push(zstdDecompressSync(buf.subarray(starts[k], end))); done = true; break; } catch { j++; }
		}
		if (!done) break;
		k = j;
	}
	return Buffer.concat(parts).toString('utf8');
}

function walk(dir) {
	const out = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(full));
		else if (e.isFile() && (e.name.endsWith('.jsonl.zstd') || e.name.endsWith('.jsonl'))) out.push(full);
	}
	return out;
}

const logs = walk(ROOT);
if (logs.length === 0) { console.error(`没有找到会话日志：${ROOT}`); process.exit(1); }

let underFilledTotal = 0;
let badSurfaceTotal = 0;
let eventsTotal = 0;
const versions = new Map();

console.log(`预检目录: ${ROOT}\n共 ${logs.length} 个日志\n`);

for (const file of logs.sort()) {
	const text = file.endsWith('.jsonl') ? readFileSync(file, 'utf8') : decodeAll(readFileSync(file));
	const events = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try { events.push(JSON.parse(line)); } catch { /* 跳过无法解析的行 */ }
	}
	const header = events[0];
	const rest = events.slice(1);
	eventsTotal += rest.length;
	versions.set(header?.version, (versions.get(header?.version) ?? 0) + 1);

	// ① 类型暗示有 message 体、但 data.message 缺失
	const underFilled = rest.filter((ev) => MESSAGE_TYPES.has(ev.type) && (typeof ev.data?.message !== 'object' || ev.data?.message === null));

	// ② replace 形状的 surfaceOp 引用解析不到位置
	const seqs = new Set(rest.map((ev) => ev.seq).filter((s) => typeof s === 'number'));
	const badSurface = rest.filter((ev) => {
		if (ev.surfaceOp === undefined || ev.surfaceOp === 'append') return false;
		const op = typeof ev.surfaceOp === 'object' ? ev.surfaceOp : null;
		const start = op?.start ?? op?.startSeq;
		const end = op?.end ?? op?.endSeq;
		if (start === undefined && end === undefined) return true;
		return (start !== undefined && !seqs.has(start)) || (end !== undefined && !seqs.has(end));
	});

	underFilledTotal += underFilled.length;
	badSurfaceTotal += badSurface.length;

	const rel = file.slice(ROOT.length + 1);
	if (underFilled.length === 0 && badSurface.length === 0) {
		console.log(`  ✓  v${header?.version ?? '?'}  ${String(rest.length).padStart(6)} 事件  ${rel}`);
		continue;
	}
	console.log(`  ✗  v${header?.version ?? '?'}  ${String(rest.length).padStart(6)} 事件  ${rel}`);
	console.log(`       残缺 message 体 ${underFilled.length} 个，可疑 surfaceOp ${badSurface.length} 个`);
	for (const ev of underFilled.slice(0, 3)) console.log(`         seq=${ev.seq} type=${ev.type} data 字段=[${Object.keys(ev.data ?? {}).join(',')}]`);
	for (const ev of badSurface.slice(0, 3)) console.log(`         seq=${ev.seq} surfaceOp=${JSON.stringify(ev.surfaceOp).slice(0, 90)}`);
}

console.log(`\n=== 结果 ===`);
console.log(`会话 ${logs.length} 个，事件 ${eventsTotal} 个，格式版本分布 ${JSON.stringify(Object.fromEntries(versions))}`);
console.log(`形状 ①（残缺 message 体）: ${underFilledTotal}`);
console.log(`形状 ②（可疑 surfaceOp）:   ${badSurfaceTotal}`);
if (underFilledTotal === 0 && badSurfaceTotal === 0) {
	console.log('\n结论: 不存在 #6686 的触发形状 → 升级后的 v0→v3 迁移不会产生残缺事件，投影应正常。');
	process.exit(0);
}
console.log('\n结论: 存在触发形状 → 升级后这些会话可能投影失败。建议先整体备份 ~/.dsh/sessions 再升级；');
console.log('      原 v0 文件在迁移后会保留，因此即使投影失败数据也没丢（等上游修 #6686 或临时用 dsh-doctor 定位）。');
process.exit(1);
