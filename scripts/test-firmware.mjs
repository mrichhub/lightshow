import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"

const binary = join(tmpdir(), "lightshow-firmware-ddp-test")

for (const [command, args] of [
	[
		process.env.CXX ?? "c++",
		["-std=c++17", "-Wall", "-Wextra", "-Werror", "tests/firmware-ddp.cpp", "-o", binary],
	],
	[binary, []],
]) {
	const result = spawnSync(command, args, { stdio: "inherit" })

	if (result.status !== 0) process.exit(result.status ?? 1)
}
