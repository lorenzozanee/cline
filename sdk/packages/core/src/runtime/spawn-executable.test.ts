import { describe, expect, it } from "vitest";
import {
	mergeSpawnEnv,
	resolveSpawnExecutable,
	windowsPowerShellExecutable,
	windowsSystemExecutable,
} from "./spawn-executable";

/**
 * Build a Windows resolver over a fake filesystem so the search runs on any
 * host. `files` lists the paths that exist; `directories` the ones that exist
 * but must be skipped, as libuv skips them.
 */
function windowsResolver(
	files: string[],
	options: {
		cwd?: string;
		path?: string;
		directories?: string[];
		env?: Record<string, string | undefined>;
	} = {},
) {
	const present = new Set(files.map((file) => file.toLowerCase()));
	const directories = new Set(
		(options.directories ?? []).map((directory) => directory.toLowerCase()),
	);
	const probes: string[] = [];
	const resolve = (file: string) =>
		resolveSpawnExecutable(file, {
			platform: "win32",
			cwd: options.cwd ?? "C:\\work\\repo",
			env: options.env ?? {
				Path: options.path ?? "C:\\tools;C:\\Windows\\System32",
			},
			isRunnableFile: (candidate) => {
				probes.push(candidate);
				const key = candidate.toLowerCase();
				return present.has(key) && !directories.has(key);
			},
		});
	return { resolve, probes };
}

describe("resolveSpawnExecutable", () => {
	it("never looks in the working directory for a bare name", () => {
		// The whole point: a powershell.exe planted next to the user's code
		// must not shadow the one on PATH, and must not be found at all when
		// PATH has none.
		const planted = "C:\\work\\repo\\powershell.exe";
		const system = "C:\\Windows\\System32\\powershell.exe";
		const shadowed = windowsResolver([planted, system]);
		expect(shadowed.resolve("powershell")).toBe(system);
		expect(
			shadowed.probes.some((probe) => probe.startsWith("C:\\work\\repo\\")),
		).toBe(false);

		const onlyPlanted = windowsResolver([planted]);
		expect(onlyPlanted.resolve("powershell")).toBeUndefined();
		expect(onlyPlanted.resolve("powershell.exe")).toBeUndefined();
	});

	it("walks PATH in order and takes the first directory that has the program", () => {
		const { resolve } = windowsResolver(
			["C:\\second\\git.exe", "C:\\first\\git.exe"],
			{ path: "C:\\first;C:\\second" },
		);
		expect(resolve("git")).toBe("C:\\first\\git.exe");
	});

	it("tries the name verbatim only when it has an extension, then .com, then .exe", () => {
		const { resolve, probes } = windowsResolver(["C:\\tools\\pwsh.exe"]);
		expect(resolve("pwsh")).toBe("C:\\tools\\pwsh.exe");
		expect(probes.slice(0, 2)).toEqual([
			"C:\\tools\\pwsh.com",
			"C:\\tools\\pwsh.exe",
		]);

		const named = windowsResolver(["C:\\tools\\tool.bat"]);
		// libuv tries the literal name first because it carries an extension,
		// so a .bat named explicitly is found even though PATHEXT is unused.
		expect(named.resolve("tool.bat")).toBe("C:\\tools\\tool.bat");
		expect(named.probes[0]).toBe("C:\\tools\\tool.bat");

		const bat = windowsResolver(["C:\\tools\\npm.cmd"]);
		// ...while a bare `npm` stays unresolvable without shell: true, as today.
		expect(bat.resolve("npm")).toBeUndefined();

		const com = windowsResolver(["C:\\tools\\more.com", "C:\\tools\\more.exe"]);
		expect(com.resolve("more")).toBe("C:\\tools\\more.com");

		const trailingDot = windowsResolver(["C:\\tools\\odd.exe"]);
		expect(trailingDot.resolve("odd.")).toBe("C:\\tools\\odd.exe");
	});

	it("reads PATH case-insensitively and tolerates quoted, empty and relative entries", () => {
		const { resolve } = windowsResolver(
			["C:\\Program Files\\Tool\\tool.exe", "C:\\work\\repo\\bin\\local.exe"],
			{
				env: {
					PATH: ';"C:\\Program Files\\Tool";;bin;',
				},
			},
		);
		expect(resolve("tool")).toBe("C:\\Program Files\\Tool\\tool.exe");
		// A relative PATH entry is the user's own configuration and resolves
		// against the child's cwd, as libuv and PowerShell both do.
		expect(resolve("local")).toBe("C:\\work\\repo\\bin\\local.exe");
	});

	it("skips directories that happen to carry the program name", () => {
		const { resolve } = windowsResolver(
			["C:\\tools\\pwsh.exe", "C:\\Windows\\System32\\pwsh.exe"],
			{ directories: ["C:\\tools\\pwsh.exe"] },
		);
		expect(resolve("pwsh")).toBe("C:\\Windows\\System32\\pwsh.exe");
	});

	it("leaves names with a directory or drive component for libuv to resolve", () => {
		const { resolve, probes } = windowsResolver([]);
		for (const explicit of [
			".\\pwsh.exe",
			"..\\pwsh.exe",
			"sub/pwsh.exe",
			"C:\\Program Files\\PowerShell\\7\\pwsh.exe",
			"C:pwsh.exe",
			"\\\\server\\share\\pwsh.exe",
		]) {
			expect(resolve(explicit)).toBe(explicit);
		}
		expect(probes).toEqual([]);
	});

	it("returns undefined for an empty or dot name and when PATH is missing", () => {
		const { resolve } = windowsResolver(["C:\\tools\\pwsh.exe"]);
		expect(resolve("")).toBeUndefined();
		expect(resolve(".")).toBeUndefined();
		expect(
			resolveSpawnExecutable("pwsh", {
				platform: "win32",
				cwd: "C:\\work",
				env: {},
				isRunnableFile: () => true,
			}),
		).toBeUndefined();
	});

	it("is a no-op on other platforms", () => {
		for (const platform of ["darwin", "linux"] as const) {
			expect(
				resolveSpawnExecutable("pwsh", {
					platform,
					env: { PATH: "/usr/bin" },
					isRunnableFile: () => {
						throw new Error("must not probe");
					},
				}),
			).toBe("pwsh");
		}
	});
});

describe("windowsSystemExecutable", () => {
	it("builds the System32 path from SystemRoot, windir, or the default root", () => {
		expect(
			windowsSystemExecutable("taskkill.exe", { SYSTEMROOT: "D:\\Win" }),
		).toBe("D:\\Win\\System32\\taskkill.exe");
		expect(windowsSystemExecutable("taskkill.exe", { windir: "E:\\W" })).toBe(
			"E:\\W\\System32\\taskkill.exe",
		);
		expect(windowsSystemExecutable("taskkill.exe", {})).toBe(
			"C:\\Windows\\System32\\taskkill.exe",
		);
	});
});

describe("windowsPowerShellExecutable", () => {
	it("points at Windows PowerShell's own directory, not System32 itself", () => {
		expect(windowsPowerShellExecutable({})).toBe(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		);
		expect(windowsPowerShellExecutable({ SystemRoot: "D:\\Win" })).toBe(
			"D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		);
	});
});

describe("mergeSpawnEnv", () => {
	it("lets an override replace an inherited variable of any case on Windows", () => {
		const merged = mergeSpawnEnv(
			{ Path: "C:\\inherited", HOME: "C:\\Users\\a" },
			{ PATH: "C:\\override" },
			"win32",
		);
		expect(merged).toEqual({ HOME: "C:\\Users\\a", PATH: "C:\\override" });
		// ...and the resolver then searches the override, not the inherited PATH.
		expect(
			resolveSpawnExecutable("tool", {
				platform: "win32",
				cwd: "C:\\work",
				env: merged,
				isRunnableFile: (path) => path === "C:\\override\\tool.exe",
			}),
		).toBe("C:\\override\\tool.exe");
	});

	it("keeps case-variant names distinct on POSIX and behaves like a spread otherwise", () => {
		expect(
			mergeSpawnEnv({ Path: "/inherited" }, { PATH: "/override" }, "linux"),
		).toEqual({ Path: "/inherited", PATH: "/override" });
		expect(mergeSpawnEnv({ A: "1" }, undefined, "win32")).toEqual({ A: "1" });
		expect(mergeSpawnEnv({ A: "1" }, { A: "2", B: "3" }, "win32")).toEqual({
			A: "2",
			B: "3",
		});
	});
});
