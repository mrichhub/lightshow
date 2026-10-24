import { defineConfig } from "@playwright/test"

export default defineConfig({
	testDir: "tests/browser",
	timeout: 30000,
	workers: 1,
	use: {
		channel: "chrome",
		baseURL: process.env.PUBLIC_ORIGIN ?? "https://lightshow.home.arpa",
		viewport: { width: 1440, height: 1000 },
		launchOptions: {
			args: [
				`--ignore-certificate-errors-spki-list=${process.env.LIGHTSHOW_TEST_SPKI ?? ""}`,
				"--host-resolver-rules=MAP lightshow.home.arpa 127.0.0.1",
			],
		},
	},
	reporter: "list",
})
