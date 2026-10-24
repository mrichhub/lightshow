import { test, expect } from "@playwright/test"
import { readFile } from "node:fs/promises"

test("administrator can use the realtime dashboard and every management page", async ({ page }) => {
	const errors: string[] = []

	page.on("pageerror", (e) => errors.push(e.message))
	await page.goto("/")
	await expect(page.getByRole("heading", { name: "Lightshow", exact: true })).toBeVisible()

	await page
		.getByLabel("Administrator password")
		.fill((await readFile(".local/admin-password", "utf8")).trim())

	await page.getByRole("button", { name: "Sign in", exact: false }).click()
	await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible()
	await expect(page.locator(".sidebar-footer")).toContainText("Live connection")
	await page.screenshot({ path: ".local/dashboard-desktop.png", fullPage: true })

	for (const name of ["Devices", "Elements", "Scenes", "Lighting debugger", "Access"]) {
		await page.getByRole("navigation").getByRole("button", { name, exact: false }).click()
		await expect(page.getByRole("heading", { name, exact: true })).toBeVisible()
	}

	await expect(page.getByLabel("Hardware identity")).toHaveValue("sim-yard-1")

	const docs = await page.context().newPage()

	await docs.goto("/v1/docs/")
	await expect(docs.getByRole("heading", { name: /Lightshow API/ })).toBeVisible()
	await docs.close()
	await page.setViewportSize({ width: 390, height: 844 })

	await page
		.getByRole("navigation")
		.getByRole("button", { name: "Dashboard", exact: false })
		.click()

	await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible()
	await page.screenshot({ path: ".local/dashboard-mobile.png", fullPage: true })

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth,
	)

	expect(overflow).toBe(false)
	expect(errors).toEqual([])
})
