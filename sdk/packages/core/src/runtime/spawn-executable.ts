import { lstatSync, statSync } from "node:fs";
import { win32 } from "node:path";

/**
 * Options for {@link resolveSpawnExecutable}. Every field defaults to the
 * current process so production callers pass only `cwd` and `env`; tests
 * inject all four to exercise the Windows search on any host.
 */
export interface ResolveSpawnExecutableOptions {
	platform?: NodeJS.Platform;
	/** The child's working directory. Relative PATH entries resolve against it. */
	cwd?: string;
	/** The environment the child will receive. PATH is read from it case-insensitively. */
	env?: Readonly<Record<string, string | undefined>>;
	/** Existence probe: "exists and is not a directory". Injectable for tests. */
	isRunnableFile?: (path: string) => boolean;
}

/**
 * Resolve the program for a `child_process.spawn` call so the lookup libuv
 * would otherwise perform never consults the working directory.
 *
 * On Windows, libuv resolves a bare program name — no `\`, `/` or `:` — by
 * looking in the child's cwd first and only then walking PATH, unless the
 * spawning process has `NoDefaultCurrentDirectoryInExePath` set. PowerShell
 * itself never does that: a bare name resolves through PATH only, and running
 * something from the current directory takes an explicit `.\`. Handing spawn
 * a bare name therefore lets a `powershell.exe` planted in the workspace
 * shadow the system shell whenever the model writes a bare shell name, and
 * for the CLI's bare `powershell` default shell on every command.
 *
 * This mirrors libuv's search minus the cwd step: PATH entries in order,
 * quoted entries unquoted, empty entries skipped, relative entries resolved
 * against the child's cwd; the name is tried verbatim when it already carries
 * an extension, then with `.com`, then with `.exe`. PATHEXT is deliberately
 * not consulted because libuv does not consult it either, so `.cmd` and
 * `.bat` shims remain unresolvable without `shell: true`, exactly as today.
 *
 * Returns the input unchanged on other platforms and for names that carry a
 * directory or drive component: libuv resolves those against the child's cwd
 * without any search, which is what PowerShell does for `.\x.exe` or
 * `sub\x.exe`. Returns undefined when a bare name is not on PATH; callers must
 * then fail as for a missing program instead of falling back to the bare name.
 */
export function resolveSpawnExecutable(
	file: string,
	options: ResolveSpawnExecutableOptions = {},
): string | undefined {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") return file;
	if (file.length === 0 || file === ".") return undefined;
	if (/[\\/:]/.test(file)) return file;

	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const isRunnableFile = options.isRunnableFile ?? defaultIsRunnableFile;
	const candidates = candidateFileNames(file);
	for (const entry of pathEntries(readEnv(env, "PATH"))) {
		const directory = win32.resolve(cwd, entry);
		for (const candidate of candidates) {
			const fullPath = win32.join(directory, candidate);
			if (isRunnableFile(fullPath)) return fullPath;
		}
	}
	return undefined;
}

/**
 * Absolute path of a tool that ships directly in the Windows system
 * directory, such as `taskkill.exe`. The executor's own helpers use fixed
 * paths rather than bare names so neither the working directory nor a
 * user-modified PATH decides which binary they run.
 */
export function windowsSystemExecutable(
	name: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	return win32.join(windowsSystemRoot(env), "System32", name);
}

/**
 * Absolute path of Windows PowerShell 5.1, which ships under
 * `System32\WindowsPowerShell\v1.0\`, not directly in `System32`.
 */
export function windowsPowerShellExecutable(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	return win32.join(
		windowsSystemRoot(env),
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
}

/**
 * Merge executor-supplied environment overrides onto the inherited
 * environment the way a plain spread would, except that on Windows an
 * override replaces an inherited variable of the same name in any case.
 * Windows environment names are case-insensitive but a spread copy of
 * `process.env` is not, so `{ ...process.env, ...{ PATH } }` on a host whose
 * inherited key is `Path` would keep both — and both {@link
 * resolveSpawnExecutable} and the child would then see the inherited value
 * first, silently ignoring the override.
 */
export function mergeSpawnEnv(
	base: Readonly<Record<string, string | undefined>>,
	overrides: Readonly<Record<string, string | undefined>> | undefined,
	platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
	const merged: Record<string, string | undefined> = { ...base };
	if (!overrides) return merged;
	for (const [key, value] of Object.entries(overrides)) {
		if (platform === "win32") {
			const wanted = key.toLowerCase();
			for (const existing of Object.keys(merged)) {
				if (existing !== key && existing.toLowerCase() === wanted) {
					delete merged[existing];
				}
			}
		}
		merged[key] = value;
	}
	return merged;
}

function windowsSystemRoot(
	env: Readonly<Record<string, string | undefined>>,
): string {
	return readEnv(env, "SystemRoot") ?? readEnv(env, "windir") ?? "C:\\Windows";
}

/** Windows environment names are case-insensitive; a spread copy of process.env is not. */
function readEnv(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
): string | undefined {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(env)) {
		if (key.toLowerCase() === wanted) return value;
	}
	return undefined;
}

/**
 * Split PATH the way libuv does: `;`-separated, an entry may be wrapped in
 * `"` or `'` (in which case a `;` inside the quotes is part of the entry),
 * one leading and one trailing quote are stripped, empty entries are skipped.
 */
function pathEntries(path: string | undefined): string[] {
	if (!path) return [];
	const entries: string[] = [];
	let index = 0;
	while (index < path.length) {
		let end = index;
		const quote = path[index];
		if (quote === '"' || quote === "'") {
			const closing = path.indexOf(quote, index + 1);
			end = closing === -1 ? path.length : closing + 1;
		}
		const separator = path.indexOf(";", end);
		end = separator === -1 ? path.length : separator;
		let entry = path.slice(index, end);
		if (entry.startsWith('"') || entry.startsWith("'")) entry = entry.slice(1);
		if (entry.endsWith('"') || entry.endsWith("'")) entry = entry.slice(0, -1);
		if (entry.length > 0) entries.push(entry);
		index = end + 1;
	}
	return entries;
}

/**
 * The file names libuv tries for a bare program name, in order: the name as
 * written when it already has a non-empty extension, then `.com`, then
 * `.exe`. A trailing dot on the name is not doubled.
 */
function candidateFileNames(file: string): string[] {
	const dot = file.indexOf(".");
	const hasExtension = dot !== -1 && dot < file.length - 1;
	const withExtension = (extension: string) =>
		file.endsWith(".") ? `${file}${extension}` : `${file}.${extension}`;
	return [
		...(hasExtension ? [file] : []),
		withExtension("com"),
		withExtension("exe"),
	];
}

/**
 * Mirror GetFileAttributesW: the entry exists and is not a directory. stat
 * follows links and app-execution aliases; when following fails, lstat still
 * counts a present reparse point as runnable, as libuv would.
 */
function defaultIsRunnableFile(path: string): boolean {
	try {
		const followed = statSync(path, { throwIfNoEntry: false });
		if (followed) return !followed.isDirectory();
	} catch {
		// Fall through to lstat.
	}
	try {
		return !lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}
